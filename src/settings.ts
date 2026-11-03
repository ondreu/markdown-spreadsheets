/**
 * Settings shape and defaults.
 *
 * No Obsidian import on purpose: `Sidecar` reads `DEFAULT_SETTINGS`, and the store layer has to
 * stay unit-testable outside the app. The tab that renders these lives in `src/view/SettingTab.ts`.
 */

export type AnchorStrategy = "fingerprint" | "ask" | "blockId";
export type SaveMode = "auto" | "manual";
export type CsvDelimiter = "," | ";" | "\t";
export type TableStyle = "aligned" | "compact";
export type StatusStat = "sum" | "average" | "count" | "counta" | "min" | "max";

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
	/** A hover button on tables in Live Preview, next to the context-menu route (§11). */
	showTableButton: boolean;
	/** The same button in reading view. Off by default: reading view is also what PDF export renders. */
	showTableButtonInReading: boolean;
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
	/** How the table is written back: pipes aligned, or one space per side for small Git diffs. */
	tableStyle: TableStyle;
	/** Where a grid opens: a new tab, or a split next to the note. */
	openIn: "tab" | "split";
	/** Moment.js formats for Ctrl+; and Ctrl+Shift+;. */
	dateFormat: string;
	timeFormat: string;
	/** Suggestions while typing in a cell: links, tags and values already in the column. */
	autocomplete: boolean;
	zebraRows: boolean;
	/** Tints the row and column of the active cell. */
	highlightActiveLine: boolean;
	/** "B · Price" in the column header instead of only "B". */
	headerNamesInLetters: boolean;
	/** Ribbon buttons with labels, or icons only. */
	ribbonStyle: "labels" | "icons";
	statusStats: StatusStat[];
	/** Manual save mode: show the diff of what is about to be written before writing it. */
	previewBeforeSave: boolean;
	/** Versions kept per table for `Restore a version`. */
	maxBackups: number;
	/** Fit the columns to their content the first time a table is opened. */
	autofitOnFirstOpen: boolean;
}

export const DEFAULT_SETTINGS: MarkdownSpreadsheetsSettings = {
	saveMode: "auto",
	autosaveDebounceMs: 800,
	anchorStrategy: "fingerprint",
	defaultRowHeight: 24,
	defaultColWidth: 120,
	defaultRenderMode: "rendered",
	showTableButton: true,
	showTableButtonInReading: false,
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
	tableStyle: "aligned",
	openIn: "tab",
	dateFormat: "YYYY-MM-DD",
	timeFormat: "HH:mm",
	autocomplete: true,
	zebraRows: false,
	highlightActiveLine: true,
	headerNamesInLetters: true,
	ribbonStyle: "labels",
	statusStats: ["sum", "average", "count"],
	previewBeforeSave: false,
	maxBackups: 10,
	autofitOnFirstOpen: true,
};
