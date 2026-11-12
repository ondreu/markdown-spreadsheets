import {
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TFile,
	setTooltip,
	type Editor,
	type MarkdownFileInfo,
	type MarkdownPostProcessorContext,
	type Menu,
} from "obsidian";
import { anchorFromRegion, regionAtLine, type Anchor } from "./file/AnchorResolver";
import { scanTables } from "./file/scanTables";
import { MarkdownSpreadsheetsSettingTab } from "./view/SettingTab";
import { Sidecar } from "./store/Sidecar";
import { VIEW_TYPE_GRID } from "./view/constants";
import { GridView, type GridViewState } from "./view/GridView";
import { PivotView, VIEW_TYPE_PIVOT } from "./view/PivotView";
import { TablePickerModal } from "./view/modals";
import { GRID_COMMANDS } from "./view/gridCommands";
import { ImportModal, InsertTableModal, pickSheets, TableIndexModal, type SheetChoice, type VaultTable } from "./view/toolModals";
import { Writer } from "./file/Writer";
import { FormulaWatcher } from "./file/FormulaWatcher";
import { parseTable } from "./model/parse";
import { serializeTable } from "./model/serialize";
import { setRaw, createModel, recomputeUsedRange, type Align } from "./model/GridModel";
import { readTableBook } from "./feature/tableFile";
import { countFormulas, formulaTotal, sheetToValues, type FormulaSheet } from "./feature/importFormula";
import { valuesToModel } from "./feature/importTable";
import { iconName, setIconSafe } from "./view/icons";
import { livePreviewTableButton } from "./view/livePreviewButton";

export default class MarkdownSpreadsheetsPlugin extends Plugin {
	sidecar!: Sidecar;
	private statusBarEl: HTMLElement | null = null;
	private formulaWatcher: FormulaWatcher | null = null;

	override async onload(): Promise<void> {
		this.sidecar = new Sidecar(this);
		await this.sidecar.load();

		this.registerView(VIEW_TYPE_GRID, (leaf) => new GridView(leaf, this));
		// A pivot is a leaf of its own: read-only, belongs to no note, disappears when closed.
		this.registerView(VIEW_TYPE_PIVOT, (leaf) => new PivotView(leaf, this));
		// Ctrl-hover on a link in a rendered cell shows Obsidian's page preview, as in a note.
		this.registerHoverLinkSource(VIEW_TYPE_GRID, { display: "Markdown Spreadsheets", defaultMod: true });
		this.addSettingTab(new MarkdownSpreadsheetsSettingTab(this.app, this));

		// Persistent selection aggregate, Excel style (§12).
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("markdown-spreadsheets-status");

		// The left sidebar route, next to the command palette and the two context menus (§11).
		this.addRibbonIcon(iconName("launcher"), "Open table as a spreadsheet", () => {
			const info = this.activeMarkdownInfo();
			if (info) {
				void this.openFromEditor(info.editor, info.file);
				return;
			}
			const file = this.app.workspace.getActiveFile();
			if (file && file.extension === "md") {
				void this.openFirstTable(file);
				return;
			}
			new Notice("Open a note with a table first.");
		});

		// Live Preview, where tables are edited: a button on Obsidian's own table widget.
		this.registerEditorExtension(
			livePreviewTableButton({
				enabled: () => this.sidecar.settings.showTableButton,
				open: (file, text, line) => {
					const region = regionAtLine(text, line);
					if (region) void this.openRegion(file, anchorFromRegion(file.path, region));
					else void this.openFirstTable(file);
				},
			}),
		);
		// Reading view only on request: it is also the path PDF export and embeds render through.
		this.registerMarkdownPostProcessor((el, ctx) => this.decorateTables(el, ctx));

		// No default hotkeys: `no-default-hotkeys` (§15.2). In-view keys live in the view's Scope.
		this.addCommand({
			id: "open-table-in-grid",
			name: "Open table as a spreadsheet",
			checkCallback: (checking) => {
				const info = this.activeMarkdownInfo();
				if (!info) return false;
				if (checking) return true;
				void this.openFromEditor(info.editor, info.file);
				return true;
			},
		});

		this.addCommand({
			id: "open-first-table-in-grid",
			name: "Open the first table of this note as a spreadsheet",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (checking) return true;
				void this.openFirstTable(file);
				return true;
			},
		});

		this.addCommand({
			id: "save-grid-to-note",
			name: "Save the spreadsheet to the note",
			checkCallback: (checking) => {
				const view = this.activeGridView();
				if (!view) return false;
				if (checking) return true;
				void view.saveNow();
				return true;
			},
		});

		this.addCommand({
			id: "copy-table-as-markdown",
			name: "Copy table as Markdown",
			checkCallback: (checking) => {
				const view = this.activeGridView();
				if (!view) return false;
				if (checking) return true;
				void navigator.clipboard.writeText(view.fullMarkdown());
				new Notice("Copied the table as Markdown.");
				return true;
			},
		});

		for (const [id, name] of GRID_COMMANDS) {
			this.addCommand({
				id: `grid-${id}`,
				name,
				checkCallback: (checking) => {
					const view = this.app.workspace.getActiveViewOfType(GridView);
					if (!view) return false;
					if (!checking) view.runAction(id);
					return true;
				},
			});
		}

		this.addCommand({
			id: "insert-table",
			name: "Insert a new table and open it as a spreadsheet",
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file;
				if (!file) return false;
				if (!checking) new InsertTableModal(this.app, (cols, rows, headers) => void this.insertTable(editor, file, cols, rows, headers)).open();
				return true;
			},
		});

		this.addCommand({
			id: "import-table",
			name: "Import a spreadsheet file as a new table",
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file;
				if (!file) return false;
				if (checking) return true;
				const files = this.app.vault.getFiles().filter((f) => ["csv", "tsv", "xlsx"].includes(f.extension.toLowerCase()));
				new ImportModal(this.app, {
					files,
					target: "It is inserted into the note at the cursor and opened as a spreadsheet.",
					onVaultFile: (picked) => void this.importAsTable(editor, file, picked.name, () => this.app.vault.readBinary(picked)),
					onDiskFile: (picked) => void this.importAsTable(editor, file, picked.name, () => picked.arrayBuffer()),
				}).open();
				return true;
			},
		});

		this.addCommand({
			id: "reformat-all-tables",
			name: "Reformat every table in this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.reformatAll(file);
				return true;
			},
		});

		this.addCommand({
			id: "find-table",
			name: "Find a table in the vault",
			callback: () => void this.openTableIndex(),
		});

		this.addCommand({
			id: "restore-previous-version",
			name: "Restore previous version",
			checkCallback: (checking) => {
				const view = this.activeGridView();
				if (!view) return false;
				if (checking) return true;
				view.openRestoreDialog();
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				const file = info.file;
				if (!file || file.extension !== "md") return;
				const line = editor.getCursor().line;
				const region = regionAtLine(editor.getValue(), line);
				if (!region) return;
				menu.addItem((item) =>
					item
						.setTitle("Open table as a spreadsheet")
						.setIcon(iconName("launcher"))
						.onClick(() => void this.openRegion(file, anchorFromRegion(file.path, region))),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((item) =>
					item
						.setTitle("Open table as a spreadsheet")
						.setIcon(iconName("launcher"))
						.onClick(() => void this.openFirstTable(file)),
				);
			}),
		);

		// A stored formula value is literal text, so a note edited outside the grid goes stale in
		// silence. The watcher recalcs such a note behind the scenes; see `FormulaWatcher`.
		this.formulaWatcher = new FormulaWatcher(
			this.app.vault,
			() => this.sidecar.settings,
			(path) => this.isNoteBusy(path),
			(message) => new Notice(message),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.formulaWatcher?.schedule(file);
			}),
		);
		this.app.workspace.onLayoutReady(() => this.formulaWatcher?.sweep());

		// Sidecar keys embed the path, so a rename would otherwise orphan every column width.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) this.sidecar.handleRename(oldPath, file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) this.sidecar.handleDelete(file.path);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!leaf || !(leaf.view instanceof GridView)) this.clearStatusBar();
			}),
		);
	}

	override onunload(): void {
		// No `detachLeavesOfType` here: `detach-leaves` (§15.2) — closing the user's tabs on
		// update or disable is the plugin deciding something that is not its call.
		this.formulaWatcher?.dispose();
		void this.sidecar.saveNow();
	}

	/**
	 * True when the note is open anywhere: an editor holds a buffer the vault write would race, and
	 * an open grid has its own conflict handling and recalculates when it opens.
	 */
	private isNoteBusy(path: string): boolean {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) return true;
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
			const view = leaf.view;
			if (view instanceof GridView && view.currentPath() === path) return true;
		}
		return false;
	}

	/** Settings shape the ribbon, so a change has to reach the views that are already open. */
	refreshOpenGrids(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
			const view = leaf.view;
			if (view instanceof GridView) view.reloadRibbon();
		}
	}

	setStatusBarText(text: string): void {
		this.statusBarEl?.setText(text);
	}

	clearStatusBar(): void {
		this.statusBarEl?.setText("");
	}

	/* ------------------------------------------------------- in-note button */

	/**
	 * Puts a hover button on every table rendered in reading view.
	 *
	 * Only the rendered DOM is touched — the note's text is never modified, which is what keeps
	 * this on the right side of "the note is only marked up on explicit opt-in" (§7). The source
	 * line comes from `getSectionInfo`, so the button opens exactly the table it sits on rather
	 * than guessing an index.
	 *
	 * Off by default. Post processors also run for PDF export, embeds and hover previews, and a
	 * button in a reading surface — let alone in an exported PDF — was the opposite of what was
	 * wanted; `styles.css` hides it from print as a second line of defence.
	 */
	private decorateTables(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		if (!this.sidecar.settings.showTableButtonInReading) return;
		// Depending on the render path the element handed to a post processor is either the block
		// wrapper or the table itself, and `findAll` only looks at descendants.
		const tables = el.tagName === "TABLE" ? [el] : el.findAll("table");
		for (const table of tables) {
			if (table.parentElement?.hasClass("mds-table-launcher") === true) continue;
			// The note can be rendered in a popped-out window, whose document has its own class
			// identities, so the wrapper is created by that window rather than the global helper.
			const wrapper = table.ownerDocument.win.createDiv({ cls: "mds-table-launcher" });
			table.replaceWith(wrapper);
			wrapper.append(table);
			const btn = wrapper.createEl("button", { cls: "mds-table-launcher-btn", attr: { type: "button" } });
			setIconSafe(btn.createSpan(), "launcher");
			btn.createSpan({ text: "Edit" });
			setTooltip(btn, "Open this table as a spreadsheet");
			btn.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				// `getSectionInfo` wants the element the post processor was given, not our wrapper.
				void this.openFromSection(ctx, el);
			});
		}
	}

	private async openFromSection(ctx: MarkdownPostProcessorContext, el: HTMLElement): Promise<void> {
		const file = this.app.vault.getFileByPath(ctx.sourcePath);
		if (!file) {
			new Notice("Cannot find the note this table belongs to.");
			return;
		}
		const section = ctx.getSectionInfo(el);
		const text = await this.app.vault.cachedRead(file);
		const region = section === null ? null : regionAtLine(text, section.lineStart);
		if (!region) {
			// A table inside a callout or an embed has no addressable section; fall back to asking.
			await this.openFirstTable(file);
			return;
		}
		await this.openRegion(file, anchorFromRegion(file.path, region));
	}

	/* ------------------------------------------------------------- opening */

	private activeMarkdownInfo(): { editor: Editor; file: TFile } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) return null;
		return { editor: view.editor, file: view.file };
	}

	/**
	 * `no-view-references-in-plugin` (§15.2): the plugin never holds a view instance, it asks
	 * the workspace for the leaves of its type when it needs one.
	 */
	private activeGridView(): GridView | null {
		const active = this.app.workspace.getActiveViewOfType(GridView);
		if (active) return active;
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID);
		for (const leaf of leaves) {
			if (leaf.view instanceof GridView) return leaf.view;
		}
		return null;
	}

	private async openFromEditor(editor: Editor, file: TFile): Promise<void> {
		const text = editor.getValue();
		const region = regionAtLine(text, editor.getCursor().line);
		if (region) {
			await this.openRegion(file, anchorFromRegion(file.path, region));
			return;
		}
		await this.openFirstTable(file);
	}

	private async openFirstTable(file: TFile): Promise<void> {
		const text = await this.app.vault.cachedRead(file);
		const tables = scanTables(text);
		if (tables.length === 0) {
			new Notice("This note has no table.");
			return;
		}
		if (tables.length === 1) {
			await this.openRegion(file, anchorFromRegion(file.path, tables[0]));
			return;
		}
		// More than one table and no cursor to disambiguate — ask rather than guess (§7).
		new TablePickerModal(
			this.app,
			tables.map((region) => ({ region, score: 0 })),
			(picked) => void this.openRegion(file, anchorFromRegion(file.path, picked.region)),
			{ title: "Choose a table", message: `This note has ${tables.length} tables. Pick the one to open.` },
		).open();
	}

	/* ------------------------------------------------------ new tables */

	/**
	 * Puts a table block on its own lines at the cursor — a blank line either side, so it never
	 * runs into a paragraph — saves the note, and opens the grid on it.
	 */
	private async insertBlock(editor: Editor, file: TFile, block: string): Promise<void> {
		const line = editor.getCursor().line;
		const current = editor.getLine(line);
		const at = current.trim() === "" ? line : line + 1;
		const before = at > 0 && editor.getLine(at - 1).trim() !== "" ? "\n" : "";
		const lines = block.replace(/\n+$/, "");
		const after = at < editor.lineCount() && (editor.getLine(at) ?? "").trim() !== "" ? "\n" : "";
		const pos = at < editor.lineCount() ? { line: at, ch: 0 } : { line: at - 1, ch: editor.getLine(at - 1).length };
		const text = at < editor.lineCount() ? `${before}${lines}\n${after}` : `\n${before}${lines}\n`;
		editor.replaceRange(text, pos);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		// The grid reads the file, so the editor's buffer has to reach the disk first.
		if (view) await view.save();
		const region = regionAtLine(editor.getValue(), at + (before === "" ? 0 : 1) + (at < editor.lineCount() ? 0 : 0));
		const target = region ?? scanTables(editor.getValue()).find((r) => r.startLine >= at) ?? null;
		if (target) await this.openRegion(file, anchorFromRegion(file.path, target));
	}

	private async insertTable(editor: Editor, file: TFile, cols: number, rows: number, headers: string[]): Promise<void> {
		const model = createModel();
		model.colAlign = Array.from({ length: cols }, (): Align => null);
		for (let c = 0; c < cols; c++) setRaw(model, 0, c, headers[c] ?? "");
		recomputeUsedRange(model);
		model.usedRange = { rows: rows + 1, cols };
		await this.insertBlock(editor, file, serializeTable(model, { compact: this.sidecar.settings.tableStyle === "compact" }));
	}

	private async importAsTable(editor: Editor, file: TFile, name: string, read: () => Promise<ArrayBuffer>): Promise<void> {
		try {
			const book = await readTableBook(name, await read());
			const total = book.sheets.reduce((n, sheet) => n + formulaTotal(sheet.rows), 0);
			const choice: SheetChoice | null =
				book.sheets.length === 1 && total === 0
					? { sheets: [0], formulas: "values", headings: false }
					: await pickSheets(this.app, {
							fileName: name,
							sheets: book.sheets,
							multiple: true,
							formulas: true,
							target: "Each sheet becomes its own table in the note, at the cursor.",
						});
			if (choice === null) return;
			const chosen = choice.sheets.map((index) => book.sheets[index]);
			if (chosen.every((sheet) => sheet.rows.length === 0)) {
				new Notice("The file has no data.");
				return;
			}
			// A table's number is its position in the note, and formulas in other tables use it. The
			// new tables start after every table above the cursor, so `Table3!B2` in one of them
			// names the table a sibling sheet becomes — not some table that was already there.
			const line = editor.getCursor().line;
			const at = (editor.getLine(line) ?? "").trim() === "" ? line : line + 1;
			const base = scanTables(editor.getValue()).filter((region) => region.startLine < at).length;
			const refs = new Map<string, FormulaSheet>();
			for (const [position, sheet] of chosen.entries()) {
				refs.set(sheet.name.toLowerCase(), {
					ref: `Table${base + position + 1}`,
					rows: sheet.rows.length,
					cols: sheet.rows[0]?.length ?? 0,
				});
			}
			const compact = this.sidecar.settings.tableStyle === "compact";
			const blocks: string[] = [];
			let formulas = 0;
			let convertible = 0;
			for (const sheet of chosen) {
				const width = sheet.rows[0]?.length ?? 0;
				if (sheet.rows.length === 0 || width === 0) continue;
				const context = { sheet: { rows: sheet.rows.length, cols: width }, sheets: refs };
				const values = sheetToValues(sheet.rows, { formulas: choice.formulas, context });
				const counts = countFormulas(sheet.rows, context);
				formulas += counts.total;
				convertible += counts.convertible;
				const table = serializeTable(valuesToModel(values), { compact });
				if (choice.headings && sheet.name.trim() !== "") blocks.push(`### ${sheet.name}\n\n${table}`);
				else blocks.push(table);
			}
			if (blocks.length === 0) {
				new Notice("The file has no data.");
				return;
			}
			await this.insertBlock(editor, file, blocks.join("\n\n"));
			const parts = [`${blocks.length} ${blocks.length === 1 ? "table" : "tables"} from ${name}`];
			if (formulas > 0) {
				const kept = choice.formulas === "values" ? 0 : convertible;
				if (kept === formulas) parts.push(`${formulas} ${formulas === 1 ? "formula" : "formulas"}`);
				else if (kept === 0) parts.push(`values only, ${formulas} formulas dropped`);
				else parts.push(`${kept} of ${formulas} formulas carried over`);
			}
			new Notice(`Imported ${parts.join(" · ")}.`);
		} catch (error) {
			new Notice(`Could not import ${name} — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Every table of the note through the serializer, in one write. Asks nothing: it was asked for. */
	private async reformatAll(file: TFile): Promise<void> {
		const compact = this.sidecar.settings.tableStyle === "compact";
		const n = await new Writer(this.app.vault).reformatAll(file, (text) => serializeTable(parseTable(text), { compact }));
		new Notice(n === 0 ? "Every table is already formatted." : `Reformatted ${n} ${n === 1 ? "table" : "tables"}.`);
	}

	/** Reads only the notes the metadata cache says contain a table. */
	private async openTableIndex(): Promise<void> {
		const tables: VaultTable[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const sections = this.app.metadataCache.getFileCache(file)?.sections ?? [];
			if (!sections.some((section) => section.type === "table")) continue;
			for (const region of scanTables(await this.app.vault.cachedRead(file))) tables.push({ file, region });
		}
		if (tables.length === 0) {
			new Notice("No tables found in this vault.");
			return;
		}
		new TableIndexModal(this.app, tables, (picked) => void this.openRegion(picked.file, anchorFromRegion(picked.file.path, picked.region))).open();
	}

	/** Reuses an already open tab for the same table instead of stacking duplicates. */
	private async openRegion(file: TFile, anchor: Anchor): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
			const view = leaf.view;
			if (!(view instanceof GridView)) continue;
			const existing = view.currentAnchor();
			if (view.currentPath() === file.path && existing?.tableIndex === anchor.tableIndex) {
				await this.app.workspace.revealLeaf(leaf);
				return;
			}
		}
		// A phone has no room for a split; the setting applies where there is.
		const split = this.sidecar.settings.openIn === "split" && !Platform.isPhone;
		const leaf = this.app.workspace.getLeaf(split ? "split" : "tab");
		const state: GridViewState = { path: file.path, anchor };
		await leaf.setViewState({ type: VIEW_TYPE_GRID, active: true, state: state as unknown as Record<string, unknown> });
		await this.app.workspace.revealLeaf(leaf);
	}
}
