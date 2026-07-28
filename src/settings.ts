import { PluginSettingTab, Setting, type App } from "obsidian";
import type MarkdownSpreadsheetsPlugin from "./main";

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

export class MarkdownSpreadsheetsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: MarkdownSpreadsheetsPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.sidecar.settings;
		const commit = () => void this.plugin.sidecar.saveNow();

		new Setting(containerEl).setName("Saving").setHeading();

		new Setting(containerEl)
			.setName("Save mode")
			.setDesc(
				"Automatic writes back shortly after every edit. Manual keeps a dirty indicator and waits for the save command — better for a Git-tracked vault or Obsidian Sync, which record every write as a revision.",
			)
			.addDropdown((d) =>
				d
					.addOption("auto", "Automatic")
					.addOption("manual", "Manual")
					.setValue(settings.saveMode)
					.onChange((value) => {
						settings.saveMode = value === "manual" ? "manual" : "auto";
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Autosave delay")
			.setDesc("Milliseconds of inactivity before an automatic write back to the note.")
			.addText((t) =>
				t
					.setPlaceholder("800")
					.setValue(String(settings.autosaveDebounceMs))
					.onChange((value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n)) settings.autosaveDebounceMs = Math.max(200, Math.min(10000, n));
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Warn before writing a sparse table")
			.setDesc(
				"A value far from the data forces every cell in between to be written. The warning shows how many empty cells that would add.",
			)
			.addToggle((t) =>
				t.setValue(settings.confirmSparseWrite).onChange((value) => {
					settings.confirmSparseWrite = value;
					commit();
				}),
			);

		new Setting(containerEl).setName("Finding the table again").setHeading();

		new Setting(containerEl)
			.setName("Anchor strategy")
			.setDesc(
				"Fingerprint matches on the header, heading and shape without touching the note. Ask offers a permanent block ID after repeated failures. Block ID adds one as soon as a table is opened.",
			)
			.addDropdown((d) =>
				d
					.addOption("fingerprint", "Fingerprint only")
					.addOption("ask", "Ask after repeated failures")
					.addOption("blockId", "Always add a block ID")
					.setValue(settings.anchorStrategy)
					.onChange((value) => {
						settings.anchorStrategy = value as AnchorStrategy;
						commit();
					}),
			);

		new Setting(containerEl).setName("Grid").setHeading();

		new Setting(containerEl)
			.setName("Default row height")
			.setDesc("Pixels. Individual rows can still be resized in the grid.")
			.addSlider((s) =>
				s
					.setLimits(18, 80, 1)
					.setValue(settings.defaultRowHeight)
					.onChange((value) => {
						settings.defaultRowHeight = value;
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Default column width")
			.setDesc("Pixels, used for columns that have never been resized.")
			.addSlider((s) =>
				s
					.setLimits(40, 400, 5)
					.setValue(settings.defaultColWidth)
					.onChange((value) => {
						settings.defaultColWidth = value;
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Cell display")
			.setDesc(
				"Rendered formats every visible cell, so links and emphasis read the way they do in the note. Raw shows the Markdown source instead, which is faster on a very wide table. Either way editing a cell always shows the raw Markdown.",
			)
			.addDropdown((d) =>
				d
					.addOption("rendered", "Rendered")
					.addOption("raw", "Raw Markdown")
					.setValue(settings.defaultRenderMode)
					.onChange((value) => {
						settings.defaultRenderMode = value === "raw" ? "raw" : "rendered";
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Show a button on tables in the note")
			.setDesc(
				"Adds a small button to the top right of every table while the pointer is over it, which opens that table in the spreadsheet editor. The note itself is never changed.",
			)
			.addToggle((t) =>
				t.setValue(settings.showTableButton).onChange((value) => {
					settings.showTableButton = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Extra rows and columns")
			.setDesc("How much empty space to show past the data when a table is opened.")
			.addText((t) =>
				t
					.setPlaceholder("30")
					.setValue(String(settings.padRows))
					.onChange((value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n)) settings.padRows = Math.max(0, Math.min(500, n));
						commit();
					}),
			)
			.addText((t) =>
				t
					.setPlaceholder("5")
					.setValue(String(settings.padCols))
					.onChange((value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n)) settings.padCols = Math.max(0, Math.min(64, n));
						commit();
					}),
			);

		new Setting(containerEl).setName("Numbers").setHeading();

		new Setting(containerEl)
			.setName("Decimal places")
			.setDesc("Used when a calculated value is written into a cell.")
			.addSlider((s) =>
				s
					.setLimits(0, 8, 1)
					.setValue(settings.defaultDecimals)
					.onChange((value) => {
						settings.defaultDecimals = value;
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Decimal separator")
			.setDesc(
				"How to read a number with a single separator. Automatic treats one separator as decimal and a repeated one as grouping.",
			)
			.addDropdown((d) =>
				d
					.addOption("auto", "Automatic")
					.addOption(",", "Comma")
					.addOption(".", "Period")
					.setValue(settings.decimalSeparator)
					.onChange((value) => {
						settings.decimalSeparator = value as MarkdownSpreadsheetsSettings["decimalSeparator"];
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Number locale")
			.setDesc(
				"A language tag decides how grouped numbers are written and read back. Leave empty to follow the system locale.",
			)
			.addText((t) =>
				t
					.setPlaceholder("System locale")
					.setValue(settings.numberLocale)
					.onChange((value) => {
						settings.numberLocale = value.trim();
						commit();
					}),
			);

		new Setting(containerEl).setName("Export").setHeading();

		new Setting(containerEl)
			.setName("CSV delimiter")
			.setDesc("Excel expects a semicolon in locales that use the comma as a decimal mark.")
			.addDropdown((d) =>
				d
					.addOption(";", "Semicolon")
					.addOption(",", "Comma")
					.addOption("\t", "Tab")
					.setValue(settings.csvDelimiter)
					.onChange((value) => {
						settings.csvDelimiter = value as CsvDelimiter;
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Add a byte order mark to CSV")
			.setDesc("Excel on Windows misreads accented characters without it.")
			.addToggle((t) =>
				t.setValue(settings.csvBom).onChange((value) => {
					settings.csvBom = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Export folder")
			.setDesc("Vault-relative folder for exported files. Leave empty to write next to the note.")
			.addText((t) =>
				t
					.setPlaceholder("Exports")
					.setValue(settings.exportFolder)
					.onChange((value) => {
						settings.exportFolder = value.trim().replace(/^\/+|\/+$/g, "");
						commit();
					}),
			);
	}
}
