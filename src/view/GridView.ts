import {
	ItemView,
	Notice,
	Platform,
	type HoverPopover,
	Scope,
	TFile,
	normalizePath,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { colName } from "../model/address";
import { density, filledCount, getRaw, recomputeUsedRange, setRaw, shrinkToData, type Align, type GridModel } from "../model/GridModel";
import { formatCompact, formatNumber } from "../model/numbers";
import { resolveTouchLayout, type StatusStat } from "../settings";
import { parseTable } from "../model/parse";
import { serializeTable } from "../model/serialize";
import { anchorFromRegion, anchorKey, newBlockId, resolveAnchor, type Anchor } from "../file/AnchorResolver";
import { regionHash, Writer } from "../file/Writer";
import type { TableRegion } from "../file/scanTables";
import { defaultLayout, type TableLayout } from "../store/Sidecar";
import { aggregate, applyFunction, formatResult, summaryLine, type CalcFunction } from "../feature/QuickCalc";
import { csvBytes, plainText, type CsvOptions } from "../feature/exportCsv";
import { toHtmlTable, toJson } from "../feature/exportExtra";
import { computeColumn, totalsRow } from "../feature/formula";
import { readTableFile } from "../feature/tableFile";
import { applyMerge, planMerge } from "../feature/merge";
import {
	columnStats,
	duplicateHeaders,
	formatNumbers,
	mergeColumns,
	raggedRows,
	removeDuplicateRows,
	sortRowsMulti,
	textToColumns,
	transpose,
	type TextTransform,
} from "../feature/transform";
import { fromMarkdownTable, fromTsv, looksLikeGrid } from "../feature/clipboard";
import { scanTables } from "../file/scanTables";
import { diffLines } from "../feature/diff";
import { DEFAULT_XLSX_OPTIONS, xlsxBuffer } from "../feature/exportXlsx";
import { fillRange, findAll, normalizeRect, rectCols, rectRows, replaceAll, type FindOptions } from "../feature/ops";
import type MarkdownSpreadsheetsPlugin from "../main";
import { asElement, asNode } from "./dom";
import { MAX_COL_WIDTH, MAX_ROW_HEIGHT, MIN_COL_WIDTH, MIN_ROW_HEIGHT, VIEW_TYPE_GRID } from "./constants";
import { GridHost, type Selection } from "./GridHost";
import { formatNow } from "./GridHost";
import { iconName, setIconSafe, type IconKey } from "./icons";
import { ColumnsModal, ColumnStatsModal, ComputeColumnModal, GoToModal, ImportModal, MergeModal, MultiSortModal, NumberFormatModal, TextPromptModal, TotalsModal } from "./toolModals";
import { Menu } from "obsidian";
import { colIndex } from "../model/address";
import { Ribbon, type RibbonAction, type RibbonItem, type RibbonTab } from "./Ribbon";
import { StatusBar } from "./StatusBar";
import { TouchBar, type TouchAction } from "./TouchBar";
import {
	CalculateModal,
	ConfirmModal,
	DensityModal,
	DiffModal,
	ExportModal,
	FilterModal,
	FindReplaceModal,
	RestoreModal,
	TablePickerModal,
} from "./modals";

export interface GridViewState {
	path?: string;
	anchor?: Anchor;
}

type BannerAction = { label: string; cta?: boolean; warning?: boolean; onClick(): void };

/**
 * The grid tab.
 *
 * Owns the read → edit → write cycle for exactly one table region. While it is open it is the
 * editor of that region (§13.2): there is no live two-way sync with the note, so every change
 * flows one way, through `Writer`.
 */
export class GridView extends ItemView {
	private host: GridHost | null = null;
	private readonly ribbon: Ribbon;
	private readonly statusBar = new StatusBar();
	private readonly writer: Writer;
	/** The touch layout (decision 24), fixed for the life of the tab. */
	private readonly touch: boolean;
	private readonly touchBar = new TouchBar();

	private bodyEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private formulaAddressEl!: HTMLElement;
	private formulaInputEl!: HTMLInputElement;

	private file: TFile | null = null;
	private anchor: Anchor | null = null;
	private layoutKey = "";
	/** Hash of the region as the grid last agreed with the note (§13.1). */
	private expectedHash = "";
	private dirty = false;
	private saveTimer: number | null = null;
	private writing = false;
	private conflictShown = false;
	private lastCalc: { fn: CalcFunction; text: string } | null = null;
	/** Obsidian's page preview attaches its popover here (`HoverParent`). */
	hoverPopover: HoverPopover | null = null;
	/** The region text as the note last had it, for the save preview. */
	private noteRegionText = "";
	private tableSwitchEl!: HTMLSelectElement;
	/** The cell the formula bar is editing, set on the first keystroke there. */
	private formulaTarget: { row: number; col: number } | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: MarkdownSpreadsheetsPlugin,
	) {
		super(leaf);
		this.writer = new Writer(this.app.vault);
		this.touch = resolveTouchLayout(plugin.sidecar.settings.mobileLayout, Platform.isMobile);
		this.ribbon = new Ribbon({
			onTabChange: () => this.refreshRibbon(),
			collapsed: plugin.sidecar.settings.ribbonCollapsed,
			iconsOnly: plugin.sidecar.settings.ribbonStyle === "icons",
			touch: this.touch,
			onCollapseChange: (collapsed) => {
				plugin.sidecar.settings.ribbonCollapsed = collapsed;
				plugin.sidecar.queueSave();
			},
		});
		this.navigation = true;
		// Hotkeys live in a view scope, not in commands with default bindings (§10, §15.2).
		this.scope = new Scope(this.app.scope);
		this.registerScope();
	}

	override getViewType(): string {
		return VIEW_TYPE_GRID;
	}

	override getIcon(): string {
		return "table";
	}

	override getDisplayText(): string {
		if (!this.file) return "Spreadsheet";
		return `${this.file.basename} — spreadsheet`;
	}

	/* ---------------------------------------------------------- view state */

	override getState(): Record<string, unknown> {
		const state: GridViewState = {};
		if (this.file) state.path = this.file.path;
		if (this.anchor) state.anchor = this.anchor;
		return state as unknown as Record<string, unknown>;
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const incoming = (state ?? {}) as GridViewState;
		await super.setState(state, result);
		if (incoming.path === undefined) return;
		if (this.file?.path === incoming.path && this.host) return;
		await this.openTable(incoming.path, incoming.anchor);
	}

	/* ----------------------------------------------------------- lifecycle */

	override async onOpen(): Promise<void> {
		this.contentEl.addClass("markdown-spreadsheet-view");
		this.contentEl.toggleClass("mds-touch", this.touch);
		this.ribbon.mount(this.contentEl);
		this.buildFormulaBar();
		this.bannerEl = this.contentEl.createDiv({ cls: "mds-banner mds-hidden" });
		this.bodyEl = this.contentEl.createDiv({ cls: "mds-body" });
		if (this.touch) this.touchBar.mount(this.contentEl);
		this.statusBar.mount(
			this.contentEl,
			() => void this.save(true),
			(text) => {
				void navigator.clipboard.writeText(text);
				new Notice(`Copied ${text}`);
			},
		);
		this.refreshRibbon();

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.file && file.path === this.file.path) void this.onExternalModify();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && this.file && oldPath === this.file.path) {
					this.file = file;
					if (this.anchor) this.anchor = Object.assign({}, this.anchor, { path: file.path });
					this.layoutKey = this.anchor ? anchorKey(this.anchor) : this.layoutKey;
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && this.file && file.path === this.file.path) {
					this.showBanner("The note holding this table was deleted.", [
						{ label: "Export and close", cta: true, onClick: () => void this.exportThenClose() },
					]);
				}
			}),
		);

		// Blur of the tab is a save point in automatic mode (§13.2).
		this.registerDomEvent(this.contentEl, "focusout", (evt) => {
			const next = asNode(evt.relatedTarget);
			if (next !== null && this.contentEl.contains(next)) return;
			if (this.plugin.sidecar.settings.saveMode === "auto") void this.save(false);
		});
	}

	override async onClose(): Promise<void> {
		// Land an open edit first: committing marks the grid dirty and would re-arm the timer.
		this.host?.commitEdit(0, 0, false);
		this.commitFormula();
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		// Last chance to persist; the tab is going away either way.
		if (this.dirty && this.plugin.sidecar.settings.saveMode === "auto") await this.save(true);
		if (this.dirty && this.host && this.layoutKey !== "") {
			// Manual mode, or a write that could not happen: closing cannot be cancelled, so the grid
			// is kept as a version instead of vanishing. Nothing is written to the note.
			this.plugin.sidecar.pushBackup(this.layoutKey, this.serialize(this.host.getModel()), Date.now(), "unsaved");
			new Notice("The unsaved changes to this table were kept as a version you can restore.");
		}
		this.host?.captureView();
		this.persistLayout();
		this.host?.destroy();
		this.host = null;
		this.plugin.clearStatusBar();
	}

	/* ------------------------------------------------------------- opening */

	async openTable(path: string, anchor?: Anchor): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new Notice(`Cannot find ${path}.`);
			return;
		}
		this.file = file;
		const text = await this.app.vault.cachedRead(file);
		const candidateAnchor: Anchor = anchor ?? {
			path,
			tableIndex: 0,
			headerHash: "",
			colCount: 0,
			rowCount: 0,
		};

		const resolution = resolveAnchor(text, candidateAnchor);
		if (resolution.kind === "missing") {
			new Notice("No table found in this note.");
			this.leaf.detach();
			return;
		}
		if (resolution.kind === "ambiguous") {
			const failures = this.plugin.sidecar.noteAnchorFailure(path);
			new TablePickerModal(
				this.app,
				resolution.candidates,
				(picked) => void this.adoptRegion(picked.region, failures),
				{
					// Dismissing the picker used to leave an empty tab behind with nothing to do in it.
					onCancel: () => {
						if (!this.host) this.leaf.detach();
					},
				},
			).open();
			return;
		}
		this.plugin.sidecar.clearAnchorFailures(path);
		await this.adoptRegion(resolution.region, 0);
	}

	private async adoptRegion(region: TableRegion, failures: number): Promise<void> {
		if (!this.file) return;
		this.anchor = anchorFromRegion(this.file.path, region);
		this.layoutKey = anchorKey(this.anchor);
		this.expectedHash = regionHash(region.text);

		this.noteRegionText = region.text;

		const model = parseTable(region.text);
		const firstOpen = !this.plugin.sidecar.hasLayout(this.layoutKey);
		const stored = this.plugin.sidecar.getLayout(this.layoutKey);
		const layout: TableLayout = Object.assign({}, defaultLayout(this.plugin.sidecar.settings), stored);
		this.plugin.sidecar.setAnchor(this.layoutKey, this.anchor);
		this.plugin.sidecar.pushBackup(this.layoutKey, region.text, Date.now(), "opened");

		this.mountHost(model, layout);
		this.dirty = false;
		this.hideBanner();
		const host = this.host;
		if (host && firstOpen && this.plugin.sidecar.settings.autofitOnFirstOpen) {
			// Fonts and layout have to be in place before anything can be measured.
			window.setTimeout(() => {
				if (this.host !== host) return;
				const all: number[] = [];
				for (let c = 0; c < Math.max(host.getModel().usedRange.cols, 1); c++) all.push(c);
				host.autofitColumns(all);
			}, 0);
		}
		// Values a formula would give now, after edits made outside the grid. A real edit if they differ.
		host?.recalculateOnOpen();
		this.refreshRibbon();
		this.refreshStatus();
		void this.refreshTableSwitch();

		const ragged = raggedRows(region.text);
		if (ragged.length > 0) {
			new Notice(
				`Line ${ragged.slice(0, 5).join(", ")}${ragged.length > 5 ? " and more" : ""} of this table ${ragged.length === 1 ? "has" : "have"} a different number of cells than the header. Saving evens the rows out.`,
			);
		}

		await this.maybeOfferBlockId(failures);
	}

	private mountHost(model: GridModel, layout: TableLayout): void {
		this.host?.destroy();
		this.bodyEl.empty();
		const host = new GridHost(
			{
				app: this.app,
				component: this,
				sourcePath: this.file?.path ?? "",
				settings: this.plugin.sidecar.settings,
				touch: this.touch,
				callbacks: {
					onDirty: () => this.markDirty(),
					onLayoutChange: () => {
						this.persistLayout();
						// Freeze, wrap and sizes show their state in the ribbon.
						this.refreshRibbon();
					},
					onBeforeMutate: () => this.commitFormula(),
					onSelectionChange: (selection) => this.onSelectionChange(selection),
					onNotice: (message) => new Notice(message),
					onCalcPlaced: () => this.refreshRibbon(),
					onEditorInput: (value) => {
						this.formulaTarget = null;
						this.formulaInputEl.value = value;
						this.refreshTouchBar();
					},
					onClipboard: (action) => {
						if (action === "paste") void this.pasteFromClipboard("normal");
						else this.copyToClipboard(action === "cut");
					},
					onRangeModeChange: () => this.refreshTouchBar(),
					onFiles: (files, row, col) => void this.attachFiles(files, row, col),
					onDropText: (text, row, col) => this.linkDroppedText(text, row, col),
					onFiltersChange: () => {
						this.refreshStatus();
						this.refreshRibbon();
					},
					onHoverLink: (evt, link, linktext) => {
						this.app.workspace.trigger("hover-link", {
							event: evt,
							source: VIEW_TYPE_GRID,
							hoverParent: this,
							targetEl: link,
							linktext,
							sourcePath: this.file?.path ?? "",
						});
					},
				},
			},
			model,
			layout,
		);
		host.mount(this.bodyEl);
		this.host = host;
		host.focus();
	}

	/* ----------------------------------------------------- block ID (§7/L3) */

	private async maybeOfferBlockId(failures: number): Promise<void> {
		if (!this.file || !this.anchor) return;
		const strategy = this.plugin.sidecar.settings.anchorStrategy;
		if (this.anchor.blockId !== undefined) return;

		const threshold = strategy === "ask" ? 1 : strategy === "blockId" ? 0 : 2;
		if (strategy !== "blockId" && failures < threshold) return;

		const id = newBlockId();
		const apply = async () => {
			if (!this.file || !this.anchor) return;
			const ok = await this.writer.addBlockId(this.file, this.anchor, id);
			if (!ok) {
				new Notice("Could not add the block ID.");
				return;
			}
			this.anchor = Object.assign({}, this.anchor, { blockId: id });
			this.plugin.sidecar.setAnchor(this.layoutKey, this.anchor);
			this.plugin.sidecar.clearAnchorFailures(this.file.path);
			await this.reloadFromNote(false);
		};

		if (strategy === "blockId") {
			await apply();
			return;
		}
		new ConfirmModal(this.app, {
			title: "Mark this table permanently?",
			body: `This table could not be identified reliably. Adding the marker ^${id} on the line after it makes the match exact from now on. This changes your note.`,
			cta: "Add the marker",
			cancel: "Not now",
			onConfirm: () => void apply(),
		}).open();
	}

	/* --------------------------------------------------------------- dirty */

	private markDirty(): void {
		this.dirty = true;
		this.refreshStatus();
		this.refreshRibbon();
		if (this.plugin.sidecar.settings.saveMode !== "auto") return;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save(false);
		}, this.plugin.sidecar.settings.autosaveDebounceMs);
	}

	private persistLayout(): void {
		if (!this.host || this.layoutKey === "") return;
		this.plugin.sidecar.setLayout(this.layoutKey, this.host.getLayout());
	}

	private serialize(model: GridModel): string {
		return serializeTable(model, { compact: this.plugin.sidecar.settings.tableStyle === "compact" });
	}

	/* ---------------------------------------------------------------- write */

	/**
	 * Writes the grid back into the note.
	 *
	 * Everything that can go wrong is surfaced, never guessed: a sparse used range asks first, a
	 * changed region raises the conflict banner, a vanished table offers recovery.
	 */
	async save(explicit: boolean): Promise<void> {
		if (!this.host || !this.file || !this.anchor) return;
		if (!this.dirty && !explicit) return;
		if (this.writing) return;
		if (this.conflictShown && !explicit) return;

		const model = this.host.getModel();
		if (this.plugin.sidecar.settings.confirmSparseWrite && this.needsDensityConfirm(model)) {
			this.askDensity(model);
			return;
		}
		const settings = this.plugin.sidecar.settings;
		if (explicit && settings.saveMode === "manual" && settings.previewBeforeSave) {
			const mine = this.serialize(model).replace(/\n+$/, "");
			if (diffLines(this.noteRegionText, mine).every((l) => l.kind === "same")) {
				await this.performWrite();
				return;
			}
			new DiffModal(this.app, {
				mine: this.noteRegionText,
				theirs: mine,
				title: "Write these changes to the note?",
				legend: "− in the note now · + after saving",
				confirm: { label: "Write to the note", onConfirm: () => void this.performWrite() },
			}).open();
			return;
		}
		await this.performWrite();
	}

	private needsDensityConfirm(model: GridModel): boolean {
		const { rows, cols } = model.usedRange;
		return density(model) < 0.3 && rows * cols > 200;
	}

	private askDensity(model: GridModel): void {
		const { rows, cols } = model.usedRange;
		new DensityModal(this.app, {
			rows,
			cols,
			filled: filledCount(model),
			onShrink: () => {
				this.host?.mutate("Shrink to data", () => shrinkToData(model));
				void this.performWrite();
			},
			onWriteAnyway: () => void this.performWrite(),
		}).open();
	}

	private async performWrite(): Promise<void> {
		if (!this.host || !this.file || !this.anchor) return;
		const blockText = this.serialize(this.host.getModel()).replace(/\n+$/, "");
		if (regionHash(blockText) === this.expectedHash) {
			this.dirty = false;
			this.refreshStatus();
			return;
		}

		this.writing = true;
		try {
			const outcome = await this.writer.write(this.file, this.anchor, blockText, this.expectedHash);
			switch (outcome.kind) {
				case "written":
				case "unchanged": {
					this.anchor = outcome.anchor;
					this.layoutKey = anchorKey(this.anchor);
					this.expectedHash = regionHash(outcome.region.text);
					this.noteRegionText = outcome.region.text;
					this.plugin.sidecar.setAnchor(this.layoutKey, this.anchor);
					this.plugin.sidecar.pushBackup(this.layoutKey, outcome.region.text, Date.now());
					this.persistLayout();
					this.dirty = false;
					this.hideBanner();
					break;
				}
				case "conflict": {
					this.showConflict(blockText, outcome.currentText);
					break;
				}
				case "missing": {
					this.showMissing(blockText);
					break;
				}
				case "ambiguous": {
					this.showBanner("The table can no longer be identified in this note. Nothing was written.", [
						{
							label: "Choose the table",
							cta: true,
							onClick: () => {
								new TablePickerModal(this.app, outcome.candidates, (picked) => {
									void this.adoptRegion(picked.region, 0);
								}).open();
							},
						},
					]);
					break;
				}
			}
		} catch (error) {
			new Notice(`Write failed — ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.writing = false;
			this.refreshStatus();
			this.refreshRibbon();
		}
	}

	/* ------------------------------------------------------ external change */

	/**
	 * Layer 0 of §7 plus the concurrency rules of §13.2.
	 *
	 * While the tab is open the anchor is recomputed on every file change, so drift can only
	 * happen between sessions.
	 */
	private async onExternalModify(): Promise<void> {
		if (!this.file || !this.anchor || this.writing || !this.host) return;
		const text = await this.app.vault.cachedRead(this.file);
		const resolution = resolveAnchor(text, this.anchor);

		if (resolution.kind === "missing") {
			this.showMissing(this.serialize(this.host.getModel()));
			return;
		}
		if (resolution.kind === "ambiguous") return;

		const region = resolution.region;
		const hash = regionHash(region.text);
		// The anchor may have shifted because the user edited text above the table. Silent.
		this.anchor = anchorFromRegion(this.file.path, region);
		this.plugin.sidecar.setAnchor(anchorKey(this.anchor), this.anchor);

		if (hash === this.expectedHash) return;

		// Text being typed — in a cell or in the formula bar — is an unsaved change too. Reloading
		// under it would discard it, or land it in a row that has since moved.
		if (this.dirty || this.host.isEditing() || this.formulaTarget !== null) {
			// Two sets of edits to the same lines. Only the user can decide (§13.2).
			this.showConflict(this.serialize(this.host.getModel()).replace(/\n+$/, ""), region.text);
			return;
		}
		// Nothing local to lose, so adopting the note's version cannot destroy anything.
		await this.reloadFromNote(true);
		new Notice("The table changed in the note and was reloaded.");
	}

	private showConflict(mine: string, theirs: string): void {
		this.conflictShown = true;
		this.showBanner("This table changed in the note. Nothing was written.", [
			{
				label: "Reload from the note",
				onClick: () => void this.reloadFromNote(true),
			},
			{
				label: "Overwrite the note",
				warning: true,
				onClick: () => {
					this.conflictShown = false;
					this.expectedHash = regionHash(theirs);
					void this.performWrite();
				},
			},
			{
				label: "Show the difference",
				onClick: () => new DiffModal(this.app, { mine, theirs }).open(),
			},
		]);
	}

	private showMissing(blockText: string): void {
		this.showBanner("This table is no longer in the note.", [
			{
				label: "Append it to the note",
				cta: true,
				onClick: () => {
					if (!this.file) return;
					void this.writer.appendTable(this.file, blockText).then((region) => {
						if (region) void this.adoptRegion(region, 0);
						else new Notice("Could not append the table.");
					});
				},
			},
			{ label: "Export and close", onClick: () => void this.exportThenClose() },
		]);
	}

	private async reloadFromNote(keepSelection: boolean): Promise<void> {
		if (!this.file || !this.anchor || !this.host) return;
		const text = await this.app.vault.cachedRead(this.file);
		const resolution = resolveAnchor(text, this.anchor);
		if (resolution.kind !== "resolved") return;
		const region = resolution.region;
		this.expectedHash = regionHash(region.text);
		this.noteRegionText = region.text;
		this.anchor = anchorFromRegion(this.file.path, region);
		this.layoutKey = anchorKey(this.anchor);
		// Reloading is a decision to take the note's version; pending formula-bar text belonged to
		// the old grid and must not be written into the new one at whatever cell it now points to.
		this.formulaTarget = null;
		this.host.replaceData(parseTable(region.text), this.plugin.sidecar.getLayout(this.layoutKey), keepSelection);
		this.host.undo.clear();
		this.dirty = false;
		this.conflictShown = false;
		this.hideBanner();
		this.refreshStatus();
		this.refreshRibbon();
	}

	private async exportThenClose(): Promise<void> {
		if (!this.host) return;
		await this.exportCsv(this.host.getModel(), this.csvDefaults(), this.defaultExportName("csv"));
		this.dirty = false;
		this.leaf.detach();
	}

	/* --------------------------------------------------------------- banner */

	private showBanner(message: string, actions: BannerAction[]): void {
		this.bannerEl.empty();
		this.bannerEl.removeClass("mds-hidden");
		const icon = this.bannerEl.createSpan({ cls: "mds-banner-icon" });
		setIconSafe(icon, "warning");
		this.bannerEl.createSpan({ cls: "mds-banner-text", text: message });
		const buttons = this.bannerEl.createDiv({ cls: "mds-banner-actions" });
		for (const action of actions) {
			const btn = buttons.createEl("button", { text: action.label, attr: { type: "button" } });
			if (action.cta) btn.addClass("mod-cta");
			if (action.warning) btn.addClass("mod-warning");
			btn.addEventListener("click", () => action.onClick());
		}
	}

	private hideBanner(): void {
		this.conflictShown = false;
		this.bannerEl.empty();
		this.bannerEl.addClass("mds-hidden");
	}

	/* ---------------------------------------------------------- formula bar */

	private buildFormulaBar(): void {
		const bar = this.contentEl.createDiv({ cls: "mds-formulabar" });
		this.tableSwitchEl = bar.createEl("select", { cls: "dropdown mds-table-switch mds-hidden", attr: { "aria-label": "Switch to another table of this note" } });
		this.tableSwitchEl.addEventListener("change", () => void this.switchTable(Number.parseInt(this.tableSwitchEl.value, 10)));
		this.formulaAddressEl = bar.createDiv({ cls: "mds-formula-address", text: "A1" });
		setIconSafe(bar.createDiv({ cls: "mds-formula-icon", attr: { "aria-hidden": "true" } }), "formula");
		this.formulaInputEl = bar.createEl("input", {
			cls: "mds-formula-input",
			attr: { type: "text", placeholder: "Cell contents as Markdown, or a formula starting with =", spellcheck: "false" },
		});
		this.formulaInputEl.addEventListener("input", () => {
			if (!this.host || this.formulaTarget !== null) return;
			const { row, col } = this.host.getSelection().active;
			this.formulaTarget = { row, col };
		});
		this.formulaInputEl.addEventListener("focus", () => this.host?.commitEdit(0, 0, false));
		this.formulaInputEl.addEventListener("keydown", (evt) => {
			evt.stopPropagation();
			if (evt.isComposing) return;
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.commitFormula();
				this.host?.focus();
				this.host?.moveActive(evt.shiftKey ? -1 : 1, 0);
			} else if (evt.key === "Tab") {
				evt.preventDefault();
				this.commitFormula();
				this.host?.focus();
				this.host?.moveActive(0, evt.shiftKey ? -1 : 1);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.formulaTarget = null;
				this.syncFormulaBar();
				this.host?.focus();
			}
		});
		this.formulaInputEl.addEventListener("blur", () => this.commitFormula());
	}

	/**
	 * Writes the formula bar into the cell it was opened on.
	 *
	 * It used to write into whichever cell was active at blur time. Clicking another cell moves the
	 * selection before the blur, and the selection change had already overwritten the input with
	 * the new cell's content — so the typed text was silently dropped.
	 */
	private commitFormula(): void {
		const target = this.formulaTarget;
		if (!target || !this.host) return;
		this.formulaTarget = null;
		this.host.setValueAt(target.row, target.col, this.formulaInputEl.value);
	}

	private syncFormulaBar(): void {
		if (!this.host) return;
		// A pending formula-bar edit belongs to the cell it started on; land it before showing the next.
		if (this.formulaTarget !== null) this.commitFormula();
		const { active } = this.host.getSelection();
		this.formulaAddressEl.setText(this.host.activeLabel());
		if (this.host.isEditing()) return;
		this.formulaInputEl.value = this.host.editTextAt(active.row, active.col);
	}

	/** The other tables of this note, to jump between them without going back to the note. */
	private async refreshTableSwitch(): Promise<void> {
		const select = this.tableSwitchEl;
		if (!this.file || !select) return;
		const tables = scanTables(await this.app.vault.cachedRead(this.file));
		select.empty();
		select.toggleClass("mds-hidden", tables.length < 2);
		for (const region of tables) {
			const head = region.headerCells.slice(0, 3).map((h) => plainText(h)).join(", ");
			select.createEl("option", { text: `Table ${region.index + 1}: ${head}`, attr: { value: String(region.index) } });
		}
		if (this.anchor) select.value = String(this.anchor.tableIndex);
	}

	private async switchTable(index: number): Promise<void> {
		if (!this.file || !this.anchor || index === this.anchor.tableIndex) return;
		this.host?.commitEdit(0, 0, false);
		this.commitFormula();
		if (this.dirty) await this.save(true);
		if (this.dirty) {
			new Notice("Save or discard the changes to this table first.");
			if (this.tableSwitchEl) this.tableSwitchEl.value = String(this.anchor.tableIndex);
			return;
		}
		this.host?.captureView();
		this.persistLayout();
		const region = scanTables(await this.app.vault.cachedRead(this.file))[index];
		if (region) await this.adoptRegion(region, 0);
	}

	/* ---------------------------------------------------------------- status */

	private onSelectionChange(selection: Selection): void {
		void selection;
		this.syncFormulaBar();
		this.refreshStatus();
		this.refreshRibbon();
	}

	private refreshStatus(): void {
		if (!this.host) return;
		const settings = this.plugin.sidecar.settings;
		const agg = aggregate(this.host.getModel(), this.host.getSelection().rect, this.host.numberOpts());
		const line = summaryLine(agg, settings.numberLocale);
		const hints: string[] = [];
		if (this.host.getFilters().length > 0) hints.push("Filtered view — hidden rows are still saved");
		if (this.host.hiddenColumnCount() > 0) hints.push(`${this.host.hiddenColumnCount()} hidden ${this.host.hiddenColumnCount() === 1 ? "column" : "columns"}`);
		const dupes = duplicateHeaders(this.host.getModel());
		if (dupes.length > 0) hints.push(`Repeated column name: ${dupes.join(", ")}`);
		if (this.host.getGeometryMode() === "inline") hints.push("Row sizing uses the fallback path");
		const stats: Array<{ label: string; value: string }> = [];
		if (agg.numericCount > 0) {
			const fmt = (n: number | null) => (n === null ? "" : formatCompact(n, settings.numberLocale));
			const values: Record<StatusStat, [string, string]> = {
				sum: ["Sum", fmt(agg.sum)],
				average: ["Average", fmt(agg.average)],
				count: ["Count", String(agg.numericCount)],
				counta: ["Filled", String(agg.filledCount)],
				min: ["Min", fmt(agg.min)],
				max: ["Max", fmt(agg.max)],
			};
			for (const key of settings.statusStats) stats.push({ label: values[key][0], value: values[key][1] });
		} else if (agg.filledCount > 0) {
			stats.push({ label: "Count", value: String(agg.filledCount) });
		}
		this.statusBar.update({
			address: this.host.activeLabel(),
			stats,
			aggregate: line,
			usedRange: this.host.usedRangeLabel(),
			dirty: this.dirty,
			saveMode: settings.saveMode,
			hint: hints.length > 0 ? hints.join(" · ") : undefined,
		});
		this.plugin.setStatusBarText(line);
	}

	/* ---------------------------------------------------------------- scope */

	/** Keys are ignored while a text field inside the view has focus. */
	private shouldIgnoreKey(): boolean {
		const active = asElement(this.contentEl.ownerDocument.activeElement);
		if (active === null) return false;
		if (!this.contentEl.contains(active)) return true;
		if (active.hasClass("mds-editor")) return true;
		const tag = active.tagName;
		return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
	}

	private registerScope(): void {
		const scope = this.scope;
		if (!scope) return;
		const bind = (mods: Parameters<Scope["register"]>[0], key: string, fn: () => void) => {
			scope.register(mods, key, (evt) => {
				if (this.shouldIgnoreKey()) return true;
				if (!this.host) return true;
				evt.preventDefault();
				fn();
				return false;
			});
		};

		const arrows: Array<[string, number, number]> = [
			["ArrowUp", -1, 0],
			["ArrowDown", 1, 0],
			["ArrowLeft", 0, -1],
			["ArrowRight", 0, 1],
		];
		for (const [key, dRow, dCol] of arrows) {
			bind([], key, () => this.host?.moveActive(dRow, dCol));
			bind(["Shift"], key, () => this.host?.moveActive(dRow, dCol, true));
			bind(["Mod"], key, () => this.host?.jumpToEdge(dRow, dCol));
			bind(["Mod", "Shift"], key, () => this.host?.jumpToEdge(dRow, dCol, true));
		}

		bind([], "Tab", () => this.host?.moveActive(0, 1));
		bind(["Shift"], "Tab", () => this.host?.moveActive(0, -1));
		bind([], "Enter", () => this.host?.moveActive(1, 0));
		bind(["Shift"], "Enter", () => this.host?.moveActive(-1, 0));
		bind([], "F2", () => this.host?.beginEdit());
		bind([], "Delete", () => this.host?.clearSelectionContents());
		bind([], "Backspace", () => this.host?.clearSelectionContents());
		bind([], "Home", () => this.host?.jumpToRowEdge(false));
		bind([], "End", () => this.host?.jumpToRowEdge(true));
		bind(["Shift"], "Home", () => this.host?.jumpToRowEdge(false, true));
		bind(["Shift"], "End", () => this.host?.jumpToRowEdge(true, true));
		bind(["Mod"], "Home", () => this.host?.goTo(0, 0));
		bind(["Mod"], "End", () => {
			const used = this.host?.getModel().usedRange;
			if (used) this.host?.goTo(Math.max(0, used.rows - 1), Math.max(0, used.cols - 1));
		});
		bind(["Mod"], "a", () => this.host?.selectAll());
		bind(["Mod"], "z", () => this.host?.undoLast());
		bind(["Mod", "Shift"], "z", () => this.host?.redoLast());
		bind(["Mod"], "y", () => this.host?.redoLast());
		bind(["Mod"], "b", () => this.host?.format("bold"));
		bind(["Mod"], "i", () => this.host?.format("italic"));
		bind(["Mod"], "d", () => this.fill("down"));
		bind(["Mod"], "k", () => this.linkCells());
		bind(["Mod"], "g", () => this.openGoTo());
		bind(["Mod"], ";", () => this.insertNow(false));
		bind(["Mod", "Shift"], ";", () => this.insertNow(true));
		bind(["Alt"], "ArrowDown", () => this.host?.openPickList());
		bind(["Mod"], "=", () => this.host?.setZoom(this.host.getZoom() + 0.1));
		bind(["Mod"], "-", () => this.host?.setZoom(this.host.getZoom() - 0.1));
		bind(["Mod"], "0", () => this.host?.setZoom(1));

		// Save works from anywhere in the tab, including mid-edit: the edit is committed first.
		scope.register(["Mod"], "s", (evt) => {
			if (!this.host) return true;
			const active = asElement(this.contentEl.ownerDocument.activeElement);
			if (active !== null && !this.contentEl.contains(active)) return true;
			evt.preventDefault();
			this.host.commitEdit(0, 0, false);
			this.commitFormula();
			void this.save(true);
			return false;
		});

		// Escape cancels the pending calculation target before anything else (§12).
		scope.register([], "Escape", (evt) => {
			if (!this.host) return true;
			if (this.host.isEditing()) return true;
			if (this.host.hasPendingCalc()) {
				evt.preventDefault();
				this.host.cancelCalcPlacement();
				this.refreshRibbon();
				return false;
			}
			return true;
		});
	}

	/* --------------------------------------------------------------- ribbon */

	private refreshRibbon(): void {
		this.ribbon.setTabs(this.buildTabs());
		this.refreshTouchBar();
	}

	/** The touch bar: what a mouse and keyboard did without a toolbar, a thumb's reach away. */
	private refreshTouchBar(): void {
		if (!this.touch) return;
		const host = this.host;
		const editing = host?.isEditing() === true;
		const actions: TouchAction[] = [
			editing
				? { id: "edit", label: "Done", icon: "done", active: true, onClick: () => host?.commitEdit(0, 0, true) }
				: { id: "edit", label: "Edit", icon: "edit", disabled: !host, onClick: () => host?.beginEdit() },
			{
				id: "range",
				label: "Range",
				icon: "rangeSelect",
				active: host?.isRangeMode() === true,
				disabled: !host || editing,
				onClick: () => host?.setRangeMode(!host.isRangeMode()),
			},
			{ id: "undo", label: "Undo", icon: "undo", disabled: !host?.undo.canUndo() || editing, onClick: () => host?.undoLast() },
			{ id: "redo", label: "Redo", icon: "redo", disabled: !host?.undo.canRedo() || editing, onClick: () => host?.redoLast() },
			{ id: "copy", label: "Copy", icon: "copy", disabled: !host || editing, onClick: () => this.copyToClipboard(false) },
			{ id: "paste", label: "Paste", icon: "paste", disabled: !host || editing, onClick: () => void this.pasteFromClipboard("normal") },
			{ id: "row", label: "Add row", icon: "rowBelow", disabled: !host || editing, onClick: () => host?.insertRowsAt("below") },
			{
				id: "more",
				label: "More",
				icon: "more",
				disabled: !host || editing,
				onClick: () => {
					const box = this.contentEl.find(".mds-touchbar")?.getBoundingClientRect();
					host?.openSelectionMenu({ x: box ? box.right : 0, y: box ? box.top : 0 });
				},
			},
		];
		this.touchBar.update(actions);
	}

	/** Runs a toolbar action by id — the command palette's route to everything on the ribbon. */
	runAction(id: string): boolean {
		for (const tab of this.buildTabs()) {
			for (const group of tab.groups) {
				for (const item of group.items) {
					const actions = item.kind === "button" ? [item.action] : item.kind === "cluster" ? item.actions : [];
					const action = actions.find((a) => a.id === id);
					if (!action) continue;
					if (action.disabled) {
						new Notice(action.tooltip ? `${action.label}: ${action.tooltip}` : `${action.label} is not available here.`);
						return false;
					}
					action.onClick();
					return true;
				}
			}
		}
		return false;
	}

	private buildTabs(): RibbonTab[] {
		const host = this.host;
		const settings = this.plugin.sidecar.settings;
		const action = (
			id: string,
			label: string,
			icon: IconKey,
			onClick: () => void,
			extra?: { tooltip?: string; disabled?: boolean; active?: boolean; primary?: boolean },
		): RibbonAction => ({
			id,
			label,
			icon,
			// Typed input is committed first — the cell editor and the formula bar keep focus through
			// a ribbon click — so every action sees it, and it lands in the cell it was typed for.
			onClick: () => {
				this.host?.commitEdit(0, 0, false);
				this.commitFormula();
				onClick();
			},
			...(extra?.tooltip === undefined ? {} : { tooltip: extra.tooltip }),
			...(extra?.disabled === undefined ? {} : { disabled: extra.disabled }),
			...(extra?.active === undefined ? {} : { active: extra.active }),
			...(extra?.primary === undefined ? {} : { primary: extra.primary }),
		});
		const button = (
			id: string,
			label: string,
			icon: IconKey,
			onClick: () => void,
			extra?: { tooltip?: string; disabled?: boolean; active?: boolean; primary?: boolean },
		): RibbonItem => ({ kind: "button", action: action(id, label, icon, onClick, extra) });
		/** Related actions as one segmented run of icons; the label lives in the tooltip. */
		const cluster = (id: string, actions: RibbonAction[]): RibbonItem => ({ kind: "cluster", id, actions });

		const rect = host?.getSelection().rect ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
		const active = host?.getSelection().active ?? { row: 0, col: 0 };
		const cols = host ? rectCols(rect) : [0];
		const rows = host ? rectRows(rect) : [0];
		const headerOnly = rect.r1 === 0 && rect.r2 === 0;
		const singleRow = rect.r1 === rect.r2;
		const singleCol = rect.c1 === rect.c2;
		const usedRows = host?.getModel().usedRange.rows ?? 0;
		const usedCols = host?.getModel().usedRange.cols ?? 0;
		const wrapped = host ? cols.every((c) => host.getLayout().wrapCols.includes(c)) : false;
		const rendered = host?.getRenderMode() === "rendered";
		const formats = host?.activeFormats() ?? new Set<string>();
		const frozenRows = host?.getLayout().frozenRows ?? 0;
		const frozenCols = host?.getLayout().frozenCols ?? 0;
		const filters = host?.getFilters().length ?? 0;
		const hidden = host?.hiddenColumnCount() ?? 0;
		const zoom = host?.getZoom() ?? 1;
		const alignOf = (align: Align) => (host ? cols.every((c) => (host.getModel().colAlign[c] ?? null) === align) : false);
		const undoLabel = host?.undo.undoLabel() ?? null;
		const redoLabel = host?.undo.redoLabel() ?? null;
		const colLabel = colName(active.col);

		return [
			{
				id: "home",
				label: "Home",
				icon: "tabHome",
				groups: [
					{
						label: "Clipboard",
						items: [
							cluster("clipboard", [
								action("copy", "Copy", "copy", () => this.copyToClipboard(false), {
									tooltip: "the selection as tab-separated text (Ctrl+C)",
								}),
								action("cut", "Cut", "cut", () => this.copyToClipboard(true), { tooltip: "Ctrl+X" }),
								action("paste", "Paste", "paste", () => void this.pasteFromClipboard("normal"), {
									tooltip: "tab-separated text or a Markdown table (Ctrl+V)",
								}),
								action("paste-special", "Paste special", "pasteSpecial", () => this.pasteSpecialMenu(), {
									tooltip: "transposed, or as plain text without Markdown",
								}),
							]),
							cluster("history", [
								action("undo", "Undo", "undo", () => host?.undoLast(), {
									disabled: !host?.undo.canUndo(),
									tooltip: undoLabel !== null ? `${undoLabel.toLowerCase()} (Ctrl+Z)` : "nothing to undo",
								}),
								action("redo", "Redo", "redo", () => host?.redoLast(), {
									disabled: !host?.undo.canRedo(),
									tooltip: redoLabel !== null ? `${redoLabel.toLowerCase()} (Ctrl+Y)` : "nothing to redo",
								}),
							]),
						],
					},
					{
						label: "Rows",
						items: [
							cluster("rows", [
								action("row-above", "Insert row above", "rowAbove", () => host?.insertRowsAt("above"), {
									disabled: rect.r1 === 0,
									tooltip: rect.r1 === 0 ? "row 1 is the table header, so nothing can go above it" : undefined,
								}),
								action("row-below", "Insert row below", "rowBelow", () => host?.insertRowsAt("below")),
								action("row-duplicate", "Duplicate row", "duplicate", () => host?.duplicateSelectedRows(), {
									disabled: headerOnly,
									tooltip: headerOnly ? "a table has one header row" : "copies the selected rows below themselves",
								}),
								action("row-delete", "Delete row", "remove", () => host?.deleteSelectedRows(), {
									disabled: headerOnly,
									tooltip: headerOnly ? "Markdown tables require a header row" : undefined,
								}),
							]),
							cluster("rows-move", [
								action("row-up", "Move row up", "up", () => host?.moveSelectedRow(-1), {
									disabled: !singleRow || rect.r1 <= 1,
									tooltip: singleRow ? "or drag the row number" : "select a single row",
								}),
								action("row-down", "Move row down", "down", () => host?.moveSelectedRow(1), {
									disabled: !singleRow || rect.r1 === 0 || rect.r1 >= usedRows - 1,
									tooltip: singleRow ? "or drag the row number" : "select a single row",
								}),
							]),
						],
					},
					{
						label: "Columns",
						items: [
							cluster("cols", [
								action("col-left", "Insert column left", "colLeft", () => host?.insertColsAt("left")),
								action("col-right", "Insert column right", "colRight", () => host?.insertColsAt("right")),
								action("col-duplicate", "Duplicate column", "duplicate", () => host?.duplicateSelectedCols(), {
									tooltip: "copies the selected columns to their right",
								}),
								action("col-delete", "Delete column", "remove", () => host?.deleteSelectedCols()),
							]),
							cluster("cols-move", [
								action("col-left-move", "Move column left", "left", () => host?.moveSelectedCol(-1), {
									disabled: !singleCol || rect.c1 === 0,
									tooltip: "or drag the column letter",
								}),
								action("col-right-move", "Move column right", "right", () => host?.moveSelectedCol(1), {
									disabled: !singleCol || rect.c1 >= usedCols - 1,
									tooltip: "or drag the column letter",
								}),
							]),
						],
					},
					{
						label: "Alignment",
						items: [
							cluster("align", [
								// GFM stores alignment per column, never per cell (§3).
								action("align-left", "Align left", "alignLeft", () => host?.setAlignment("left"), {
									tooltip: "applies to the whole column — Markdown has no per-cell alignment",
									active: alignOf("left"),
								}),
								action("align-center", "Align centre", "alignCenter", () => host?.setAlignment("center"), {
									tooltip: "applies to the whole column",
									active: alignOf("center"),
								}),
								action("align-right", "Align right", "alignRight", () => host?.setAlignment("right"), {
									tooltip: "applies to the whole column",
									active: alignOf("right"),
								}),
								action("align-none", "Default alignment", "alignNone", () => host?.setAlignment(null), {
									tooltip: "removes the alignment marker from the column",
									active: alignOf(null),
								}),
							]),
						],
					},
					{
						label: "Format",
						items: [
							cluster("emphasis", [
								action("bold", "Bold", "bold", () => host?.format("bold"), {
									tooltip: "** or __ around the cell (Ctrl+B)",
									active: formats.has("bold"),
								}),
								action("italic", "Italic", "italic", () => host?.format("italic"), {
									tooltip: "* or _ around the cell (Ctrl+I)",
									active: formats.has("italic"),
								}),
								action("code", "Code", "code", () => host?.format("code"), {
									tooltip: "backticks around the cell",
									active: formats.has("code"),
								}),
								action("strike", "Strikethrough", "strike", () => host?.format("strikethrough"), {
									tooltip: "~~ around the cell",
									active: formats.has("strikethrough"),
								}),
								action("link", "Link", "link", () => this.linkCells(), {
									tooltip: "turns the cell text into a [[link]] (Ctrl+K)",
								}),
							]),
							button("wrap", "Wrap", "wrap", () => host?.toggleWrap(cols), {
								active: wrapped,
								tooltip: "visual only — the cell stays a single line of Markdown",
							}),
							button(
								"render",
								rendered ? "Raw" : "Rendered",
								rendered ? "raw" : "rendered",
								() => {
									host?.setRenderMode(rendered ? "raw" : "rendered");
									this.refreshRibbon();
								},
								{
									tooltip: rendered
										? "show the Markdown source of every cell instead"
										: "format each visible cell the way the note does",
								},
							),
						],
					},
				],
			},
			{
				id: "data",
				label: "Data",
				icon: "tabData",
				groups: [
					{
						label: "Sort",
						items: [
							cluster("sort", [
								action("sort-asc", "Sort ascending", "sortAsc", () => this.sort(true), {
									tooltip: `by column ${colLabel}; the header row stays in place`,
								}),
								action("sort-desc", "Sort descending", "sortDesc", () => this.sort(false), {
									tooltip: `by column ${colLabel}; the header row stays in place`,
								}),
								action("sort-multi", "Sort by several columns", "sortDialog", () => this.openMultiSort()),
							]),
						],
					},
					{
						label: "Filter",
						items: [
							button("filter", "Filter", "filter", () => this.openFilterDialog(), {
								active: filters > 0,
								tooltip: "hides rows in the grid only — the note keeps every row; the arrow in a column letter filters that column",
							}),
							button(
								"filter-clear",
								"Clear",
								"filterClear",
								() => {
									host?.setFilters([]);
									this.refreshStatus();
									this.refreshRibbon();
								},
								{ disabled: filters === 0, tooltip: filters === 0 ? "no filter is set" : "show every row again" },
							),
						],
					},
					{
						label: "Editing",
						items: [
							cluster("find", [
								action("find", "Find and replace", "search", () => this.openFindReplace()),
								action("go-to", "Go to cell", "goTo", () => this.openGoTo(), { tooltip: "Ctrl+G" }),
							]),
							cluster("fill", [
								action("fill-down", "Fill down", "fillDown", () => this.fill("down"), {
									tooltip: "copies the first row of the selection into the rest, or the row above into a single row (Ctrl+D)",
								}),
								action("fill-right", "Fill right", "fillRight", () => this.fill("right"), {
									tooltip: "copies the first column of the selection into the rest",
								}),
								action("insert-date", "Insert date", "date", () => this.insertNow(false), { tooltip: "Ctrl+;" }),
								action("clear", "Clear contents", "clear", () => host?.clearSelectionContents(), {
									tooltip: "Delete",
								}),
							]),
						],
					},
					{
						label: "Tools",
						items: [
							cluster("tools", [
								action("text-to-columns", "Split into columns", "split", () => this.openTextToColumns(), {
									tooltip: `splits column ${colLabel} at a separator`,
								}),
								action("merge-columns", "Merge columns", "merge", () => this.openMergeColumns()),
								action("remove-duplicates", "Remove duplicate rows", "dedupe", () => this.openRemoveDuplicates()),
								action("change-text", "Change text", "textTools", () => this.textToolsMenu(), {
									tooltip: "upper case, lower case, trim spaces, replace &nbsp;",
								}),
							]),
						],
					},
				],
			},
			{
				id: "calc",
				label: "Calculate",
				icon: "tabCalc",
				groups: [
					{
						label: "Quick",
						items: [
							button("calc", "Calculate", "calculate", () => this.openCalculate(), {
								tooltip: "inserts a one-off value from the selection",
							}),
							button("calc-again", "Again", "again", () => this.recalculateLast(), {
								disabled: this.lastCalc === null,
								tooltip: this.lastCalc
									? `recompute ${this.lastCalc.fn} over the current selection`
									: "nothing calculated yet in this tab",
							}),
						],
					},
					{
						label: "Formulas",
						items: [
							button("totals-row", "Totals row", "totals", () => this.openTotals(), {
								tooltip: "SUM under every numeric column, kept up to date by the grid",
							}),
							button("compute-column", "Compute column", "compute", () => this.openComputeColumn(), {
								tooltip: "fills a column from an expression such as [Qty] * [Price], once",
							}),
						],
					},
					{
						label: "Numbers",
						items: [
							button("number-format", "Format numbers", "numberFormat", () => this.openNumberFormat(), {
								tooltip: "rewrites the selected numbers as currency, percent or with fixed decimals",
							}),
							button("column-stats", "Column statistics", "stats", () => this.openColumnStats(), {
								tooltip: `counts, sum, minimum and maximum of column ${colLabel}`,
							}),
						],
					},
				],
			},
			{
				id: "table",
				label: "Table",
				icon: "tabTable",
				groups: [
					{
						label: "Size",
						items: [
							{
								kind: "number",
								id: "colw",
								label: "Width",
								value: host?.getLayout().colWidths[rect.c1] || settings.defaultColWidth,
								min: MIN_COL_WIDTH,
								max: MAX_COL_WIDTH,
								tooltip: "Applies to every selected column. Stored outside the note.",
								onCommit: (value) => host?.setColumnWidth(cols, value),
							},
							{
								kind: "number",
								id: "rowh",
								label: "Height",
								value: host?.getLayout().rowHeights[String(rect.r1)] || settings.defaultRowHeight,
								min: MIN_ROW_HEIGHT,
								max: MAX_ROW_HEIGHT,
								tooltip: "Applies to every selected row. Stored outside the note.",
								onCommit: (value) => host?.setRowHeight(rows, value),
							},
						],
					},
					{
						label: "Autofit",
						items: [
							cluster("autofit", [
								action("autofit-col", "Autofit columns", "autofitCols", () => host?.autofitColumns(cols), {
									tooltip: "fit the selected columns to their widest cell",
								}),
								action("autofit-row", "Autofit rows", "autofitRows", () => host?.autofitRows(rows), {
									tooltip: "fit the selected rows to their tallest cell",
								}),
								action("autofit-all", "Autofit all columns", "autofitAll", () => {
									if (!host) return;
									const all: number[] = [];
									for (let c = 0; c < Math.max(host.getModel().usedRange.cols, 1); c++) all.push(c);
									host.autofitColumns(all);
								}),
								action("reset-row", "Reset row height", "reset", () => host?.resetRowHeights(rows)),
							]),
						],
					},
					{
						label: "Freeze",
						items: [
							cluster("freeze", [
								action("freeze-header", "Freeze header row", "freeze", () => host?.setFreeze(frozenRows === 1 ? 0 : 1, frozenCols), {
									active: frozenRows === 1,
									tooltip: "keep row 1 on screen while scrolling",
								}),
								action("freeze-col", "Freeze first column", "freeze", () => host?.setFreeze(frozenRows, frozenCols === 1 ? 0 : 1), {
									active: frozenCols === 1,
									tooltip: "keep column A on screen while scrolling",
								}),
								action(
									"freeze-panes",
									"Freeze panes",
									"freezePanes",
									() => {
										if (host && !host.freezeAtSelection()) new Notice("Select the cell below and to the right of what should stay on screen.");
									},
									{
										active: frozenRows > 1 || frozenCols > 1,
										tooltip: `keep everything above and left of ${host?.activeLabel() ?? "the active cell"} on screen`,
									},
								),
								action("freeze-none", "Unfreeze", "unfreeze", () => host?.setFreeze(0, 0), {
									disabled: frozenRows === 0 && frozenCols === 0,
								}),
							]),
						],
					},
					{
						label: "View",
						items: [
							cluster("zoom", [
								action("zoom-out", "Zoom out", "zoomOut", () => host?.setZoom(zoom - 0.1), { tooltip: "Ctrl+wheel or Ctrl+-" }),
								action("zoom-reset", `Zoom ${Math.round(zoom * 100)} %`, "zoomReset", () => host?.setZoom(1), {
									tooltip: "back to 100 % (Ctrl+0)",
								}),
								action("zoom-in", "Zoom in", "zoomIn", () => host?.setZoom(zoom + 0.1), { tooltip: "Ctrl+wheel or Ctrl+=" }),
							]),
							cluster("columns-visibility", [
								action("hide-cols", "Hide columns", "hide", () => host?.hideColumns(cols), {
									tooltip: "in the grid only — hidden columns are still saved",
								}),
								action("show-cols", "Show hidden columns", "show", () => host?.showAllColumns(), {
									disabled: hidden === 0,
									tooltip: hidden === 0 ? "no column is hidden" : `${hidden} hidden`,
								}),
							]),
						],
					},
					{
						label: "Table",
						items: [
							button("reformat", "Reformat", "reformat", () => void this.reformat(), {
								tooltip: settings.tableStyle === "compact" ? "rewrites the table in the note, compact" : "rewrites the table in the note with the pipes realigned",
							}),
							button(
								"shrink",
								"Shrink to data",
								"shrink",
								() => {
									if (!host) return;
									host.mutate("Shrink to data", () => shrinkToData(host.getModel()));
								},
								{ tooltip: "drops the empty rows and columns around the data" },
							),
							button("restore", "Restore a version", "restore", () => this.openRestore(), {
								tooltip: "compare the grid with an earlier version of this table",
							}),
						],
					},
				],
			},
			{
				id: "export",
				label: "Export",
				icon: "tabExport",
				groups: [
					{
						label: "Files",
						items: [
							cluster("files", [
								action("csv", "CSV", "csv", () => this.openExport("csv")),
								action("xlsx", "Excel", "excel", () => this.openExport("xlsx")),
								action("json", "JSON", "json", () => this.openExport("json")),
							]),
							button("import", "Import", "importFile", () => this.openImport(), {
								tooltip: "CSV or Excel into the grid, at the active cell",
							}),
							button("merge-file", "Merge", "mergeFile", () => this.openMerge(), {
								tooltip: "CSV or Excel merged into this table by a key column",
							}),
						],
					},
					{
						label: "Clipboard",
						items: [
							cluster("copy-as", [
								action("copy-md", "Copy as Markdown", "copyMarkdown", () => void this.copyAsMarkdown(), {
									tooltip: "the selection as a Markdown table",
								}),
								action("copy-html", "Copy as a formatted table", "html", () => void this.copyAsHtml(), {
									tooltip: "pastes as a real table into Word, email or Google Docs",
								}),
								action("copy-json", "Copy as JSON", "json", () => void this.copyAsJson()),
								action("copy-tsv", "Copy as text", "copyText", () => this.copyToClipboard(false), {
									tooltip: "the selection as tab-separated text",
								}),
							]),
						],
					},
					{
						label: "Note",
						items: [
							button("save", "Save", "save", () => void this.save(true), {
								disabled: !this.dirty,
								primary: this.dirty,
								tooltip: this.dirty ? "write the table back into the note (Ctrl+S)" : "the note already matches the grid",
							}),
							button("reload", "Reload", "reload", () => void this.confirmReload(), {
								tooltip: "take the note's version of the table",
							}),
							button("open-note", "Open the note", "note", () => void this.openSourceNote()),
						],
					},
				],
			},
		];
	}

	/* ------------------------------------------------------------- actions */

	private copyToClipboard(cut: boolean): void {
		if (!this.host) return;
		const text = cut ? this.host.cutSelection() : this.host.copySelection();
		void navigator.clipboard.writeText(text);
		new Notice(`${cut ? "Cut" : "Copied"} ${this.host.activeLabel()}`);
	}

	/**
	 * `normal` is Ctrl+V. `transposed` swaps rows and columns; `plain` drops the Markdown and keeps
	 * the text, which is what a value copied from a rendered note or a web page usually needs.
	 */
	private async pasteFromClipboard(mode: "normal" | "transposed" | "plain"): Promise<void> {
		if (!this.host) return;
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch {
			new Notice("Could not read the clipboard. Use Ctrl+V inside the grid.");
			return;
		}
		if (text === "") return;
		if (mode === "normal") {
			this.host.pasteText(text);
			return;
		}
		let values = fromMarkdownTable(text) ?? (looksLikeGrid(text) ? fromTsv(text) : [[text]]);
		if (mode === "plain") values = values.map((row) => row.map((v) => plainText(v)));
		if (mode === "transposed") values = transpose(values);
		this.host.pasteValues(values, mode === "plain" ? "Paste as text" : "Paste transposed");
	}

	private pasteSpecialMenu(): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Paste transposed").setIcon(iconName("pasteSpecial")).onClick(() => void this.pasteFromClipboard("transposed")));
		menu.addItem((i) => i.setTitle("Paste as plain text").setIcon(iconName("copyText")).onClick(() => void this.pasteFromClipboard("plain")));
		this.showMenuAtRibbon(menu);
	}

	private showMenuAtRibbon(menu: Menu): void {
		const active = asElement(this.contentEl.ownerDocument.activeElement);
		const anchor = this.contentEl.find(".mds-ribbon-panel") ?? this.contentEl;
		const box = (active && this.contentEl.contains(active) && active.tagName === "BUTTON" ? active : anchor).getBoundingClientRect();
		menu.showAtPosition({ x: box.left, y: box.bottom });
	}

	/** The selection as a model of its own, for "copy as" and selection-only exports. */
	private selectionModel(): GridModel {
		const values = this.host?.selectionValues() ?? [];
		const model = parseTable("");
		values.forEach((row, r) => row.forEach((v, c) => setRaw(model, r, c, v)));
		const rect = this.host?.getSelection().rect;
		if (rect && this.host) model.colAlign = this.host.getModel().colAlign.slice(rect.c1, rect.c1 + (values[0]?.length ?? 0));
		recomputeUsedRange(model);
		return model;
	}

	private async copyAsMarkdown(): Promise<void> {
		if (!this.host) return;
		// The real serializer, so the copied text is valid GFM rather than an approximation.
		await navigator.clipboard.writeText(this.serialize(this.selectionModel()));
		new Notice("Copied as a Markdown table.");
	}

	/** HTML for rich-text targets, with the plain TSV alongside for everything else. */
	private async copyAsHtml(): Promise<void> {
		if (!this.host) return;
		const model = this.selectionModel();
		const values = this.host.selectionValues();
		const html = toHtmlTable(values, model.colAlign, plainText);
		const win = this.contentEl.ownerDocument.win;
		try {
			const scope = win as unknown as { ClipboardItem: typeof ClipboardItem; Blob: typeof Blob };
			await navigator.clipboard.write([
				new scope.ClipboardItem({
					"text/html": new scope.Blob([html], { type: "text/html" }),
					"text/plain": new scope.Blob([this.host.copySelection()], { type: "text/plain" }),
				}),
			]);
			new Notice("Copied as a formatted table.");
		} catch {
			new Notice("Could not write a formatted table to the clipboard.");
		}
	}

	private async copyAsJson(): Promise<void> {
		if (!this.host) return;
		await navigator.clipboard.writeText(toJson(this.host.selectionValues().map((row) => row.map((v) => plainText(v)))));
		new Notice("Copied as JSON.");
	}

	/** Ctrl+K outside the editor: the selected cells' text becomes `[[text]]`, or back. */
	private linkCells(): void {
		const host = this.host;
		if (!host) return;
		const rect = host.getSelection().rect;
		const model = host.getModel();
		const cells: Array<{ row: number; col: number; raw: string }> = [];
		for (let r = rect.r1; r <= Math.min(rect.r2, model.usedRange.rows - 1); r++) {
			for (let c = rect.c1; c <= Math.min(rect.c2, model.usedRange.cols - 1); c++) {
				const raw = getRaw(model, r, c);
				if (raw.trim() !== "") cells.push({ row: r, col: c, raw });
			}
		}
		if (cells.length === 0) {
			host.beginEdit("[[]]");
			return;
		}
		const linked = /^\[\[[^\]]+\]\]$/;
		const allLinked = cells.every((c) => linked.test(c.raw.trim()));
		host.mutate(allLinked ? "Remove links" : "Make links", () => {
			for (const cell of cells) {
				const t = cell.raw.trim();
				setRaw(model, cell.row, cell.col, allLinked ? t.slice(2, -2).split("|").pop() ?? t : `[[${t}]]`);
			}
		});
	}

	private insertNow(time: boolean): void {
		const host = this.host;
		if (!host) return;
		const settings = this.plugin.sidecar.settings;
		host.setActiveValue(formatNow(time ? settings.timeFormat : settings.dateFormat));
	}

	private headers(): string[] {
		const host = this.host;
		if (!host) return [];
		const out: string[] = [];
		for (let c = 0; c < Math.max(host.getModel().usedRange.cols, 1); c++) out.push(plainText(getRaw(host.getModel(), 0, c)));
		return out;
	}

	private openGoTo(): void {
		const host = this.host;
		if (!host) return;
		new GoToModal(this.app, (text) => {
			const m = /^([A-Za-z]+)(\d+)?$/.exec(text);
			if (m) {
				const col = colIndex(m[1]);
				const row = m[2] === undefined ? host.getSelection().active.row : Number.parseInt(m[2], 10) - 1;
				if (col >= 0 && row >= 0) {
					host.goTo(row, col);
					return true;
				}
			}
			const wanted = text.toLowerCase();
			const col = this.headers().findIndex((h) => h.toLowerCase() === wanted || h.toLowerCase().startsWith(wanted));
			if (col >= 0 && wanted !== "") {
				host.goTo(host.getSelection().active.row, col);
				return true;
			}
			new Notice(`No cell or column called “${text}”.`);
			return false;
		}).open();
	}

	private openMultiSort(): void {
		const host = this.host;
		if (!host) return;
		const rect = host.getSelection().rect;
		new MultiSortModal(this.app, {
			headers: this.headers(),
			first: host.getSelection().active.col,
			hasRowSelection: rect.r2 - rect.r1 > 0,
			onSort: (keys, selectionOnly) => {
				const rows = rectRows(host.getSelection().rect).filter((r) => r > 0);
				host.mutate("Sort rows", () => sortRowsMulti(host.getModel(), host.getLayout(), keys, selectionOnly ? rows : undefined, host.numberOpts()));
			},
		}).open();
	}

	private openTextToColumns(): void {
		const host = this.host;
		if (!host) return;
		const col = host.getSelection().active.col;
		new TextPromptModal(this.app, {
			title: `Split column ${colName(col)}`,
			cta: "Split",
			name: "Separator",
			desc: "Every cell is split at this text; the pieces go into new columns to the right.",
			value: ",",
			onSubmit: (sep) => {
				if (sep === "") return false;
				let added = 0;
				host.mutate("Split into columns", () => {
					added = textToColumns(host.getModel(), host.getLayout(), col, sep);
				});
				new Notice(added === 0 ? `No cell in column ${colName(col)} contains “${sep}”.` : `Split into ${added + 1} columns.`);
			},
		}).open();
	}

	private openMergeColumns(): void {
		const host = this.host;
		if (!host) return;
		const cols = rectCols(host.getSelection().rect).filter((c) => c < host.getModel().usedRange.cols);
		new ColumnsModal(this.app, {
			title: "Merge columns",
			cta: "Merge",
			note: "The values are joined into the first chosen column and the others are deleted.",
			headers: this.headers(),
			chosen: cols.length > 1 ? cols : [],
			extra: { name: "Separator", value: " " },
			onSubmit: (chosen, sep) => {
				if (chosen.length < 2) {
					new Notice("Choose at least two columns.");
					return false;
				}
				host.mutate("Merge columns", () => mergeColumns(host.getModel(), host.getLayout(), chosen, sep));
			},
		}).open();
	}

	private openRemoveDuplicates(): void {
		const host = this.host;
		if (!host) return;
		const all = this.headers().map((_, c) => c);
		new ColumnsModal(this.app, {
			title: "Remove duplicate rows",
			cta: "Remove",
			note: "Rows that match an earlier row in the chosen columns are deleted. Undo brings them back.",
			headers: this.headers(),
			chosen: all,
			onSubmit: (chosen) => {
				if (chosen.length === 0) return false;
				let removed = 0;
				host.mutate("Remove duplicates", () => {
					removed = removeDuplicateRows(host.getModel(), host.getLayout(), chosen);
				});
				new Notice(removed === 0 ? "No duplicate rows." : `Removed ${removed} duplicate ${removed === 1 ? "row" : "rows"}.`);
			},
		}).open();
	}

	private textToolsMenu(): void {
		const host = this.host;
		if (!host) return;
		const menu = new Menu();
		const item = (title: string, kind: TextTransform) =>
			menu.addItem((i) =>
				i.setTitle(title).onClick(() => {
					const n = host.transformText(kind);
					new Notice(`Changed ${n} ${n === 1 ? "cell" : "cells"}.`);
				}),
			);
		item("Upper case", "upper");
		item("Lower case", "lower");
		item("Capitalize each word", "title");
		item("Sentence case", "sentence");
		menu.addSeparator();
		item("Trim and collapse spaces", "trim");
		item("Replace &nbsp; with spaces", "nbsp");
		this.showMenuAtRibbon(menu);
	}

	private formatValue(value: number): string {
		const settings = this.plugin.sidecar.settings;
		const decimals = this.host?.getLayout().decimals ?? settings.defaultDecimals;
		return Number.isInteger(value) ? formatNumber(value, 0, settings.numberLocale) : formatNumber(value, decimals, settings.numberLocale);
	}

	private openTotals(): void {
		const host = this.host;
		if (!host) return;
		new TotalsModal(this.app, (fn, label) => {
			let row = -1;
			host.mutate("Totals row", () => {
				row = totalsRow(host.getModel(), { fn, label, numberOpts: host.numberOpts() });
			});
			if (row >= 0) host.goTo(row, 0);
		}).open();
	}

	private openComputeColumn(): void {
		const host = this.host;
		if (!host) return;
		new ComputeColumnModal(this.app, {
			headers: this.headers(),
			target: host.getSelection().active.col,
			onSubmit: (target, expr) => {
				let result = { written: 0, errors: 0 };
				host.mutate("Compute column", () => {
					result = computeColumn(host.getModel(), target, expr, { numberOpts: host.numberOpts(), format: (v) => this.formatValue(v) });
				});
				new Notice(
					result.errors > 0
						? `Wrote ${result.written} values; ${result.errors} rows could not be computed and show an error code.`
						: `Wrote ${result.written} values into column ${colName(target)}.`,
				);
			},
		}).open();
	}

	private openNumberFormat(): void {
		const host = this.host;
		if (!host) return;
		const settings = this.plugin.sidecar.settings;
		new NumberFormatModal(this.app, {
			decimals: host.getLayout().decimals,
			locale: settings.numberLocale,
			onSubmit: (options) => {
				let n = 0;
				host.mutate("Format numbers", () => {
					n = formatNumbers(host.getModel(), host.getSelection().rect, options, host.numberOpts());
				});
				new Notice(n === 0 ? "No numbers in the selection to format." : `Formatted ${n} ${n === 1 ? "cell" : "cells"}.`);
			},
		}).open();
	}

	private openColumnStats(): void {
		const host = this.host;
		if (!host) return;
		const col = host.getSelection().active.col;
		const header = plainText(getRaw(host.getModel(), 0, col));
		new ColumnStatsModal(this.app, {
			title: header === "" ? `Column ${colName(col)}` : `${colName(col)} · ${header}`,
			stats: columnStats(host.getModel(), col, host.numberOpts()),
			locale: this.plugin.sidecar.settings.numberLocale,
			onCopy: (text) => {
				void navigator.clipboard.writeText(text);
				new Notice(`Copied ${text}`);
			},
		}).open();
	}

	/** Merge a file into this table by a key column, with the consequences shown first. */
	private openMerge(): void {
		const host = this.host;
		if (!host) return;
		const files = this.app.vault.getFiles().filter((f) => ["csv", "tsv", "xlsx"].includes(f.extension.toLowerCase()));
		new ImportModal(this.app, {
			files,
			target: "It is merged into this table by a key column.",
			onVaultFile: (file) => void this.mergeValues(file.name, () => this.app.vault.readBinary(file)),
			onDiskFile: (file) => void this.mergeValues(file.name, () => file.arrayBuffer()),
		}).open();
	}

	private async mergeValues(name: string, read: () => Promise<ArrayBuffer>): Promise<void> {
		const host = this.host;
		if (!host) return;
		let values: string[][];
		try {
			values = await readTableFile(name, await read());
		} catch (error) {
			new Notice(`Could not read ${name} — ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (values.length < 2) {
			new Notice(`${name} needs a header row and at least one row of data.`);
			return;
		}
		const model = host.getModel();
		const headers = [];
		for (let c = 0; c < Math.max(model.usedRange.cols, 1); c++) {
			const head = plainText(getRaw(model, 0, c)).trim();
			headers.push({ col: c, label: head === "" ? colName(c) : `${colName(c)} · ${head}`, name: head });
		}
		new MergeModal(this.app, {
			fileName: name,
			headers,
			rowCount: values.length - 1,
			importHeaders: values[0],
			preview: (choice) => {
				try {
					const plan = planMerge(model, values, choice);
					return {
						updated: plan.matches.length,
						added: plan.newRows.length,
						removed: choice.removeMissing ? plan.missing.length : 0,
						columns: plan.newColumns.length,
						duplicates: plan.duplicates,
					};
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			},
			apply: (choice) => {
				let result = { updated: 0, added: 0, removed: 0, columns: 0, duplicates: 0 };
				host.mutate("Merge file", () => {
					const plan = planMerge(model, values, choice);
					const applied = applyMerge(model, host.getLayout(), values, plan);
					result = { ...applied, duplicates: plan.duplicates };
				});
				return result;
			},
		}).open();
	}

	/** Import into the grid at the active cell. */
	private openImport(): void {
		const host = this.host;
		if (!host) return;
		const files = this.app.vault.getFiles().filter((f) => ["csv", "tsv", "xlsx"].includes(f.extension.toLowerCase()));
		new ImportModal(this.app, {
			files,
			target: `It is written into the grid starting at ${host.activeLabel()}.`,
			onVaultFile: (file) => void this.importValues(file.name, () => this.app.vault.readBinary(file)),
			onDiskFile: (file) => void this.importValues(file.name, () => file.arrayBuffer()),
		}).open();
	}

	private async importValues(name: string, read: () => Promise<ArrayBuffer>): Promise<void> {
		const host = this.host;
		if (!host) return;
		try {
			const values = await readTableFile(name, await read());
			if (values.length === 0) {
				new Notice("The file has no data.");
				return;
			}
			host.pasteValues(values, "Import");
			new Notice(`Imported ${values.length} rows from ${name}.`);
		} catch (error) {
			new Notice(`Could not import ${name} — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Pasted or dropped files: each is saved as an attachment, where Obsidian's settings put
	 * attachments, and linked in the cell. Nothing reaches the note until the next save.
	 */
	private async attachFiles(files: File[], row: number, col: number): Promise<void> {
		const host = this.host;
		const note = this.file;
		if (!host || !note) return;
		const links: string[] = [];
		for (const file of files) {
			const ext = file.name.includes(".") ? file.name.split(".").pop() ?? "" : (file.type.split("/")[1] ?? "bin");
			const base = file.name.includes(".") ? file.name.slice(0, file.name.lastIndexOf(".")) : `Pasted image ${formatNow("YYYYMMDDHHmmss")}`;
			const path = await this.app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, note.path);
			const created = await this.app.vault.createBinary(path, await file.arrayBuffer());
			const link = this.app.fileManager.generateMarkdownLink(created, note.path);
			links.push(file.type.startsWith("image/") && !link.startsWith("!") ? `!${link}` : link);
		}
		if (links.length > 0) host.appendToCell(row, col, links.join(" "));
	}

	/** A note dragged in from the file explorer arrives as text: its path, or an obsidian:// URL. */
	private linkDroppedText(text: string, row: number, col: number): void {
		const host = this.host;
		if (!host || !this.file) return;
		const sourcePath = this.file.path;
		const links = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.map((line) => {
				let target = line;
				const url = /^obsidian:\/\/open\?(.*)$/.exec(line);
				if (url) target = new URLSearchParams(url[1]).get("file") ?? line;
				const file =
					this.app.vault.getFileByPath(target) ??
					this.app.vault.getFileByPath(`${target}.md`) ??
					this.app.metadataCache.getFirstLinkpathDest(target.replace(/^\[\[|\]\]$/g, ""), sourcePath);
				return file ? this.app.fileManager.generateMarkdownLink(file, sourcePath) : line;
			});
		if (links.length > 0) host.appendToCell(row, col, links.join(" "));
	}

	/** Ribbon fill: the first row (or column) of the selection is the source, the rest is filled. */
	private fill(direction: "down" | "right"): void {
		const host = this.host;
		if (!host) return;
		let rect = normalizeRect(host.getSelection().rect);
		// One row (or column) selected: fill it from the one before, as Ctrl+D does in Excel. The
		// header row is never a source for data rows.
		if (direction === "down" && rect.r2 === rect.r1) {
			if (rect.r1 < 2) {
				new Notice("Select the source row together with the rows to fill.");
				return;
			}
			rect = { ...rect, r1: rect.r1 - 1 };
		}
		if (direction === "right" && rect.c2 === rect.c1) {
			if (rect.c1 < 1) {
				new Notice("Select the source column together with the columns to fill.");
				return;
			}
			rect = { ...rect, c1: rect.c1 - 1 };
		}
		const target = rect;
		const source = direction === "down" ? { ...target, r2: target.r1 } : { ...target, c2: target.c1 };
		host.mutate("Fill", () => fillRange(host.getModel(), source, target, direction, host.numberOpts()));
	}

	private sort(ascending: boolean): void {
		const host = this.host;
		if (!host) return;
		const rect = host.getSelection().rect;
		// A range of several data rows sorts just those rows; anything else sorts the whole table.
		const rows = rectRows(rect).filter((r) => r > 0 && r < host.getModel().usedRange.rows);
		const wholeColumn = rect.r1 === 0 && rows.length >= host.getModel().usedRange.rows - 1;
		host.sortByColumn(host.getSelection().active.col, ascending, wholeColumn ? undefined : rows);
	}

	private openFilterDialog(): void {
		if (!this.host) return;
		const host = this.host;
		new FilterModal(this.app, {
			model: host.getModel(),
			current: host.getFilters(),
			onApply: (filters) => {
				host.setFilters(filters);
				this.refreshStatus();
				this.refreshRibbon();
			},
		}).open();
	}

	private openFindReplace(): void {
		if (!this.host) return;
		const host = this.host;
		new FindReplaceModal(this.app, {
			onFind: (options: FindOptions) => findAll(host.getModel(), options).length,
			onFindNext: (options: FindOptions) => {
				const matches = findAll(host.getModel(), options);
				if (matches.length === 0) return null;
				// Row-major order from the active cell, wrapping at the end like every editor does.
				const { row, col } = host.getSelection().active;
				const index = matches.findIndex((m) => m.row > row || (m.row === row && m.col > col));
				const next = index === -1 ? 0 : index;
				host.goTo(matches[next].row, matches[next].col);
				return { index: next + 1, count: matches.length };
			},
			onReplaceAll: (options, replacement) => {
				let count = 0;
				host.mutate("Replace", () => {
					count = replaceAll(host.getModel(), options, replacement);
				});
				return count;
			},
		}).open();
	}

	private openCalculate(): void {
		if (!this.host) return;
		const host = this.host;
		const settings = this.plugin.sidecar.settings;
		const agg = aggregate(host.getModel(), host.getSelection().rect, host.numberOpts());
		new CalculateModal(this.app, {
			aggregate: agg,
			decimals: host.getLayout().decimals,
			locale: settings.numberLocale,
			rangeLabel: host.activeLabel(),
			onPlace: (fn, text) => {
				this.lastCalc = { fn, text };
				host.beginCalcPlacement(fn, text);
				this.refreshRibbon();
			},
			onCopy: (text) => {
				void navigator.clipboard.writeText(text);
				new Notice(`Copied ${text}`);
			},
		}).open();
	}

	/**
	 * "Recalculate last" (§12).
	 *
	 * Deliberately in-memory only and gone when the tab closes: recording provenance would mean
	 * writing something into the note that GFM cannot express (D2).
	 */
	private recalculateLast(): void {
		const host = this.host;
		if (!host || !this.lastCalc) return;
		const fn = this.lastCalc.fn;
		const agg = aggregate(host.getModel(), host.getSelection().rect, host.numberOpts());
		const value = applyFunction(agg, fn);
		if (value === null) {
			new Notice("This selection has no numeric cells to calculate from.");
			return;
		}
		const text = formatResult(fn, value, host.getLayout().decimals, this.plugin.sidecar.settings.numberLocale);
		this.lastCalc = { fn, text };
		host.beginCalcPlacement(fn, text);
		this.refreshRibbon();
	}

	private async reformat(): Promise<void> {
		if (!this.host) return;
		// Serializing and writing is the reformat: the serializer is the single definition of
		// what a well-formed table looks like (§6).
		this.dirty = true;
		await this.save(true);
		new Notice("The table was rewritten with the pipes realigned.");
	}

	private openRestore(): void {
		new RestoreModal(this.app, {
			backups: this.plugin.sidecar.getBackups(this.layoutKey),
			current: this.host ? this.serialize(this.host.getModel()) : "",
			now: Date.now(),
			onRestore: (entry) => {
				if (!this.host) return;
				const before = this.host.getModel();
				const after = parseTable(entry.text);
				this.host.replaceData(after, this.host.getLayout());
				// Show which cells the restore changed, until the next edit.
				const changed: Array<{ row: number; col: number }> = [];
				const rows = Math.max(before.usedRange.rows, after.usedRange.rows);
				const cols = Math.max(before.usedRange.cols, after.usedRange.cols);
				for (let r = 0; r < rows; r++) {
					for (let c = 0; c < cols; c++) if (getRaw(before, r, c) !== getRaw(after, r, c)) changed.push({ row: r, col: c });
				}
				this.host.highlightCells(changed);
				this.markDirty();
				new Notice(`Restored into the grid — ${changed.length} ${changed.length === 1 ? "cell differs" : "cells differ"}, highlighted. Save to write it to the note.`);
			},
		}).open();
	}

	private async confirmReload(): Promise<void> {
		if (!this.dirty) {
			await this.reloadFromNote(true);
			return;
		}
		new ConfirmModal(this.app, {
			title: "Discard unsaved changes?",
			body: "The grid has changes that are not in the note yet. Reloading throws them away.",
			cta: "Discard and reload",
			warning: true,
			onConfirm: () => void this.reloadFromNote(true),
		}).open();
	}

	private async openSourceNote(): Promise<void> {
		if (!this.file) return;
		await this.app.workspace.getLeaf("tab").openFile(this.file);
	}

	/* --------------------------------------------------------------- export */

	private csvDefaults(): CsvOptions {
		const settings = this.plugin.sidecar.settings;
		return {
			delimiter: settings.csvDelimiter,
			bom: settings.csvBom,
			content: "raw",
			crlf: true,
		};
	}

	private defaultExportName(ext: string): string {
		const base = this.file?.basename ?? "table";
		return `${base}.${ext}`;
	}

	private openExport(format: "csv" | "xlsx" | "json"): void {
		const host = this.host;
		if (!host) return;
		const rect = host.getSelection().rect;
		new ExportModal(this.app, {
			format,
			defaultName: this.defaultExportName(format),
			csvDefaults: this.csvDefaults(),
			hasSelection: rect.r1 !== rect.r2 || rect.c1 !== rect.c2,
			onExport: (choice) => {
				const model = choice.selectionOnly ? this.selectionModel() : host.getModel();
				if (format === "csv") void this.exportCsv(model, choice.csv, choice.fileName);
				else if (format === "json") void this.exportJson(model, choice.csv.content, choice.fileName);
				else void this.exportXlsx(model, choice.csv.content, choice.xlsxDetectNumbers, choice.fileName);
			},
		}).open();
	}

	private async exportJson(model: GridModel, content: "raw" | "plain", fileName: string): Promise<void> {
		const path = await this.targetPath(fileName.endsWith(".json") ? fileName : `${fileName}.json`);
		const values: string[][] = [];
		for (let r = 0; r < model.usedRange.rows; r++) {
			const row: string[] = [];
			for (let c = 0; c < model.usedRange.cols; c++) {
				const raw = getRaw(model, r, c);
				row.push(content === "plain" ? plainText(raw) : raw);
			}
			values.push(row);
		}
		await this.app.vault.create(path, toJson(values) + "\n");
		new Notice(`Wrote ${path}`);
	}

	private async targetPath(fileName: string): Promise<string> {
		const settings = this.plugin.sidecar.settings;
		const folder = settings.exportFolder !== "" ? settings.exportFolder : (this.file?.parent?.path ?? "");
		const safe = fileName.replace(/[\\/:*?"<>|]/g, "-").trim() || "table";
		// `normalizePath` is what the review guidelines ask for on any path built from a setting:
		// it strips a leading slash, collapses doubles and normalizes the unicode form.
		const target = folder === "" || folder === "/" ? safe : normalizePath(`${folder}/${safe}`);
		if (folder !== "" && folder !== "/") {
			const dir = normalizePath(folder);
			if (!this.app.vault.getFolderByPath(dir)) await this.app.vault.createFolder(dir);
		}
		return this.uniquePath(target);
	}

	/** Never overwrite an existing export; add a counter instead. */
	private uniquePath(path: string): string {
		if (!this.app.vault.getFileByPath(path)) return path;
		const dot = path.lastIndexOf(".");
		const stem = dot === -1 ? path : path.slice(0, dot);
		const ext = dot === -1 ? "" : path.slice(dot);
		for (let i = 2; i < 1000; i++) {
			const candidate = `${stem} ${i}${ext}`;
			if (!this.app.vault.getFileByPath(candidate)) return candidate;
		}
		return `${stem} ${Date.now()}${ext}`;
	}

	private async exportCsv(model: GridModel, options: CsvOptions, fileName: string): Promise<void> {
		const path = await this.targetPath(fileName.endsWith(".csv") ? fileName : `${fileName}.csv`);
		await this.app.vault.createBinary(path, csvBytes(model, options));
		new Notice(`Wrote ${path}`);
	}

	private async exportXlsx(model: GridModel, content: "raw" | "plain", detectNumbers: boolean, fileName: string): Promise<void> {
		if (!this.host) return;
		const path = await this.targetPath(fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`);
		const buffer = xlsxBuffer(
			model,
			{
				...DEFAULT_XLSX_OPTIONS,
				sheetName: this.file?.basename ?? "Table",
				content,
				detectNumbers,
				numberOpts: this.host.numberOpts(),
				layout: this.host.getLayout(),
				defaultColWidth: this.plugin.sidecar.settings.defaultColWidth,
			},
			new Date(),
		);
		await this.app.vault.createBinary(path, buffer);
		new Notice(`Wrote ${path}`);
	}

	/* ------------------------------------------------- plugin-facing surface */

	/** The note this tab is editing, so a command can tell whether it is already open. */
	currentPath(): string | null {
		return this.file?.path ?? null;
	}

	currentAnchor(): Anchor | null {
		return this.anchor;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	/** The whole table as GFM, for the `Copy table as Markdown` command. */
	fullMarkdown(): string {
		return this.host ? this.serialize(this.host.getModel()) : "";
	}

	/** Command entry point for `Restore previous version`. */
	openRestoreDialog(): void {
		this.openRestore();
	}

	/** Command entry point for the save action, so it works without focus in the grid. */
	saveNow(): Promise<void> {
		return this.save(true);
	}
}
