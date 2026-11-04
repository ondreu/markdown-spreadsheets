import { PluginSettingTab, Setting, type App } from "obsidian";
import type MarkdownSpreadsheetsPlugin from "../main";
import type { AnchorStrategy, CsvDelimiter, MarkdownSpreadsheetsSettings, StatusStat } from "../settings";

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

		new Setting(containerEl)
			.setName("Table layout in the note")
			.setDesc(
				"Aligned pads every column so the pipes line up in the source. Compact writes one space per side, so changing a cell changes only its own line — much smaller diffs in Git.",
			)
			.addDropdown((d) =>
				d
					.addOption("aligned", "Aligned")
					.addOption("compact", "Compact")
					.setValue(settings.tableStyle)
					.onChange((value) => {
						settings.tableStyle = value === "compact" ? "compact" : "aligned";
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Preview before saving")
			.setDesc("In manual save mode, show what is about to change in the note before writing it.")
			.addToggle((t) =>
				t.setValue(settings.previewBeforeSave).onChange((value) => {
					settings.previewBeforeSave = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Versions kept per table")
			.setDesc("For restoring an earlier version. One is recorded when a table is opened and as it is saved.")
			.addSlider((s) =>
				s
					.setLimits(3, 50, 1)
					.setValue(settings.maxBackups)
					.onChange((value) => {
						settings.maxBackups = value;
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
			.setName("Show a button on tables while editing")
			.setDesc(
				"While editing a note, adds a small button to the top right of every table while the pointer is over it, which opens that table in the spreadsheet editor. The note itself is never changed.",
			)
			.addToggle((t) =>
				t.setValue(settings.showTableButton).onChange((value) => {
					settings.showTableButton = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Show the button in reading view too")
			.setDesc("Reopen the note for this to take effect. It never appears in an exported PDF.")
			.addToggle((t) =>
				t.setValue(settings.showTableButtonInReading).onChange((value) => {
					settings.showTableButtonInReading = value;
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

		new Setting(containerEl)
			.setName("Open the spreadsheet in")
			.addDropdown((d) =>
				d
					.addOption("tab", "A new tab")
					.addOption("split", "A split next to the note")
					.setValue(settings.openIn)
					.onChange((value) => {
						settings.openIn = value === "split" ? "split" : "tab";
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Fit columns on first open")
			.setDesc("Size every column to its content the first time a table is opened in the grid.")
			.addToggle((t) =>
				t.setValue(settings.autofitOnFirstOpen).onChange((value) => {
					settings.autofitOnFirstOpen = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Suggestions while typing")
			.setDesc("Links after [[, tags after #, and values already used in the same column.")
			.addToggle((t) =>
				t.setValue(settings.autocomplete).onChange((value) => {
					settings.autocomplete = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Recalculate when a note changes")
			.setDesc(
				"A formula cell stores its last value as text, so an edit from Obsidian Sync, another plugin or the source view leaves it stale. The plugin then recalculates the tables of that note in the background, and once over recently edited notes at startup. Notes open in an editor or a grid are left to the grid.",
			)
			.addToggle((t) =>
				t.setValue(settings.recalculateInBackground).onChange((value) => {
					settings.recalculateInBackground = value;
					commit();
				}),
			);

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Toolbar")
			.setDesc("Icons only keeps the toolbar to one short row; every name stays in the tooltip.")
			.addDropdown((d) =>
				d
					.addOption("labels", "Icons and labels")
					.addOption("icons", "Icons only")
					.setValue(settings.ribbonStyle)
					.onChange((value) => {
						settings.ribbonStyle = value === "icons" ? "icons" : "labels";
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Touch layout")
			.setDesc(
				"Tap to select and tap again to edit, a long press for the menu, two fingers to zoom, and an action bar under the grid. Automatic turns it on in the mobile app. Takes effect in newly opened grids.",
			)
			.addDropdown((d) =>
				d
					.addOption("auto", "Automatic")
					.addOption("on", "Always")
					.addOption("off", "Never")
					.setValue(settings.mobileLayout)
					.onChange((value) => {
						settings.mobileLayout = value === "on" || value === "off" ? value : "auto";
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Column names next to the letters")
			.setDesc("Shows the Markdown header beside the column letter.")
			.addToggle((t) =>
				t.setValue(settings.headerNamesInLetters).onChange((value) => {
					settings.headerNamesInLetters = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Highlight the active row and column")
			.addToggle((t) =>
				t.setValue(settings.highlightActiveLine).onChange((value) => {
					settings.highlightActiveLine = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Striped rows")
			.addToggle((t) =>
				t.setValue(settings.zebraRows).onChange((value) => {
					settings.zebraRows = value;
					commit();
				}),
			);

		new Setting(containerEl)
			.setName("Status bar figures")
			.setDesc("Which figures of the selection to show. Click a figure in the grid to copy it.");
		const stats: Array<[StatusStat, string]> = [
			["sum", "Sum"],
			["average", "Average"],
			["count", "Count"],
			["counta", "Filled cells"],
			["min", "Minimum"],
			["max", "Maximum"],
		];
		for (const [key, label] of stats) {
			new Setting(containerEl).setName(label).addToggle((t) =>
				t.setValue(settings.statusStats.includes(key)).onChange((value) => {
					const set = new Set(settings.statusStats);
					if (value) set.add(key);
					else set.delete(key);
					settings.statusStats = stats.map(([k]) => k).filter((k) => set.has(k));
					commit();
				}),
			);
		}

		new Setting(containerEl).setName("Dates").setHeading();

		new Setting(containerEl)
			.setName("Date format")
			.setDesc("Inserted with Ctrl+; — a Moment.js format.")
			.addMomentFormat((m) =>
				m
					.setDefaultFormat("YYYY-MM-DD")
					.setValue(settings.dateFormat)
					.onChange((value) => {
						settings.dateFormat = value.trim() === "" ? "YYYY-MM-DD" : value;
						commit();
					}),
			);

		new Setting(containerEl)
			.setName("Time format")
			.setDesc("Inserted with Ctrl+Shift+;.")
			.addMomentFormat((m) =>
				m
					.setDefaultFormat("HH:mm")
					.setValue(settings.timeFormat)
					.onChange((value) => {
						settings.timeFormat = value.trim() === "" ? "HH:mm" : value;
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
