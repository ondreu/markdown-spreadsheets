/**
 * Settings shape and defaults.
 *
 * No Obsidian import on purpose: `Sidecar` reads `DEFAULT_SETTINGS`, and the store layer has to
 * stay unit-testable outside the app. The tab that renders these lives in `src/view/SettingTab.ts`.
 */

export type AnchorStrategy = "fingerprint" | "ask" | "blockId";
export type SaveMode = "auto" | "manual";
export type CsvDelimiter = "," | ";" | "\t";

export interface MarkdownSpreadsheetsSettings {
	/** §13.2: autosave is the Excel-like default; manual suits a git-tracked vault. */
	saveMode: SaveMode;
	autosaveDebounceMs: number;
	/** §7, layer 3. Never escalates to a block ID on its own. */
	anchorStrategy: AnchorStrategy;
	/** §8.2 global default; a table can override it. */
	defaultRowHeight: number;
	defaultColWidth: number;
	/** Rendered is the default: a cell full of link syntax is unreadable (D9). */
	defaultRenderMode: "raw" | "rendered";
	/** A hover button on tables in the note itself, next to the context-menu route (§11). */
	showTableButton: boolean;
	/** The ribbon panel starts collapsed; the tab strip stays visible either way. */
	ribbonCollapsed: boolean;
	defaultDecimals: number;
	/** Empty follows the host locale. */
	numberLocale: string;
	decimalSeparator: "auto" | "," | ".";
	csvDelimiter: CsvDelimiter;
	/** Excel on Windows needs the BOM or it mangles diacritics (§14). */
	csvBom: boolean;
	exportFolder: string;
	/** Extra rows/columns added around the used range when opening (§9). */
	padRows: number;
	padCols: number;
	confirmSparseWrite: boolean;
}

export const DEFAULT_SETTINGS: MarkdownSpreadsheetsSettings = {
	saveMode: "auto",
	autosaveDebounceMs: 800,
	anchorStrategy: "fingerprint",
	defaultRowHeight: 24,
	defaultColWidth: 120,
	defaultRenderMode: "rendered",
	showTableButton: true,
	ribbonCollapsed: false,
	defaultDecimals: 2,
	numberLocale: "",
	decimalSeparator: "auto",
	csvDelimiter: ";",
	csvBom: true,
	exportFolder: "",
	padRows: 30,
	padCols: 5,
	confirmSparseWrite: true,
};
