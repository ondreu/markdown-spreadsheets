import { MarkdownView, Notice, Plugin, TFile, type Editor, type MarkdownFileInfo, type Menu } from "obsidian";
import { anchorFromRegion, regionAtLine, type Anchor } from "./file/AnchorResolver";
import { scanTables } from "./file/scanTables";
import { MarkdownGridSettingTab } from "./settings";
import { Sidecar } from "./store/Sidecar";
import { VIEW_TYPE_GRID } from "./view/constants";
import { GridView, type GridViewState } from "./view/GridView";
import { TablePickerModal } from "./view/modals";

export default class MarkdownGridPlugin extends Plugin {
	sidecar!: Sidecar;
	private statusBarEl: HTMLElement | null = null;

	override async onload(): Promise<void> {
		this.sidecar = new Sidecar(this);
		await this.sidecar.load();

		this.registerView(VIEW_TYPE_GRID, (leaf) => new GridView(leaf, this));
		this.addSettingTab(new MarkdownGridSettingTab(this.app, this));

		// Persistent selection aggregate, Excel style (§12).
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("markdown-grid-status");

		// No default hotkeys: `no-default-hotkeys` (§15.2). In-view keys live in the view's Scope.
		this.addCommand({
			id: "open-table-in-grid",
			name: "Open table in grid",
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
			name: "Open the first table of this note in grid",
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
			name: "Save grid to note",
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
						.setTitle("Open table in grid")
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
						.setTitle("Open table in grid")
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
