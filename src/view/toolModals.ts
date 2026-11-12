import { FuzzySuggestModal, Modal, Notice, Setting, type App, type FuzzyMatch, type TFile } from "obsidian";
import { colName } from "../model/address";
import { formatCompact } from "../model/numbers";
import type { ColumnStats, NumberFormatOptions, NumberStyle } from "../feature/transform";
import { FORMULA_FUNCTIONS, formulaProblem, type FormulaFunctionDoc } from "../feature/formula";
import { argumentSlots, formulaFromArgs, slotAt, type FormulaArgLayout } from "../feature/formulaInsert";
import { countFormulas, formulaTotal, type FormulaContext, type FormulaCounts, type FormulaSheet } from "../feature/importFormula";
import type { ImportedSheet } from "../feature/importTable";
import type { TableRegion } from "../file/scanTables";
import { previewOf } from "../file/scanTables";

/** "B · Price" for every column of the table, for drop-downs. */
export function columnOptions(headers: string[]): Array<[string, string]> {
	return headers.map((h, c) => [String(c), h === "" ? colName(c) : `${colName(c)} · ${h}`]);
}

/** A modal whose body is a list of settings and whose footer is OK / Cancel. */
abstract class FormModal extends Modal {
	/** The OK button, so a dialog can hold it disabled while its form does not make sense. */
	protected ctaButton: HTMLButtonElement | null = null;

	protected abstract title: string;
	protected abstract cta: string;
	protected abstract build(el: HTMLElement): void;
	protected abstract submit(): boolean | void;

	override onOpen(): void {
		this.titleEl.setText(this.title);
		this.build(this.contentEl);
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.ctaButton = b.buttonEl;
				b.setButtonText(this.cta)
					.setCta()
					.onClick(() => {
						if (this.submit() !== false) this.close();
					});
			});
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

/** What a spreadsheet import should take, once the person has said so. */
export interface SheetChoice {
	/** Indexes into `sheets`, in the order the tables will be written. */
	sheets: number[];
	/** `convert` keeps every formula the grid can compute; `values` keeps what Excel calculated. */
	formulas: "convert" | "values";
	/** Put the sheet's name above its table, so an export names the sheet the same way again. */
	headings: boolean;
}

export interface SheetImportOptions {
	fileName: string;
	sheets: ImportedSheet[];
	/** Several sheets at once only makes sense when each becomes its own table. */
	multiple: boolean;
	/** Whether the formula choice applies to this target at all — a merge reads values only. */
	formulas: boolean;
	/** What will happen to the chosen sheets, in one sentence. */
	target: string;
}

/**
 * Which worksheets to take, and what to do with their formulas.
 *
 * A workbook is often a dozen tabs, of which one is meant. Reading only the first and saying
 * nothing — which is what the import used to do — silently turns "import the file" into "import
 * a twelfth of it". The formula question is asked here for the same reason: the grid can compute
 * `SUM`, `IF` and the conditional aggregates, and cannot compute `VLOOKUP`, so a formula either
 * travels as a formula or stays the number Excel last wrote in the cell. Saying which is the
 * difference between a table that keeps itself current and one that quietly does not.
 */
export class SheetImportModal extends Modal {
	private readonly picked = new Set<number>();
	private formulas: "convert" | "values" = "convert";
	private headings = true;
	private readonly boxes: Array<{ index: number; input: HTMLInputElement }> = [];
	private summaryEl: HTMLElement | null = null;
	private formulaSetting: Setting | null = null;
	private importButton: HTMLButtonElement | null = null;
	private submitted = false;

	constructor(
		app: App,
		private readonly opts: SheetImportOptions & { onSubmit(choice: SheetChoice): void; onCancel?(): void },
	) {
		super(app);
		// Everything with data, except sheets Excel hides: those are opened deliberately.
		for (const [index, sheet] of opts.sheets.entries()) {
			if (sheet.rows.length > 0 && !sheet.hidden) this.picked.add(index);
		}
		if (this.picked.size === 0) {
			for (const [index, sheet] of opts.sheets.entries()) {
				if (sheet.rows.length > 0) this.picked.add(index);
			}
		}
	}

	override onOpen(): void {
		this.titleEl.setText("Import a spreadsheet");
		const count = this.opts.sheets.length;
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: `${this.opts.fileName}: ${count === 1 ? "one sheet" : `${count} sheets`}. ${this.opts.target}`,
		});
		this.buildList();
		if (this.opts.formulas && this.opts.sheets.some((sheet) => formulaTotal(sheet.rows) > 0)) this.buildFormulaChoice();
		if (this.opts.multiple) this.buildHeadings();
		this.summaryEl = this.contentEl.createEl("p", { cls: "mds-modal-summary" });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.importButton = b.buttonEl;
				b.setButtonText("Import")
					.setCta()
					.onClick(() => this.submit());
			});
		this.refresh();
	}

	private buildList(): void {
		const list = this.contentEl.createDiv({ cls: "mds-sheet-list" });
		for (const [index, sheet] of this.opts.sheets.entries()) {
			const width = sheet.rows[0]?.length ?? 0;
			const empty = sheet.rows.length === 0 || width === 0;
			const row = list.createEl("label", { cls: "mds-sheet-item" });
			row.toggleClass("is-disabled", empty);
			const input = row.createEl("input", {
				cls: "mds-sheet-check",
				attr: { type: this.opts.multiple ? "checkbox" : "radio", name: "mds-import-sheet", value: String(index) },
			});
			input.checked = this.picked.has(index);
			input.disabled = empty;
			input.addEventListener("change", () => {
				if (!this.opts.multiple) this.picked.clear();
				if (input.checked) this.picked.add(index);
				else this.picked.delete(index);
				this.refresh();
			});
			const head = row.createDiv({ cls: "mds-sheet-head" });
			head.createSpan({ cls: "mds-sheet-name", text: sheet.name });
			if (sheet.hidden) head.createSpan({ cls: "mds-sheet-tag", text: "hidden" });
			if (empty) head.createSpan({ cls: "mds-sheet-tag", text: "empty" });
			const parts = empty ? ["nothing to import"] : [`${sheet.rows.length} rows`, `${width} columns`];
			const formulas = formulaTotal(sheet.rows);
			if (formulas > 0) parts.push(`${formulas} ${formulas === 1 ? "formula" : "formulas"}`);
			row.createDiv({ cls: "mds-sheet-meta", text: parts.join(" · ") });
			this.boxes.push({ index, input });
		}
	}

	private buildFormulaChoice(): void {
		this.formulaSetting = new Setting(this.contentEl)
			.setName("Formulas")
			.addDropdown((d) => {
				d.addOption("convert", "Convert what the grid can compute");
				d.addOption("values", "Values only — drop every formula");
				d.setValue(this.formulas);
				d.onChange((value) => {
					this.formulas = value === "values" ? "values" : "convert";
					this.refresh();
				});
			});
	}

	private buildHeadings(): void {
		new Setting(this.contentEl)
			.setName("Title each table with its sheet name")
			.setDesc("The heading above a table is the name it exports under, so the sheet names survive the round trip.")
			.addToggle((t) =>
				t.setValue(this.headings).onChange((value) => {
					this.headings = value;
					this.refresh();
				}),
			);
	}

	/** Sheet names to the `TableN` each will be, by position — enough to judge a formula. */
	private sheetRefs(selected: number[]): Map<string, FormulaSheet> {
		const refs = new Map<string, FormulaSheet>();
		for (const [position, index] of selected.entries()) {
			const sheet = this.opts.sheets[index];
			refs.set(sheet.name.toLowerCase(), {
				ref: `Table${position + 1}`,
				rows: sheet.rows.length,
				cols: sheet.rows[0]?.length ?? 0,
			});
		}
		return refs;
	}

	private refresh(): void {
		const selected = Array.from(this.picked).sort((a, b) => a - b);
		const sheets = selected.map((index) => this.opts.sheets[index]);
		const refs = this.sheetRefs(selected);
		let rows = 0;
		let total = 0;
		let convertible = 0;
		for (const sheet of sheets) {
			const context: FormulaContext = { sheet: { rows: sheet.rows.length, cols: sheet.rows[0]?.length ?? 0 }, sheets: refs };
			const counts = countFormulas(sheet.rows, context);
			rows += sheet.rows.length;
			total += counts.total;
			convertible += counts.convertible;
		}
		if (this.formulaSetting !== null) {
			this.formulaSetting.setDesc(`${convertible} of ${total} can be carried over; the rest keep the value Excel calculated.`);
		}
		if (this.summaryEl !== null) {
			const parts = [`${sheets.length} ${sheets.length === 1 ? "sheet" : "sheets"}`, `${rows} ${rows === 1 ? "row" : "rows"}`];
			if (total > 0) {
				parts.push(
					this.formulas === "convert"
						? `${total} ${total === 1 ? "formula" : "formulas"} (${convertible} convertible)`
						: `${total} ${total === 1 ? "formula" : "formulas"} dropped`,
				);
			}
			this.summaryEl.setText(`${parts.join(" · ")}.`);
		}
		if (this.importButton !== null) {
			if (sheets.length === 0) this.importButton.setAttribute("disabled", "true");
			else this.importButton.removeAttribute("disabled");
		}
		for (const box of this.boxes) {
			if (!box.input.disabled) box.input.checked = this.picked.has(box.index);
		}
	}

	private submit(): void {
		const selected = Array.from(this.picked).sort((a, b) => a - b);
		if (selected.length === 0) return;
		this.submitted = true;
		this.close();
		this.opts.onSubmit({ sheets: selected, formulas: this.formulas, headings: this.opts.multiple && this.headings });
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.submitted) this.opts.onCancel?.();
	}
}

/** The dialog as a promise: `null` when it was dismissed. */
export function pickSheets(app: App, options: SheetImportOptions): Promise<SheetChoice | null> {
	return new Promise((resolve) => {
		new SheetImportModal(app, {
			...options,
			onSubmit: (choice) => resolve(choice),
			onCancel: () => resolve(null),
		}).open();
	});
}

/**
 * What one imported sheet came to, in the line a Notice shows.
 *
 * The formula half is the part that matters afterwards: a table whose formulas were silently left
 * as values no longer follows its own numbers, and the person who imported it should hear that at
 * the moment it happens rather than the first time a total disagrees.
 */
export function describeImport(name: string, sheet: ImportedSheet, choice: SheetChoice, counts: FormulaCounts): string {
	const width = sheet.rows[0]?.length ?? 0;
	const parts = [`${sheet.rows.length} rows × ${width} columns from ${name}`];
	if (counts.total > 0) {
		const kept = choice.formulas === "values" ? 0 : counts.convertible;
		if (kept === 0) parts.push(`${counts.total} ${counts.total === 1 ? "formula" : "formulas"} left as values`);
		else if (kept === counts.total) parts.push(`${kept} ${kept === 1 ? "formula" : "formulas"} carried over`);
		else parts.push(`${kept} of ${counts.total} formulas carried over, the rest kept their values`);
	}
	return `${parts.join(" · ")}.`;
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

/** What the merge dialog needs to know, and what it hands back. */
export interface MergeChoice {
	keyCols: number[];
	align: "header" | "position";
	addColumns: boolean;
	removeMissing: boolean;
}

export interface MergeSummary {
	updated: number;
	added: number;
	removed: number;
	columns: number;
	duplicates: number;
}

/**
 * Merging a file into a table, with the consequences shown before anything is written.
 *
 * No merge can be undone from here — the grid's own undo covers it, one step — so the dialog says
 * what will happen in numbers: how many rows are matched, added, removed, which columns are new,
 * and whether the key repeats in the table, which is the one result people do not expect.
 */
export class MergeModal extends Modal {
	private choice: MergeChoice = { keyCols: [0], align: "header", addColumns: true, removeMissing: false };

	constructor(
		app: App,
		private readonly opts: {
			fileName: string;
			/** Table headers, in column order, with the column letter. */
			headers: Array<{ col: number; label: string; name: string }>;
			rowCount: number;
			importHeaders: string[];
			preview(choice: MergeChoice): MergeSummary | { error: string };
			apply(choice: MergeChoice): MergeSummary;
		},
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Merge a file into this table");
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: `${this.opts.fileName}: ${this.opts.rowCount} ${this.opts.rowCount === 1 ? "row" : "rows"}, ${this.opts.importHeaders.length} columns. Rows are matched by a key column; only the columns the file carries are written.`,
		});

		new Setting(this.contentEl).setName("Match rows by").addDropdown((d) => {
			for (const header of this.opts.headers) d.addOption(String(header.col), header.label);
			d.setValue(String(this.choice.keyCols[0] ?? 0));
			d.onChange((value) => {
				this.choice.keyCols = [Number.parseInt(value, 10)];
				this.refresh();
			});
		});

		new Setting(this.contentEl)
			.setName("Match columns by")
			.setDesc("Header name is what makes a reordered export work; position is the literal one.")
			.addDropdown((d) => {
				d.addOption("header", "Header name");
				d.addOption("position", "Position");
				d.setValue(this.choice.align);
				d.onChange((value) => {
					this.choice.align = value === "position" ? "position" : "header";
					this.refresh();
				});
			});

		new Setting(this.contentEl)
			.setName("Add columns the table does not have")
			.setDesc("Off keeps the table's own shape and ignores the extra columns.")
			.addToggle((t) =>
				t.setValue(this.choice.addColumns).onChange((value) => {
					this.choice.addColumns = value;
					this.refresh();
				}),
			);

		new Setting(this.contentEl)
			.setName("Delete rows the file no longer has")
			.setDesc("Off by default: a row that disappeared from an export is usually news, not a deletion.")
			.addToggle((t) =>
				t.setValue(this.choice.removeMissing).onChange((value) => {
					this.choice.removeMissing = value;
					this.refresh();
				}),
			);

		this.summaryEl = this.contentEl.createEl("p", { cls: "mds-modal-summary" });
		this.refresh();

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.mergeButton = b.buttonEl;
				b.setButtonText("Merge")
					.setCta()
					.onClick(() => {
						const result = this.opts.apply(this.choice);
						this.close();
						new Notice(
							`Merged ${this.opts.fileName}: ${result.updated} updated, ${result.added} added${result.removed > 0 ? `, ${result.removed} removed` : ""}${result.columns > 0 ? `, ${result.columns} new ${result.columns === 1 ? "column" : "columns"}` : ""}.`,
						);
					});
			});
	}

	private summaryEl: HTMLElement | null = null;
	private mergeButton: HTMLButtonElement | null = null;

	private refresh(): void {
		if (!this.summaryEl) return;
		const summary = this.opts.preview(this.choice);
		if ("error" in summary) {
			this.mergeButton?.setAttribute("disabled", "true");
			this.summaryEl.setText(`Cannot merge: ${summary.error}`);
			this.summaryEl.addClass("is-error");
			return;
		}
		this.mergeButton?.removeAttribute("disabled");
		this.summaryEl.removeClass("is-error");
		const parts = [
			`${summary.updated} ${summary.updated === 1 ? "row" : "rows"} updated`,
			`${summary.added} added`,
		];
		if (summary.removed > 0) parts.push(`${summary.removed} removed`);
		if (summary.columns > 0) parts.push(`${summary.columns} new ${summary.columns === 1 ? "column" : "columns"}`);
		if (summary.duplicates > 0) parts.push(`${summary.duplicates} repeated key ${summary.duplicates === 1 ? "row" : "rows"} left as they are`);
		this.summaryEl.setText(`${parts.join(" · ")}.`);
	}
}

/**
 * What a field must offer to receive a reference picked in the grid — the same shape `GridHost`
 * speaks. Declared here rather than imported so the dialog does not depend on the grid.
 */
export interface ReferenceSinkLike {
	value(): string;
	selection(): { start: number; end: number };
	replace(start: number, end: number, text: string): void;
	prefix(): string;
}

/**
 * Excel's *Insert Function*: pick a function, fill in its arguments, get the formula.
 *
 * The function list is the same one the cell editor suggests, so nothing is offered here that the
 * grid cannot evaluate; the arguments are the signature read literally, and the preview is checked
 * with the real parser before *Insert* is allowed to write anything. What it deliberately does not
 * do is point at cells — a reference is typed as `B2:B10`, and the formula bar is where a clicked
 * range lands.
 */
export class FormulaHelperModal extends FormModal {
	protected title = "Insert a formula";
	protected cta = "Insert";
	private listEl: HTMLElement | null = null;
	private argsEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;
	private search = "";
	private chosen: FormulaFunctionDoc | null = null;
	private layout: FormulaArgLayout | null = null;
	private args: string[] = [];

	constructor(
		app: App,
		private readonly opts: { cellLabel: string; onInsert(expr: string): void; attachSink(sink: ReferenceSinkLike | null): void },
	) {
		super(app);
	}

	protected build(el: HTMLElement): void {
		// The list needs room for a sentence beside it; the default 640 px modal leaves it truncated.
		this.modalEl.addClass("mds-formula-modal");
		// A panel, not a wall: the grid has to stay clickable, because a reference is picked by
		// clicking the cell it names.
		this.containerEl.addClass("mds-formula-floating");
		el.createEl("p", {
			cls: "mds-modal-note",
			text: `Built from a function and its arguments, then written into ${this.opts.cellLabel}. A range is typed as B2:B10, text in quotes.`,
		});
		const search = el.createEl("input", {
			cls: "mds-formula-search",
			attr: { type: "text", placeholder: "Search functions — sum, if, countif…", spellcheck: "false" },
		});
		search.addEventListener("input", () => {
			this.search = search.value;
			this.renderList();
		});
		search.focus();
		// Two columns when the dialog is wide enough — the list beside the arguments, as Excel's
		// own function dialog has them — and one column on a phone, where the pair would not fit.
		const body = el.createDiv({ cls: "mds-formula-body" });
		this.listEl = body.createDiv({ cls: "mds-function-list" });
		this.argsEl = body.createDiv({ cls: "mds-formula-args" });
		this.renderList();
		this.renderArgs();
	}

	protected submit(): boolean | void {
		const expr = this.expression();
		if (expr === null) return false;
		this.opts.onInsert(expr);
	}

	private expression(): string | null {
		if (this.chosen === null) return null;
		const expr = formulaFromArgs(this.chosen.name, this.args);
		return formulaProblem(expr) === null ? expr : null;
	}

	private renderList(): void {
		const list = this.listEl;
		if (list === null) return;
		list.empty();
		const query = this.search.trim().toLowerCase();
		const hits = FORMULA_FUNCTIONS.filter(
			(doc) => query === "" || doc.name.toLowerCase().includes(query) || doc.summary.toLowerCase().includes(query),
		);
		if (hits.length === 0) {
			list.createDiv({ cls: "mds-function-empty", text: "No function matches that." });
			return;
		}
		for (const doc of hits) {
			const item = list.createEl("button", { cls: "mds-function-item", attr: { type: "button" } });
			item.toggleClass("is-selected", doc.name === this.chosen?.name);
			// Name and one line about it: the signature is repeated under the arguments once the
			// function is picked, and printing it here only truncates the sentence beside it.
			item.createDiv({ cls: "mds-function-name", text: doc.name });
			item.createDiv({ cls: "mds-function-summary", text: doc.summary });
			item.addEventListener("click", () => this.pick(doc));
		}
		// A long list opens at the top; the chosen function may be well below it.
		list.querySelector<HTMLElement>(".mds-function-item.is-selected")?.scrollIntoView({ block: "nearest" });
	}

	private pick(doc: FormulaFunctionDoc): void {
		this.chosen = doc;
		this.layout = argumentSlots(doc);
		// One repetition of the variadic group is shown from the start: `COUNTIFS` takes a pair,
		// and a form that begins with too few fields only teaches that the formula is not ready.
		this.args = this.layout.slots.map(() => "");
		if (this.layout.variadic) this.args.push(...Array<string>(this.layout.unit).fill(""));
		this.renderList();
		this.renderArgs();
		// The first thing to fill in is the first argument, so typing can start at once.
		this.argsEl?.querySelector<HTMLInputElement>("input")?.focus();
	}

	private renderArgs(): void {
		const el = this.argsEl;
		if (el === null) return;
		el.empty();
		this.previewEl = null;
		const layout = this.layout;
		if (this.chosen === null || layout === null) {
			el.createEl("p", { cls: "mds-modal-note", text: "Pick a function above to fill in its arguments." });
			return;
		}
		el.createEl("p", { cls: "mds-function-chosen", text: `${this.chosen.name}(${this.chosen.signature})` });
		const seen = new Map<string, number>();
		this.args.forEach((value, index) => {
			// The repeating argument of a variadic function is named once; after that it is counted,
			// so `SUM` reads number, number 2, number 3, and `COUNTIFS` keeps its range/condition
			// pairs together.
			const slot = slotAt(layout, index);
			const occurrence = (seen.get(slot.label) ?? 0) + 1;
			seen.set(slot.label, occurrence);
			// A `<label>` around the field, so the whole row is the target on a phone and the
			// argument's name is announced with its input.
			const row = el.createEl("label", { cls: "mds-formula-arg" });
			row.createSpan({ cls: "mds-formula-arg-label", text: occurrence === 1 ? slot.label : `${slot.label} ${occurrence}` });
			const input = row.createEl("input", { cls: "mds-formula-arg-input", attr: { type: "text", spellcheck: "false" } });
			input.value = value;
			input.addEventListener("input", () => {
				this.args[index] = input.value;
				this.refreshPreview();
			});
			input.addEventListener("focus", () => this.opts.attachSink(this.sinkFor(input)));
			input.addEventListener("blur", () => this.opts.attachSink(null));
			if (slot.optional) row.createDiv({ cls: "mds-formula-arg-hint", text: "optional — leave it empty to skip it" });
		});
		if (layout.variadic) {
			const add = el.createEl("button", { cls: "mds-formula-add", attr: { type: "button" } });
			add.setText(layout.unit === 1 ? "Add argument" : "Add a pair");
			add.addEventListener("click", () => {
				this.args.push(...Array<string>(layout.unit).fill(""));
				this.renderArgs();
			});
		}
		const previewWrap = el.createDiv({ cls: "mds-formula-preview-wrap" });
		previewWrap.createDiv({ cls: "mds-formula-preview-label", text: "Formula" });
		this.previewEl = previewWrap.createEl("p", { cls: "mds-formula-preview" });
		this.refreshPreview();
	}

	/**
	 * The sink for one argument: what a click in the grid writes into.
	 *
	 * The host points at cells only while the text it is given starts with `=`, and an argument is
	 * not a whole formula — so the sink reports the `=` in front of the field's value and keeps its
	 * selection in the same coordinates. A click then lands `B2` or `B2:B9` at the caret, which is
	 * Excel's own behaviour for an argument box.
	 */
	private sinkFor(input: HTMLInputElement): ReferenceSinkLike {
		return {
			value: () => `=${input.value}`,
			selection: () => {
				const start = input.selectionStart ?? input.value.length;
				const end = input.selectionEnd ?? start;
				return { start: start + 1, end: end + 1 };
			},
			replace: (start, end, text) => {
				const from = Math.max(0, start - 1);
				const to = Math.max(0, end - 1);
				input.value = input.value.slice(0, from) + text + input.value.slice(to);
				const caret = from + text.length;
				input.setSelectionRange(caret, caret);
				input.dispatchEvent(new Event("input"));
				input.focus();
			},
			prefix: () => "",
		};
	}

	override onClose(): void {
		this.opts.attachSink(null);
		this.contentEl.empty();
	}

	private refreshPreview(): void {
		const preview = this.previewEl;
		if (preview === null || this.chosen === null) return;
		const shown = formulaFromArgs(this.chosen.name, this.args);
		const problem = formulaProblem(shown);
		preview.setText(problem === null ? `=${shown}` : `=${shown} — ${problem}`);
		preview.toggleClass("is-error", problem !== null);
		if (this.ctaButton !== null) {
			if (problem === null) this.ctaButton.removeAttribute("disabled");
			else this.ctaButton.setAttribute("disabled", "true");
		}
	}
}
