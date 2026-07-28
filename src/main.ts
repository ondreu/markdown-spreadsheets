import {
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	setIcon,
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
import { TablePickerModal } from "./view/modals";

export default class MarkdownSpreadsheetsPlugin extends Plugin {
	sidecar!: Sidecar;
	private statusBarEl: HTMLElement | null = null;

	override async onload(): Promise<void> {
		this.sidecar = new Sidecar(this);
		await this.sidecar.load();

		this.registerView(VIEW_TYPE_GRID, (leaf) => new GridView(leaf, this));
		this.addSettingTab(new MarkdownSpreadsheetsSettingTab(this.app, this));

		// Persistent selection aggregate, Excel style (§12).
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("markdown-spreadsheets-status");

		// The left sidebar route, next to the command palette and the two context menus (§11).
		this.addRibbonIcon("table", "Open table as a spreadsheet", () => {
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
						.setIcon("table")
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
						.setIcon("table")
						.onClick(() => void this.openFirstTable(file)),
				);
			}),
		);

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
		void this.sidecar.saveNow();
	}

	setStatusBarText(text: string): void {
		this.statusBarEl?.setText(text);
	}

	clearStatusBar(): void {
		this.statusBarEl?.setText("");
	}

	/* ------------------------------------------------------- in-note button */

	/**
	 * Puts a hover button on every table rendered in a note.
	 *
	 * Only the rendered DOM is touched — the note's text is never modified, which is what keeps
	 * this on the right side of "the note is only marked up on explicit opt-in" (§7). The source
	 * line comes from `getSectionInfo`, so the button opens exactly the table it sits on rather
	 * than guessing an index.
	 */
	private decorateTables(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		if (!this.sidecar.settings.showTableButton) return;
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
			setIcon(btn.createSpan(), "table");
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
		).open();
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
		const leaf = this.app.workspace.getLeaf("tab");
		const state: GridViewState = { path: file.path, anchor };
		await leaf.setViewState({ type: VIEW_TYPE_GRID, active: true, state: state as unknown as Record<string, unknown> });
		await this.app.workspace.revealLeaf(leaf);
	}
}
