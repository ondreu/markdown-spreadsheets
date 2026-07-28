import type { Plugin } from "obsidian";
import type { Anchor } from "../file/AnchorResolver";
import { DEFAULT_SETTINGS, type MarkdownSpreadsheetsSettings } from "../settings";

/**
 * Purely cosmetic per-table state (§8.4).
 *
 * None of this can live in the note, because GFM has nowhere to put it. Losing it degrades
 * the view, never the data — the note stays fully readable without it.
 */
export interface TableLayout {
	/** Dense per column; a shorter array means the remaining columns use the default. */
	colWidths: number[];
	/** Sparse map keyed by row index — most rows use the default height (§8.4). */
	rowHeights: Record<string, number>;
	wrapCols: number[];
	frozenRows: number;
	frozenCols: number;
	decimals: number;
	/** Per-table override of the global default row height. */
	rowHeightDefault?: number;
}

export interface BackupEntry {
	/** Epoch millis. */
	at: number;
	text: string;
}

export interface PluginData {
	settings: MarkdownSpreadsheetsSettings;
	tables: Record<string, TableLayout>;
	anchors: Record<string, Anchor>;
	backups: Record<string, BackupEntry[]>;
	/** Consecutive layer-2 failures per file, used to gate the layer-3 offer (§7). */
	anchorFailures: Record<string, number>;
}

export const MAX_BACKUPS = 10;

export function defaultLayout(settings: MarkdownSpreadsheetsSettings): TableLayout {
	return {
		colWidths: [],
		rowHeights: {},
		wrapCols: [],
		// Row 0 is the markdown header, so freezing it is the sane default (§9).
		frozenRows: 1,
		frozenCols: 0,
		decimals: settings.defaultDecimals,
	};
}

const EMPTY_DATA: PluginData = {
	settings: DEFAULT_SETTINGS,
	tables: {},
	anchors: {},
	backups: {},
	anchorFailures: {},
};

/**
 * Persistence through `loadData()` / `saveData()`.
 *
 * Never a hand-built path into `.obsidian` — that is what `hardcoded-config-path` (§15.2)
 * forbids, and it would break for anyone with a custom config directory.
 */
export class Sidecar {
	private data: PluginData = structuredCloneData(EMPTY_DATA);
	private saveTimer: number | null = null;

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<void> {
		const raw = (await this.plugin.loadData()) as Partial<PluginData> | null;
		const merged = Object.assign({}, EMPTY_DATA, raw ?? {});
		merged.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		merged.tables = Object.assign({}, {}, raw?.tables ?? {});
		merged.anchors = Object.assign({}, {}, raw?.anchors ?? {});
		merged.backups = Object.assign({}, {}, raw?.backups ?? {});
		merged.anchorFailures = Object.assign({}, {}, raw?.anchorFailures ?? {});
		this.data = merged;
	}

	get settings(): MarkdownSpreadsheetsSettings {
		return this.data.settings;
	}

	async saveNow(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.plugin.saveData(this.data);
	}

	/**
	 * Coalesced write. Dragging a column border fires on every mouse move, and each of those
	 * would otherwise be a full plugin-data write (§8.5/4).
	 */
	queueSave(delayMs = 300): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveData(this.data);
		}, delayMs);
	}

	getLayout(key: string): TableLayout {
		const stored = this.data.tables[key];
		const layout = Object.assign({}, defaultLayout(this.data.settings), stored ?? {});
		// Stored objects predate later fields, and a corrupt array would break rendering.
		if (!Array.isArray(layout.colWidths)) layout.colWidths = [];
		if (!Array.isArray(layout.wrapCols)) layout.wrapCols = [];
		if (typeof layout.rowHeights !== "object" || layout.rowHeights === null) layout.rowHeights = {};
		return layout;
	}

	setLayout(key: string, layout: TableLayout): void {
		this.data.tables[key] = layout;
		this.queueSave();
	}

	getAnchor(key: string): Anchor | undefined {
		return this.data.anchors[key];
	}

	setAnchor(key: string, anchor: Anchor): void {
		this.data.anchors[key] = anchor;
		this.queueSave();
	}

	listAnchors(): Array<{ key: string; anchor: Anchor }> {
		return Object.entries(this.data.anchors).map(([key, anchor]) => ({ key, anchor }));
	}

	/** Keeps the last {@link MAX_BACKUPS} serialized versions of a region (§13.2). */
	pushBackup(key: string, text: string, at: number): void {
		const list = this.data.backups[key] ?? [];
		if (list.length > 0 && list[list.length - 1].text === text) return;
		list.push({ at, text });
		while (list.length > MAX_BACKUPS) list.shift();
		this.data.backups[key] = list;
		this.queueSave();
	}

	getBackups(key: string): BackupEntry[] {
		return (this.data.backups[key] ?? []).slice().reverse();
	}

	noteAnchorFailure(path: string): number {
		const n = (this.data.anchorFailures[path] ?? 0) + 1;
		this.data.anchorFailures[path] = n;
		this.queueSave();
		return n;
	}

	clearAnchorFailures(path: string): void {
		if (this.data.anchorFailures[path] === undefined) return;
		delete this.data.anchorFailures[path];
		this.queueSave();
	}

	/**
	 * Follows a renamed or moved file.
	 *
	 * Sidecar keys embed the path, so without this every rename silently resets column widths
	 * and orphans the backups for that table (§8.4).
	 */
	handleRename(oldPath: string, newPath: string): void {
		const remap = (prefixOld: string, prefixNew: string, bucket: Record<string, unknown>) => {
			for (const key of Object.keys(bucket)) {
				if (key === prefixOld || key.startsWith(prefixOld + "::")) {
					const next = prefixNew + key.slice(prefixOld.length);
					bucket[next] = bucket[key];
					delete bucket[key];
				}
			}
		};
		remap(oldPath, newPath, this.data.tables);
		remap(oldPath, newPath, this.data.backups);
		remap(oldPath, newPath, this.data.anchors);
		for (const [key, anchor] of Object.entries(this.data.anchors)) {
			if (anchor.path === oldPath) this.data.anchors[key] = Object.assign({}, anchor, { path: newPath });
		}
		if (this.data.anchorFailures[oldPath] !== undefined) {
			this.data.anchorFailures[newPath] = this.data.anchorFailures[oldPath];
			delete this.data.anchorFailures[oldPath];
		}
		this.queueSave();
	}

	/** Drops cosmetic state for a file that no longer exists. Backups are kept on purpose. */
	handleDelete(path: string): void {
		for (const key of Object.keys(this.data.tables)) {
			if (key === path || key.startsWith(path + "::")) delete this.data.tables[key];
		}
		delete this.data.anchorFailures[path];
		this.queueSave();
	}
}

function structuredCloneData(data: PluginData): PluginData {
	return JSON.parse(JSON.stringify(data)) as PluginData;
}
