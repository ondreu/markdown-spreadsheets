import {
	ItemView,
	Notice,
	Scope,
	TFile,
	setIcon,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { density, filledCount, getRaw, shrinkToData, type Align, type GridModel } from "../model/GridModel";
import { parseTable } from "../model/parse";
import { serializeTable } from "../model/serialize";
import { anchorFromRegion, anchorKey, newBlockId, resolveAnchor, type Anchor } from "../file/AnchorResolver";
import { regionHash, Writer } from "../file/Writer";
import type { TableRegion } from "../file/scanTables";
import { defaultLayout, type TableLayout } from "../store/Sidecar";
import { aggregate, applyFunction, formatResult, summaryLine, type CalcFunction } from "../feature/QuickCalc";
import { csvBytes, type CsvOptions } from "../feature/exportCsv";
import { DEFAULT_XLSX_OPTIONS, xlsxBuffer } from "../feature/exportXlsx";
import { fillRange, findAll, normalizeRect, rectCols, rectRows, replaceAll, sortRows, type FindOptions } from "../feature/ops";
import type MarkdownGridPlugin from "../main";
import { asElement, asNode } from "./dom";
import { MAX_COL_WIDTH, MAX_ROW_HEIGHT, MIN_COL_WIDTH, MIN_ROW_HEIGHT, VIEW_TYPE_GRID } from "./constants";
import { GridHost, type Selection } from "./GridHost";
import { Ribbon, type RibbonItem, type RibbonTab } from "./Ribbon";
import { StatusBar } from "./StatusBar";
import {
	CalculateModal,
	ConfirmModal,
	DensityModal,
	DiffModal,
	ExportModal,
	FilterModal,
	FindReplaceModal,
	RestoreModal,
	SortModal,
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
	private readonly ribbon = new Ribbon(() => this.refreshRibbon());
	private readonly statusBar = new StatusBar();
	private readonly writer: Writer;

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

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: MarkdownGridPlugin,
	) {
		super(leaf);
		this.writer = new Writer(this.app.vault);
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
		if (!this.file) return "Grid";
		return `${this.file.basename} — grid`;
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
		this.contentEl.addClass("markdown-grid-view");
		this.ribbon.mount(this.contentEl);
		this.buildFormulaBar();
		this.bannerEl = this.contentEl.createDiv({ cls: "mg-banner mg-hidden" });
		this.bodyEl = this.contentEl.createDiv({ cls: "mg-body" });
		this.statusBar.mount(this.contentEl, () => void this.save(true));
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
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		// Last chance to persist; the tab is going away either way.
		if (this.dirty && this.plugin.sidecar.settings.saveMode === "auto") await this.save(true);
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
			new TablePickerModal(this.app, resolution.candidates, (picked) => {
				void this.adoptRegion(picked.region, failures);
			}).open();
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

		const model = parseTable(region.text);
		const stored = this.plugin.sidecar.getLayout(this.layoutKey);
		const layout: TableLayout = Object.assign({}, defaultLayout(this.plugin.sidecar.settings), stored);
		this.plugin.sidecar.setAnchor(this.layoutKey, this.anchor);
		this.plugin.sidecar.pushBackup(this.layoutKey, region.text, Date.now());

		this.mountHost(model, layout);
		this.dirty = false;
		this.hideBanner();
		this.refreshRibbon();
		this.refreshStatus();

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
				callbacks: {
					onDirty: () => this.markDirty(),
					onLayoutChange: () => this.persistLayout(),
					onSelectionChange: (selection) => this.onSelectionChange(selection),
					onNotice: (message) => new Notice(message),
					onCalcPlaced: () => this.refreshRibbon(),
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
		const blockText = serializeTable(this.host.getModel()).replace(/\n+$/, "");
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
			this.showMissing(serializeTable(this.host.getModel()));
			return;
		}
		if (resolution.kind === "ambiguous") return;

		const region = resolution.region;
		const hash = regionHash(region.text);
		// The anchor may have shifted because the user edited text above the table. Silent.
		this.anchor = anchorFromRegion(this.file.path, region);
		this.plugin.sidecar.setAnchor(anchorKey(this.anchor), this.anchor);

		if (hash === this.expectedHash) return;

		if (this.dirty) {
			// Two sets of edits to the same lines. Only the user can decide (§13.2).
			this.showConflict(serializeTable(this.host.getModel()).replace(/\n+$/, ""), region.text);
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
		this.anchor = anchorFromRegion(this.file.path, region);
		this.layoutKey = anchorKey(this.anchor);
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
		await this.exportCsv(this.csvDefaults(), this.defaultExportName("csv"));
		this.dirty = false;
		this.leaf.detach();
	}

	/* --------------------------------------------------------------- banner */

	private showBanner(message: string, actions: BannerAction[]): void {
		this.bannerEl.empty();
		this.bannerEl.removeClass("mg-hidden");
		const icon = this.bannerEl.createSpan({ cls: "mg-banner-icon" });
		setIcon(icon, "alert-triangle");
		this.bannerEl.createSpan({ cls: "mg-banner-text", text: message });
		const buttons = this.bannerEl.createDiv({ cls: "mg-banner-actions" });
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
		this.bannerEl.addClass("mg-hidden");
	}

	/* ---------------------------------------------------------- formula bar */

	private buildFormulaBar(): void {
		const bar = this.contentEl.createDiv({ cls: "mg-formulabar" });
		this.formulaAddressEl = bar.createDiv({ cls: "mg-formula-address", text: "A1" });
		this.formulaInputEl = bar.createEl("input", {
			cls: "mg-formula-input",
			attr: { type: "text", placeholder: "Cell contents as Markdown", spellcheck: "false" },
		});
		this.formulaInputEl.addEventListener("keydown", (evt) => {
			evt.stopPropagation();
			if (evt.key === "Enter") {
				this.host?.setActiveValue(this.formulaInputEl.value);
				this.host?.focus();
				this.host?.moveActive(1, 0);
			} else if (evt.key === "Escape") {
				this.syncFormulaBar();
				this.host?.focus();
			}
		});
		this.formulaInputEl.addEventListener("blur", () => {
			this.host?.setActiveValue(this.formulaInputEl.value);
		});
	}

	private syncFormulaBar(): void {
		if (!this.host) return;
		const { active } = this.host.getSelection();
		this.formulaAddressEl.setText(this.host.activeLabel());
		this.formulaInputEl.value = getRaw(this.host.getModel(), active.row, active.col);
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
		if (this.host.getGeometryMode() === "inline") hints.push("Row sizing uses the fallback path");
		this.statusBar.update({
			address: this.host.activeLabel(),
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
		if (active.hasClass("mg-editor")) return true;
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
		bind([], "Home", () => this.host?.jumpToEdge(0, -1));
		bind([], "End", () => this.host?.jumpToEdge(0, 1));
		bind(["Mod"], "Home", () => this.host?.setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 }, { row: 0, col: 0 }));
		bind(["Mod"], "a", () => this.host?.selectAll());
		bind(["Mod"], "z", () => this.host?.undoLast());
		bind(["Mod", "Shift"], "z", () => this.host?.redoLast());
		bind(["Mod"], "y", () => this.host?.redoLast());
		bind(["Mod"], "s", () => void this.save(true));
		bind(["Mod"], "b", () => this.host?.format("bold"));
		bind(["Mod"], "i", () => this.host?.format("italic"));

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
		const host = this.host;
		const settings = this.plugin.sidecar.settings;
		const button = (
			id: string,
			label: string,
			icon: string,
			onClick: () => void,
			extra?: { tooltip?: string; disabled?: boolean; active?: boolean },
		): RibbonItem => ({
			kind: "button",
			action: {
				id,
				label,
				icon,
				onClick,
				...(extra?.tooltip === undefined ? {} : { tooltip: extra.tooltip }),
				...(extra?.disabled === undefined ? {} : { disabled: extra.disabled }),
				...(extra?.active === undefined ? {} : { active: extra.active }),
			},
		});

		const rect = host?.getSelection().rect ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
		const cols = host ? rectCols(rect) : [0];
		const rows = host ? rectRows(rect) : [0];
		const headerOnly = rect.r1 === 0 && rect.r2 === 0;
		const wrapped = host ? cols.every((c) => host.getLayout().wrapCols.includes(c)) : false;

		const tabs: RibbonTab[] = [
			{
				id: "home",
				label: "Home",
				groups: [
					{
						label: "Clipboard",
						items: [
							button("copy", "Copy", "copy", () => this.copyToClipboard(false), { tooltip: "Copy the selection as tab-separated text (Ctrl+C)" }),
							button("cut", "Cut", "scissors", () => this.copyToClipboard(true), { tooltip: "Cut the selection (Ctrl+X)" }),
							button("paste", "Paste", "clipboard-paste", () => void this.pasteFromClipboard(), { tooltip: "Paste tab-separated text (Ctrl+V)" }),
							{ kind: "separator" },
							button("undo", "Undo", "undo-2", () => host?.undoLast(), {
								disabled: !host?.undo.canUndo(),
								tooltip: host?.undo.undoLabel() ? `Undo ${host.undo.undoLabel()?.toLowerCase()}` : "Nothing to undo",
							}),
							button("redo", "Redo", "redo-2", () => host?.redoLast(), {
								disabled: !host?.undo.canRedo(),
								tooltip: host?.undo.redoLabel() ? `Redo ${host.undo.redoLabel()?.toLowerCase()}` : "Nothing to redo",
							}),
						],
					},
					{
						label: "Cells",
						items: [
							button("row-above", "Insert row above", "between-vertical-start", () => host?.insertRowsAt("above"), {
								disabled: headerOnly,
								tooltip: headerOnly ? "Row 1 is the table header, so nothing can go above it" : undefined,
							}),
							button("row-below", "Insert row below", "between-vertical-end", () => host?.insertRowsAt("below")),
							button("row-delete", "Delete row", "trash-2", () => host?.deleteSelectedRows(), {
								disabled: headerOnly,
								tooltip: headerOnly ? "Markdown tables require a header row" : undefined,
							}),
							{ kind: "separator" },
							button("col-left", "Insert column left", "between-horizontal-start", () => host?.insertColsAt("left")),
							button("col-right", "Insert column right", "between-horizontal-end", () => host?.insertColsAt("right")),
							button("col-delete", "Delete column", "trash-2", () => host?.deleteSelectedCols()),
							{ kind: "separator" },
							button("row-up", "Move row up", "arrow-up", () => host?.moveSelectedRow(-1), { disabled: rect.r1 !== rect.r2 || rect.r1 <= 1 }),
							button("row-down", "Move row down", "arrow-down", () => host?.moveSelectedRow(1), { disabled: rect.r1 !== rect.r2 || rect.r1 === 0 }),
							button("col-left-move", "Move column left", "arrow-left", () => host?.moveSelectedCol(-1), { disabled: rect.c1 !== rect.c2 || rect.c1 === 0 }),
							button("col-right-move", "Move column right", "arrow-right", () => host?.moveSelectedCol(1), { disabled: rect.c1 !== rect.c2 }),
						],
					},
					{
						label: "Alignment",
						items: (["left", "center", "right"] as const).map((align) =>
							button(
								`align-${align}`,
								align === "left" ? "Align left" : align === "center" ? "Align centre" : "Align right",
								align === "left" ? "align-left" : align === "center" ? "align-center" : "align-right",
								() => host?.setAlignment(align),
								{
									// GFM stores alignment per column, never per cell (§3).
									tooltip: `Applies to the whole column — Markdown has no per-cell alignment`,
									active: host ? cols.every((c) => host.getModel().colAlign[c] === align) : false,
								},
							),
						).concat([
							button("align-none", "Default alignment", "remove-formatting", () => host?.setAlignment(null as Align), {
								tooltip: "Removes the alignment marker from the column",
							}),
						]),
					},
					{
						label: "Format",
						items: [
							button("bold", "Bold", "bold", () => host?.format("bold"), { tooltip: "Wraps the cell in ** (Ctrl+B)" }),
							button("italic", "Italic", "italic", () => host?.format("italic"), { tooltip: "Wraps the cell in * (Ctrl+I)" }),
							button("code", "Code", "code", () => host?.format("code"), { tooltip: "Wraps the cell in backticks" }),
							button("strike", "Strikethrough", "strikethrough", () => host?.format("strikethrough")),
							{ kind: "separator" },
							button("wrap", "Wrap text", "wrap-text", () => host?.toggleWrap(cols), {
								active: wrapped,
								tooltip: "Visual only — the cell stays a single line of Markdown",
							}),
							button(
								"render",
								host?.getRenderMode() === "rendered" ? "Show raw" : "Show rendered",
								host?.getRenderMode() === "rendered" ? "file-code-2" : "eye",
								() => {
									host?.setRenderMode(host.getRenderMode() === "rendered" ? "raw" : "rendered");
									this.refreshRibbon();
								},
								{ tooltip: "Rendered mode formats each visible cell, which costs a Markdown render per cell" },
							),
						],
					},
				],
			},
			{
				id: "data",
				label: "Data",
				groups: [
					{
						label: "Sort",
						items: [
							button("sort-asc", "Sort ascending", "arrow-down-a-z", () => this.sort(true)),
							button("sort-desc", "Sort descending", "arrow-up-z-a", () => this.sort(false)),
							button("sort-dialog", "Sort by…", "list-ordered", () => this.openSortDialog()),
						],
					},
					{
						label: "Filter",
						items: [
							button("filter", "Filter", "filter", () => this.openFilterDialog(), {
								active: (host?.getFilters().length ?? 0) > 0,
								tooltip: "Hides rows in the grid only — the note keeps every row",
							}),
							button("filter-clear", "Clear filter", "filter-x", () => {
								host?.setFilters([]);
								this.refreshStatus();
								this.refreshRibbon();
							}, { disabled: (host?.getFilters().length ?? 0) === 0 }),
						],
					},
					{
						label: "Editing",
						items: [
							button("find", "Find and replace", "search", () => this.openFindReplace()),
							button("fill-down", "Fill down", "arrow-down-to-line", () => this.fill("down")),
							button("fill-right", "Fill right", "arrow-right-to-line", () => this.fill("right")),
							button("clear", "Clear contents", "eraser", () => host?.clearSelectionContents()),
						],
					},
					{
						label: "Calculate",
						items: [
							button("calc", "Calculate", "sigma", () => this.openCalculate(), {
								tooltip: "Inserts a one-off value — Markdown has no live formulas",
							}),
							button("calc-again", "Recalculate last", "rotate-ccw", () => this.recalculateLast(), {
								disabled: this.lastCalc === null,
								tooltip: this.lastCalc ? `Recompute ${this.lastCalc.fn} over the current selection` : "Nothing calculated yet in this tab",
							}),
						],
					},
				],
			},
			{
				id: "table",
				label: "Table",
				groups: [
					{
						label: "Size",
						items: [
							{
								kind: "number",
								id: "colw",
								label: "Column width",
								value: host?.getLayout().colWidths[rect.c1] || settings.defaultColWidth,
								min: MIN_COL_WIDTH,
								max: MAX_COL_WIDTH,
								tooltip: "Applies to every selected column. Stored outside the note.",
								onCommit: (value) => host?.setColumnWidth(cols, value),
							},
							{
								kind: "number",
								id: "rowh",
								label: "Row height",
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
							button("autofit-col", "Autofit columns", "move-horizontal", () => host?.autofitColumns(cols)),
							button("autofit-row", "Autofit rows", "move-vertical", () => host?.autofitRows(rows)),
							button("autofit-all", "Autofit all columns", "maximize-2", () => {
								if (!host) return;
								const all: number[] = [];
								for (let c = 0; c < Math.max(host.getModel().usedRange.cols, 1); c++) all.push(c);
								host.autofitColumns(all);
							}),
							button("reset-row", "Reset row height", "rotate-ccw", () => host?.resetRowHeights(rows)),
						],
					},
					{
						label: "Freeze",
						items: [
							button("freeze-header", "Freeze header row", "pin", () => host?.setFreeze(1, host.getLayout().frozenCols), {
								active: host?.getLayout().frozenRows === 1,
							}),
							button("freeze-none", "Unfreeze", "pin-off", () => host?.setFreeze(0, 0), {
								disabled: (host?.getLayout().frozenRows ?? 0) === 0 && (host?.getLayout().frozenCols ?? 0) === 0,
							}),
							button("freeze-col", "Freeze first column", "pin", () => host?.setFreeze(host.getLayout().frozenRows, 1), {
								active: (host?.getLayout().frozenCols ?? 0) >= 1,
							}),
						],
					},
					{
						label: "Table",
						items: [
							button("info", "Used range", "info", () => new Notice(host?.usedRangeLabel() ?? ""), {
								tooltip: host?.usedRangeLabel(),
							}),
							button("reformat", "Reformat", "align-justify", () => void this.reformat(), {
								tooltip: "Rewrites the table in the note with the pipes realigned",
							}),
							button("shrink", "Shrink to data", "minimize-2", () => {
								if (!host) return;
								host.mutate("Shrink to data", () => shrinkToData(host.getModel()));
							}, { tooltip: "Drops the empty rows and columns around the data" }),
							button("restore", "Restore a previous version", "history", () => this.openRestore()),
						],
					},
				],
			},
			{
				id: "export",
				label: "Export",
				groups: [
					{
						label: "Files",
						items: [
							button("csv", "CSV", "file-spreadsheet", () => this.openExport("csv")),
							button("xlsx", "Excel", "file-spreadsheet", () => this.openExport("xlsx")),
						],
					},
					{
						label: "Clipboard",
						items: [
							button("copy-md", "Copy as Markdown", "clipboard-copy", () => void this.copyAsMarkdown()),
							button("copy-tsv", "Copy as text", "clipboard-list", () => this.copyToClipboard(false)),
						],
					},
					{
						label: "Note",
						items: [
							button("save", "Save to the note", "save", () => void this.save(true), {
								disabled: !this.dirty,
								tooltip: this.dirty ? "Write the table back into the note" : "The note already matches the grid",
							}),
							button("reload", "Reload from the note", "refresh-cw", () => void this.confirmReload()),
							button("open-note", "Open the note", "file-text", () => void this.openSourceNote()),
						],
					},
				],
			},
		];

		this.ribbon.setTabs(tabs);
	}

	/* ------------------------------------------------------------- actions */

	private copyToClipboard(cut: boolean): void {
		if (!this.host) return;
		const text = cut ? this.host.cutSelection() : this.host.copySelection();
		void navigator.clipboard.writeText(text);
		new Notice(`${cut ? "Cut" : "Copied"} ${this.host.activeLabel()}`);
	}

	private async pasteFromClipboard(): Promise<void> {
		if (!this.host) return;
		try {
			const text = await navigator.clipboard.readText();
			if (text !== "") this.host.pasteText(text);
		} catch {
			new Notice("Could not read the clipboard. Use Ctrl+V inside the grid.");
		}
	}

	private async copyAsMarkdown(): Promise<void> {
		if (!this.host) return;
		const values = this.host.selectionAsMarkdown();
		// Reuse the real serializer so the copied text is valid GFM, not an approximation.
		const model = parseTable(values.map((row) => `| ${row.map((v) => v.split("|").join("\\|")).join(" | ")} |`).join("\n"));
		const text = serializeTable(model);
		await navigator.clipboard.writeText(text);
		new Notice("Copied as a Markdown table.");
	}

	/** Ribbon fill: the first row (or column) of the selection is the source, the rest is filled. */
	private fill(direction: "down" | "right"): void {
		const host = this.host;
		if (!host) return;
		const rect = normalizeRect(host.getSelection().rect);
		if (direction === "down" && rect.r2 <= rect.r1) {
			new Notice("Select the source row together with the rows to fill.");
			return;
		}
		if (direction === "right" && rect.c2 <= rect.c1) {
			new Notice("Select the source column together with the columns to fill.");
			return;
		}
		const source = direction === "down" ? { ...rect, r2: rect.r1 } : { ...rect, c2: rect.c1 };
		host.mutate("Fill", () => fillRange(host.getModel(), source, rect, direction, host.numberOpts()));
	}

	private sort(ascending: boolean): void {
		if (!this.host) return;
		const host = this.host;
		const rect = host.getSelection().rect;
		const rows = rectRows(rect).filter((r) => r > 0);
		host.mutate("Sort rows", () =>
			sortRows(
				host.getModel(),
				host.getLayout(),
				{ col: rect.c1, ascending, ...(rows.length > 1 ? { rows } : {}) },
				host.numberOpts(),
			),
		);
		this.persistLayout();
	}

	private openSortDialog(): void {
		if (!this.host) return;
		const host = this.host;
		const rect = host.getSelection().rect;
		new SortModal(this.app, {
			model: host.getModel(),
			defaultCol: rect.c1,
			hasMultiRowSelection: rect.r2 - rect.r1 > 0,
			onSort: (col, ascending, selectionOnly) => {
				const rows = rectRows(host.getSelection().rect).filter((r) => r > 0);
				host.mutate("Sort rows", () =>
					sortRows(
						host.getModel(),
						host.getLayout(),
						{ col, ascending, ...(selectionOnly && rows.length > 1 ? { rows } : {}) },
						host.numberOpts(),
					),
				);
				this.persistLayout();
			},
		}).open();
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
			onRestore: (entry) => {
				if (!this.host) return;
				this.host.replaceData(parseTable(entry.text), this.host.getLayout());
				this.markDirty();
				new Notice("Restored into the grid. Save to write it to the note.");
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

	private openExport(format: "csv" | "xlsx"): void {
		if (!this.host) return;
		new ExportModal(this.app, {
			format,
			defaultName: this.defaultExportName(format),
			csvDefaults: this.csvDefaults(),
			onExport: (choice) => {
				if (format === "csv") void this.exportCsv(choice.csv, choice.fileName);
				else void this.exportXlsx(choice.csv.content, choice.xlsxDetectNumbers, choice.fileName);
			},
		}).open();
	}

	private async targetPath(fileName: string): Promise<string> {
		const settings = this.plugin.sidecar.settings;
		const folder = settings.exportFolder !== "" ? settings.exportFolder : (this.file?.parent?.path ?? "");
		const safe = fileName.replace(/[\\/:*?"<>|]/g, "-").trim() || "table";
		const base = folder === "" || folder === "/" ? safe : `${folder}/${safe}`;
		if (folder !== "" && folder !== "/" && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
		return this.uniquePath(base);
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

	private async exportCsv(options: CsvOptions, fileName: string): Promise<void> {
		if (!this.host) return;
		const path = await this.targetPath(fileName.endsWith(".csv") ? fileName : `${fileName}.csv`);
		await this.app.vault.createBinary(path, csvBytes(this.host.getModel(), options));
		new Notice(`Wrote ${path}`);
	}

	private async exportXlsx(content: "raw" | "plain", detectNumbers: boolean, fileName: string): Promise<void> {
		if (!this.host) return;
		const path = await this.targetPath(fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`);
		const buffer = xlsxBuffer(
			this.host.getModel(),
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
		return this.host ? serializeTable(this.host.getModel()) : "";
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
