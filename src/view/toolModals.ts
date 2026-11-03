import { FuzzySuggestModal, Modal, Setting, type App, type FuzzyMatch, type TFile } from "obsidian";
import { colName } from "../model/address";
import { formatCompact } from "../model/numbers";
import type { ColumnStats, NumberFormatOptions, NumberStyle } from "../feature/transform";
import type { TableRegion } from "../file/scanTables";
import { previewOf } from "../file/scanTables";

/** "B · Price" for every column of the table, for drop-downs. */
export function columnOptions(headers: string[]): Array<[string, string]> {
	return headers.map((h, c) => [String(c), h === "" ? colName(c) : `${colName(c)} · ${h}`]);
}

/** A modal whose body is a list of settings and whose footer is OK / Cancel. */
abstract class FormModal extends Modal {
	protected abstract title: string;
	protected abstract cta: string;
	protected abstract build(el: HTMLElement): void;
	protected abstract submit(): boolean | void;

	override onOpen(): void {
		this.titleEl.setText(this.title);
		this.build(this.contentEl);
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.cta)
					.setCta()
					.onClick(() => {
						if (this.submit() !== false) this.close();
					}),
			);
		this.contentEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" || evt.isComposing) return;
			const tag = (evt.target as HTMLElement | null)?.tagName;
			if (tag === "SELECT" || tag === "BUTTON") return;
			evt.preventDefault();
			if (this.submit() !== false) this.close();
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** Ctrl+G: a cell address such as B12, or a header name. */
export class GoToModal extends FormModal {
	protected title = "Go to cell";
	protected cta = "Go";
	private value = "";

	constructor(app: App, private readonly onGo: (text: string) => boolean) {
		super(app);
	}

	protected build(el: HTMLElement): void {
		new Setting(el)
			.setName("Cell or column")
			.setDesc("A cell address, a column letter, or the name of a column.")
			.addText((t) => {
				t.onChange((v) => (this.value = v));
				window.setTimeout(() => t.inputEl.focus(), 0);
			});
	}

	protected submit(): boolean {
		return this.onGo(this.value.trim());
	}
}

export interface SortKey {
	col: number;
	ascending: boolean;
}

/** Up to three sort keys, Excel's "Custom sort". */
export class MultiSortModal extends FormModal {
	protected title = "Sort by several columns";
	protected cta = "Sort";
	private readonly keys: Array<{ col: number; ascending: boolean; on: boolean }>;
	private selectionOnly = false;

	constructor(
		app: App,
		private readonly opts: { headers: string[]; first: number; hasRowSelection: boolean; onSort(keys: SortKey[], selectionOnly: boolean): void },
	) {
		super(app);
		this.keys = [0, 1, 2].map((i) => ({ col: i === 0 ? opts.first : 0, ascending: true, on: i === 0 }));
	}

	protected build(el: HTMLElement): void {
		el.createEl("p", { cls: "mds-modal-note", text: "Rows are compared by the first column, ties by the second, then the third. The header row never moves." });
		const options = columnOptions(this.opts.headers);
		this.keys.forEach((key, i) => {
			const s = new Setting(el).setName(i === 0 ? "Sort by" : "Then by");
			if (i > 0) s.addToggle((t) => t.setValue(key.on).onChange((v) => (key.on = v)));
			s.addDropdown((d) => {
				for (const [value, label] of options) d.addOption(value, label);
				d.setValue(String(key.col)).onChange((v) => (key.col = Number.parseInt(v, 10)));
			});
			s.addDropdown((d) =>
				d
					.addOption("asc", "Ascending")
					.addOption("desc", "Descending")
					.setValue("asc")
					.onChange((v) => (key.ascending = v === "asc")),
			);
		});
		if (this.opts.hasRowSelection) {
			new Setting(el).setName("Selected rows only").addToggle((t) => t.onChange((v) => (this.selectionOnly = v)));
		}
	}

	protected submit(): void {
		this.opts.onSort(
			this.keys.filter((k) => k.on).map(({ col, ascending }) => ({ col, ascending })),
			this.selectionOnly,
		);
	}
}

/** One text field and a short explanation — split, merge, number formats and friends. */
export class TextPromptModal extends FormModal {
	protected title: string;
	protected cta: string;
	private value: string;

	constructor(
		app: App,
		private readonly opts: { title: string; cta: string; name: string; desc: string; value: string; placeholder?: string; onSubmit(value: string): boolean | void },
	) {
		super(app);
		this.title = opts.title;
		this.cta = opts.cta;
		this.value = opts.value;
	}

	protected build(el: HTMLElement): void {
		new Setting(el)
			.setName(this.opts.name)
			.setDesc(this.opts.desc)
			.addText((t) => {
				t.setValue(this.value).onChange((v) => (this.value = v));
				if (this.opts.placeholder) t.setPlaceholder(this.opts.placeholder);
				window.setTimeout(() => t.inputEl.select(), 0);
			});
	}

	protected submit(): boolean | void {
		return this.opts.onSubmit(this.value);
	}
}

/** `Calculate ▸ Format numbers`: destructive by nature, and says so. */
export class NumberFormatModal extends FormModal {
	protected title = "Format numbers";
	protected cta = "Rewrite the cells";
	private readonly options: NumberFormatOptions;

	constructor(
		app: App,
		private readonly opts: { decimals: number; locale: string; onSubmit(options: NumberFormatOptions): void },
	) {
		super(app);
		this.options = { style: "number", decimals: opts.decimals, grouping: true, currency: "CZK", ...(opts.locale ? { locale: opts.locale } : {}) };
	}

	protected build(el: HTMLElement): void {
		el.createEl("p", {
			cls: "mds-modal-note",
			text: "A Markdown cell is text, so this rewrites the selected numbers in place. Undo brings them back.",
		});
		new Setting(el).setName("Style").addDropdown((d) =>
			d
				.addOption("number", "Number")
				.addOption("percent", "Percent")
				.addOption("currency", "Currency")
				.setValue(this.options.style)
				.onChange((v) => (this.options.style = v as NumberStyle)),
		);
		new Setting(el).setName("Decimal places").addSlider((s) =>
			s
				.setLimits(0, 6, 1)
				.setValue(this.options.decimals)
				
				.onChange((v) => (this.options.decimals = v)),
		);
		new Setting(el).setName("Group thousands").addToggle((t) => t.setValue(true).onChange((v) => (this.options.grouping = v)));
		new Setting(el)
			.setName("Currency")
			.setDesc("The three-letter currency code.")
			.addText((t) => t.setValue(this.options.currency ?? "").onChange((v) => (this.options.currency = v.trim().toUpperCase())));
	}

	protected submit(): void {
		this.opts.onSubmit(this.options);
	}
}

/** `Calculate ▸ Column statistics`: read-only numbers about one column. */
export class ColumnStatsModal extends Modal {
	constructor(
		app: App,
		private readonly opts: { title: string; stats: ColumnStats; locale: string; onCopy(text: string): void },
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.opts.title);
		const { stats, locale } = this.opts;
		const fmt = (n: number | null) => (n === null ? "—" : formatCompact(n, locale));
		const rows: Array<[string, string]> = [
			["Filled cells", String(stats.filled)],
			["Empty cells", String(stats.empty)],
			["Distinct values", String(stats.distinct)],
			["Numeric cells", String(stats.numeric)],
			["Sum", stats.numeric > 0 ? fmt(stats.sum) : "—"],
			["Average", fmt(stats.average)],
			["Minimum", fmt(stats.min)],
			["Maximum", fmt(stats.max)],
			["Most common", stats.mostCommon ? `${stats.mostCommon.value} (${stats.mostCommon.count}×)` : "—"],
		];
		const table = this.contentEl.createDiv({ cls: "mds-stats" });
		for (const [label, value] of rows) {
			const row = table.createDiv({ cls: "mds-stats-row" });
			row.createSpan({ cls: "mds-stats-label", text: label });
			const v = row.createSpan({ cls: "mds-stats-value", text: value });
			v.setAttribute("aria-label", "Click to copy");
			v.addEventListener("click", () => this.opts.onCopy(value));
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** `Calculate ▸ Totals row`. */
export class TotalsModal extends FormModal {
	protected title = "Add a totals row";
	protected cta = "Add";
	private fn: "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT" = "SUM";
	private label = "Total";

	constructor(app: App, private readonly onSubmit: (fn: TotalsModal["fn"], label: string) => void) {
		super(app);
	}

	protected build(el: HTMLElement): void {
		el.createEl("p", {
			cls: "mds-modal-note",
			text: "Each numeric column gets a formula under its data. The value is written into the cell, so the note reads correctly anywhere; the grid recalculates it whenever the table changes.",
		});
		new Setting(el).setName("Function").addDropdown((d) => {
			for (const fn of ["SUM", "AVERAGE", "MIN", "MAX", "COUNT"] as const) d.addOption(fn, fn);
			d.setValue(this.fn).onChange((v) => (this.fn = v as TotalsModal["fn"]));
		});
		new Setting(el).setName("Label").addText((t) => t.setValue(this.label).onChange((v) => (this.label = v)));
	}

	protected submit(): void {
		this.onSubmit(this.fn, this.label);
	}
}

/** `Calculate ▸ Compute column`: a one-off expression per row, written as values. */
export class ComputeColumnModal extends FormModal {
	protected title = "Compute a column";
	protected cta = "Compute";
	private expr = "";
	private target: number;

	constructor(
		app: App,
		private readonly opts: { headers: string[]; target: number; onSubmit(target: number, expr: string): boolean | void },
	) {
		super(app);
		this.target = opts.target;
	}

	protected build(el: HTMLElement): void {
		el.createEl("p", {
			cls: "mds-modal-note",
			text: "Writes the result for every data row as a plain value — it does not update later. Refer to columns by letter, or by header name in square brackets.",
		});
		new Setting(el).setName("Write into").addDropdown((d) => {
			for (const [value, label] of columnOptions(this.opts.headers)) d.addOption(value, label);
			d.addOption(String(this.opts.headers.length), `${colName(this.opts.headers.length)} · new column`);
			d.setValue(String(this.target)).onChange((v) => (this.target = Number.parseInt(v, 10)));
		});
		new Setting(el).setName("Expression").addText((t) => {
			t.setPlaceholder("[qty] * [price]").onChange((v) => (this.expr = v));
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
	}

	protected submit(): boolean | void {
		if (this.expr.trim() === "") return false;
		return this.opts.onSubmit(this.target, this.expr.trim());
	}
}

/** Pick columns: merging, removing duplicates. */
export class ColumnsModal extends FormModal {
	protected title: string;
	protected cta: string;
	private readonly chosen: Set<number>;
	private extra: string;

	constructor(
		app: App,
		private readonly opts: {
			title: string;
			cta: string;
			note: string;
			headers: string[];
			chosen: number[];
			extra?: { name: string; value: string };
			onSubmit(cols: number[], extra: string): boolean | void;
		},
	) {
		super(app);
		this.title = opts.title;
		this.cta = opts.cta;
		this.chosen = new Set(opts.chosen);
		this.extra = opts.extra?.value ?? "";
	}

	protected build(el: HTMLElement): void {
		el.createEl("p", { cls: "mds-modal-note", text: this.opts.note });
		for (const [value, label] of columnOptions(this.opts.headers)) {
			const c = Number.parseInt(value, 10);
			new Setting(el).setName(label).addToggle((t) =>
				t.setValue(this.chosen.has(c)).onChange((v) => (v ? this.chosen.add(c) : this.chosen.delete(c))),
			);
		}
		if (this.opts.extra) {
			new Setting(el).setName(this.opts.extra.name).addText((t) => t.setValue(this.extra).onChange((v) => (this.extra = v)));
		}
	}

	protected submit(): boolean | void {
		return this.opts.onSubmit(
			Array.from(this.chosen).sort((a, b) => a - b),
			this.extra,
		);
	}
}

/** `Insert a new table`: size and, optionally, header names. */
export class InsertTableModal extends FormModal {
	protected title = "Insert a table";
	protected cta = "Insert and open";
	private cols = 3;
	private rows = 3;
	private headers = "";

	constructor(app: App, private readonly onSubmit: (cols: number, rows: number, headers: string[]) => void) {
		super(app);
	}

	protected build(el: HTMLElement): void {
		new Setting(el).setName("Columns").addSlider((s) => s.setLimits(1, 12, 1).setValue(this.cols).onChange((v) => (this.cols = v)));
		new Setting(el).setName("Data rows").addSlider((s) => s.setLimits(1, 30, 1).setValue(this.rows).onChange((v) => (this.rows = v)));
		new Setting(el)
			.setName("Header")
			.setDesc("Optional column names, separated by commas. Missing ones are left for you to fill in.")
			.addText((t) => t.setPlaceholder("Item, quantity, price").onChange((v) => (this.headers = v)));
	}

	protected submit(): void {
		const names = this.headers.split(",").map((h) => h.trim());
		this.onSubmit(Math.max(this.cols, names.filter((n) => n !== "").length), this.rows, names);
	}
}

/** `Import a table`: a file from the vault, or one from disk. */
export class ImportModal extends Modal {
	constructor(
		app: App,
		private readonly opts: { files: TFile[]; target: string; onVaultFile(file: TFile): void; onDiskFile(file: File): void },
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Import a table");
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: `CSV, TSV or Excel. The first row becomes the header. ${this.opts.target}`,
		});
		let picked: TFile | null = this.opts.files[0] ?? null;
		new Setting(this.contentEl)
			.setName("From the vault")
			.addDropdown((d) => {
				if (this.opts.files.length === 0) d.addOption("", "No CSV or spreadsheet files in the vault");
				for (const f of this.opts.files) d.addOption(f.path, f.path);
				d.onChange((v) => (picked = this.opts.files.find((f) => f.path === v) ?? null));
			})
			.addButton((b) =>
				b
					.setButtonText("Import")
					.setCta()
					.setDisabled(this.opts.files.length === 0)
					.onClick(() => {
						if (!picked) return;
						this.close();
						this.opts.onVaultFile(picked);
					}),
			);
		const input = this.contentEl.createEl("input", {
			cls: "mds-hidden",
			attr: { type: "file", accept: ".csv,.tsv,.txt,.xlsx" },
		});
		input.addEventListener("change", () => {
			const file = input.files?.item(0);
			if (!file) return;
			this.close();
			this.opts.onDiskFile(file);
		});
		new Setting(this.contentEl).setName("From this computer").addButton((b) => b.setButtonText("Choose a file…").onClick(() => input.click()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export interface VaultTable {
	file: TFile;
	region: TableRegion;
}

/** `Find a table in the vault`: every table, searchable by note name and header. */
export class TableIndexModal extends FuzzySuggestModal<VaultTable> {
	constructor(
		app: App,
		private readonly tables: VaultTable[],
		private readonly onPick: (table: VaultTable) => void,
	) {
		super(app);
		this.setPlaceholder("Search tables by note or column name");
	}

	getItems(): VaultTable[] {
		return this.tables;
	}

	getItemText(item: VaultTable): string {
		return `${item.file.basename} — ${previewOf(item.region, 8)}`;
	}

	override renderSuggestion(match: FuzzyMatch<VaultTable>, el: HTMLElement): void {
		const { file, region } = match.item;
		el.createDiv({ cls: "mds-index-title", text: `${file.basename}${region.precedingHeading ? ` › ${region.precedingHeading}` : ""}` });
		el.createDiv({ cls: "mds-index-meta", text: `${previewOf(region, 6)} · ${region.rowCount} × ${region.colCount} · ${file.parent?.path ?? ""}` });
	}

	onChooseItem(item: VaultTable): void {
		this.onPick(item);
	}
}
