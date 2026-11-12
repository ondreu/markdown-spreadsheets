import { Modal, Setting, type App } from "obsidian";
import { colName } from "../model/address";
import { CellSuggest } from "./CellSuggest";
import { describeDiff, diffLines, diffStats, relativeTime, tableShape } from "../feature/diff";
import type { GridModel } from "../model/GridModel";
import { previewOf } from "../file/scanTables";
import type { ScoredRegion } from "../file/AnchorResolver";
import type { BackupEntry, BackupSource } from "../store/Sidecar";
import { CALC_FUNCTIONS, applyFunction, type Aggregate, type CalcFunction } from "../feature/QuickCalc";
import { formatResult } from "../feature/QuickCalc";
import { type ConditionalFormat, type ConditionalOp, type ConditionalRule } from "../feature/conditional";
import type { CsvOptions } from "../feature/exportCsv";
import type { FindOptions } from "../feature/ops";
import type { ColumnFilter } from "../feature/transform";

/** Yes/no with an explicit destructive-action label. */
export class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly opts: {
			title: string;
			body: string | ((el: HTMLElement) => void);
			cta: string;
			cancel?: string;
			warning?: boolean;
			onConfirm(): void;
			onCancel?(): void;
		},
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.opts.title);
		const body = this.contentEl.createDiv({ cls: "mds-modal-body" });
		if (typeof this.opts.body === "string") body.createEl("p", { text: this.opts.body });
		else this.opts.body(body);

		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(this.opts.cancel ?? "Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((b) => {
				b.setButtonText(this.opts.cta).setCta();
				// The style class rather than setDestructive(), which needs a newer app than
				// minAppVersion promises (`no-unsupported-api`).
				if (this.opts.warning) b.buttonEl.addClass("mod-warning");
				b.onClick(() => {
					this.resolved = true;
					this.close();
					this.opts.onConfirm();
				});
			});
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.opts.onCancel?.();
	}
}

/**
 * "Pick the right table" (§7, layer 2).
 *
 * Reached whenever the fingerprint winner has no clear lead. Guessing here means opening the
 * wrong table and, worse, later writing to it.
 */
export class TablePickerModal extends Modal {
	private picked = false;

	constructor(
		app: App,
		private readonly candidates: ScoredRegion[],
		private readonly onPick: (candidate: ScoredRegion) => void,
		private readonly opts: { title?: string; message?: string; onCancel?(): void } = {},
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.opts.title ?? "Choose the right table");
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text:
				this.opts.message ??
				"Several tables in this note look alike, so the earlier one could not be identified with confidence.",
		});
		const list = this.contentEl.createDiv({ cls: "mds-table-picker" });
		for (const candidate of this.candidates) {
			const item = list.createEl("button", { cls: "mds-table-picker-item", attr: { type: "button" } });
			const region = candidate.region;
			item.createDiv({ cls: "mds-table-picker-head", text: previewOf(region, 6) });
			const meta = [
				`Table ${region.index + 1}`,
				`line ${region.startLine + 1}`,
				`${region.rowCount} × ${region.colCount}`,
				region.precedingHeading === undefined ? null : `under “${region.precedingHeading}”`,
			].filter((p): p is string => p !== null);
			item.createDiv({ cls: "mds-table-picker-meta", text: meta.join(" · ") });
			item.addEventListener("click", () => {
				this.picked = true;
				this.close();
				this.onPick(candidate);
			});
		}
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.picked) this.opts.onCancel?.();
	}
}

/**
 * The density guard of §13.1.
 *
 * A value in `Z400` forces every cell above and to the left of it to be written. This is the
 * only chance the user gets to notice before their note gains ten thousand empty cells.
 */
export class DensityModal extends Modal {
	constructor(
		app: App,
		private readonly opts: {
			rows: number;
			cols: number;
			filled: number;
			onShrink(): void;
			onWriteAnyway(): void;
		},
	) {
		super(app);
	}

	override onOpen(): void {
		const { rows, cols, filled } = this.opts;
		const total = rows * cols;
		this.titleEl.setText("This table is mostly empty");
		this.contentEl.createEl("p", {
			text: `Writing it back produces a ${cols} × ${rows} table — ${total.toLocaleString()} cells, of which ${filled.toLocaleString()} hold anything.`,
		});
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: "Markdown tables are always rectangular, so the empty cells have to be written out too.",
		});

		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Shrink to actual data")
					.setCta()
					.onClick(() => {
						this.close();
						this.opts.onShrink();
					}),
			)
			.addButton((b) =>
				b.setButtonText("Write anyway").onClick(() => {
					this.close();
					this.opts.onWriteAnyway();
				}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** `Data ▸ Calculate` (§12): pick a function, then place the literal result in a cell. */
export class CalculateModal extends Modal {
	private fn: CalcFunction = "SUM";

	constructor(
		app: App,
		private readonly opts: {
			aggregate: Aggregate;
			decimals: number;
			locale: string;
			rangeLabel: string;
			onPlace(fn: CalcFunction, text: string): void;
			onCopy(text: string): void;
		},
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Calculate");
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: `${this.opts.rangeLabel} · ${this.opts.aggregate.numericCount} numeric ${this.opts.aggregate.numericCount === 1 ? "cell" : "cells"}${this.opts.aggregate.ignoredCount > 0 ? `, ignoring ${this.opts.aggregate.ignoredCount} non-numeric` : ""}`,
		});

		const preview = this.contentEl.createDiv({ cls: "mds-calc-preview" });
		const refresh = () => {
			preview.empty();
			const text = this.resultText();
			preview.createSpan({ cls: "mds-calc-fn", text: this.fn });
			preview.createSpan({ cls: "mds-calc-eq", text: "=" });
			preview.createSpan({ cls: "mds-calc-value", text: text === null ? "not available" : text });
		};

		new Setting(this.contentEl).setName("Function").addDropdown((d) => {
			for (const fn of CALC_FUNCTIONS) d.addOption(fn, fn);
			d.setValue(this.fn).onChange((value) => {
				this.fn = value as CalcFunction;
				refresh();
			});
		});
		refresh();

		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: "The result is inserted as plain text. Markdown has no formulas, so it will not update when the data changes.",
		});

		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Insert into a cell")
					.setCta()
					.onClick(() => {
						const text = this.resultText();
						if (text === null) return;
						this.close();
						this.opts.onPlace(this.fn, text);
					}),
			)
			.addButton((b) =>
				b.setButtonText("Copy result").onClick(() => {
					const text = this.resultText();
					if (text === null) return;
					this.close();
					this.opts.onCopy(text);
				}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	private resultText(): string | null {
		const value = applyFunction(this.opts.aggregate, this.fn);
		if (value === null) return null;
		return formatResult(this.fn, value, this.opts.decimals, this.opts.locale);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export class FindReplaceModal extends Modal {
	private options: FindOptions = { query: "", matchCase: false, wholeCell: false, regex: false };
	private replacement = "";
	private statusEl!: HTMLElement;

	constructor(
		app: App,
		private readonly opts: {
			onFind(options: FindOptions): number;
			/** Selects the next match after the active cell; null when there is none. */
			onFindNext(options: FindOptions): { index: number; count: number } | null;
			onReplaceAll(options: FindOptions, replacement: string): number;
		},
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Find and replace");
		this.statusEl = this.contentEl.createDiv({ cls: "mds-modal-note mds-find-status" });

		new Setting(this.contentEl).setName("Find").addText((t) => {
			t.setValue(this.options.query).onChange((value) => {
				this.options.query = value;
				this.recount();
			});
			t.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key !== "Enter" || evt.isComposing) return;
				evt.preventDefault();
				this.findNext();
			});
		});
		new Setting(this.contentEl).setName("Replace with").addText((t) =>
			t.onChange((value) => {
				this.replacement = value;
			}),
		);
		new Setting(this.contentEl).setName("Match case").addToggle((t) =>
			t.onChange((value) => {
				this.options.matchCase = value;
				this.recount();
			}),
		);
		new Setting(this.contentEl)
			.setName("Match the whole cell")
			.setDesc("Replaces the entire cell rather than the matching part.")
			.addToggle((t) =>
				t.onChange((value) => {
					this.options.wholeCell = value;
					this.recount();
				}),
			);
		new Setting(this.contentEl).setName("Regular expression").addToggle((t) =>
			t.onChange((value) => {
				this.options.regex = value;
				this.recount();
			}),
		);

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Find next").onClick(() => this.findNext()))
			.addButton((b) =>
				b
					.setButtonText("Replace all")
					.setCta()
					.onClick(() => {
						const n = this.opts.onReplaceAll(this.options, this.replacement);
						this.statusEl.setText(`Replaced in ${n} ${n === 1 ? "cell" : "cells"}`);
					}),
			)
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	/** Every option changes what matches, not only the query — the count has to follow all of them. */
	private recount(): void {
		if (this.options.query === "") {
			this.statusEl.setText("");
			return;
		}
		if (this.options.regex && !isValidRegex(this.options.query)) {
			this.statusEl.setText("Not a valid regular expression");
			return;
		}
		const n = this.opts.onFind(this.options);
		this.statusEl.setText(`${n} matching ${n === 1 ? "cell" : "cells"}`);
	}

	private findNext(): void {
		if (this.options.query === "") return;
		const hit = this.opts.onFindNext(this.options);
		this.statusEl.setText(hit === null ? "No matching cell" : `Match ${hit.index} of ${hit.count}`);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

function isValidRegex(source: string): boolean {
	try {
		new RegExp(source);
		return true;
	} catch {
		return false;
	}
}

export class FilterModal extends Modal {
	private readonly queries = new Map<number, string>();
	private readonly others: ColumnFilter[];

	constructor(
		app: App,
		private readonly opts: {
			model: GridModel;
			current: ColumnFilter[];
			onApply(filters: ColumnFilter[]): void;
		},
	) {
		super(app);
		// The dialog edits "contains" filters; others set from the column header are kept as they are.
		for (const f of opts.current) if (f.kind === "contains") this.queries.set(f.col, f.query ?? "");
		this.others = opts.current.filter((f) => f.kind !== "contains");
	}

	override onOpen(): void {
		this.titleEl.setText("Filter rows");
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: "Filtering only hides rows in the grid. The note is never changed and hidden rows are still written back.",
		});
		const cols = Math.max(this.opts.model.usedRange.cols, 1);
		for (let c = 0; c < cols; c++) {
			const header = this.opts.model.cells.get(`0:${c}`)?.raw ?? "";
			const col = c;
			new Setting(this.contentEl).setName(header === "" ? colName(c) : `${colName(c)} — ${header}`).addText((t) =>
				t
					.setPlaceholder("Contains…")
					.setValue(this.queries.get(col) ?? "")
					.onChange((value) => this.queries.set(col, value)),
			);
		}

		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Apply")
					.setCta()
					.onClick(() => {
						this.close();
						this.opts.onApply(
							Array.from(this.queries.entries())
								.filter(([, q]) => q.trim() !== "")
								.map(([col, query]): ColumnFilter => ({ col, kind: "contains", query }))
								.concat(this.others.filter((f) => (this.queries.get(f.col) ?? "").trim() === "")),
						);
					}),
			)
			.addButton((b) =>
				b.setButtonText("Clear all").onClick(() => {
					this.close();
					this.opts.onApply([]);
				}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export interface ExportChoice {
	fileName: string;
	csv: CsvOptions;
	xlsxDetectNumbers: boolean;
	selectionOnly: boolean;
	/** Excel only: every table of the note as its own sheet. */
	xlsxAllTables: boolean;
}

export class ExportModal extends Modal {
	private fileName: string;
	private csv: CsvOptions;
	private detectNumbers = true;
	private selectionOnly = false;
	private allTables: boolean;

	constructor(
		app: App,
		private readonly opts: {
			format: "csv" | "xlsx" | "json";
			defaultName: string;
			csvDefaults: CsvOptions;
			/** Cell content the dialog starts on; Excel opens on plain text. */
			contentDefault?: "raw" | "plain";
			/** Tables in the note, so the workbook option is only offered when there are several. */
			tableCount?: number;
			hasSelection?: boolean;
			onExport(choice: ExportChoice): void;
		},
	) {
		super(app);
		this.fileName = opts.defaultName;
		this.csv = Object.assign({}, opts.csvDefaults, { content: opts.contentDefault ?? opts.csvDefaults.content });
		// A note with several tables is a workbook by construction, so that is what Excel gets.
		this.allTables = opts.format === "xlsx" && (opts.tableCount ?? 1) > 1;
	}

	override onOpen(): void {
		const isCsv = this.opts.format === "csv";
		const isJson = this.opts.format === "json";
		this.titleEl.setText(isCsv ? "Export to CSV" : isJson ? "Export to JSON" : "Export to Excel");

		new Setting(this.contentEl).setName("File name").addText((t) =>
			t.setValue(this.fileName).onChange((value) => {
				this.fileName = value;
			}),
		);

		new Setting(this.contentEl)
			.setName("Cell content")
			.setDesc("Raw keeps the Markdown source. Plain text resolves links and drops emphasis marks.")
			.addDropdown((d) =>
				d
					.addOption("raw", "Raw Markdown")
					.addOption("plain", "Plain text")
					.setValue(this.csv.content)
					.onChange((value) => {
						this.csv.content = value === "plain" ? "plain" : "raw";
					}),
			);

		if (isCsv) {
			new Setting(this.contentEl)
				.setName("Delimiter")
				.setDesc("Excel expects a semicolon in locales that use the comma as a decimal mark.")
				.addDropdown((d) =>
					d
						.addOption(";", "Semicolon")
						.addOption(",", "Comma")
						.addOption("\t", "Tab")
						.setValue(this.csv.delimiter)
						.onChange((value) => {
							this.csv.delimiter = value as CsvOptions["delimiter"];
						}),
				);
			new Setting(this.contentEl)
				.setName("Byte order mark")
				.setDesc("Excel on Windows misreads accented characters without it.")
				.addToggle((t) =>
					t.setValue(this.csv.bom).onChange((value) => {
						this.csv.bom = value;
					}),
				);
		} else if (!isJson) {
			new Setting(this.contentEl)
				.setName("Convert numbers")
				.setDesc("Cells that look numeric become real numbers instead of text.")
				.addToggle((t) =>
					t.setValue(this.detectNumbers).onChange((value) => {
						this.detectNumbers = value;
					}),
				);
			if ((this.opts.tableCount ?? 1) > 1) {
				new Setting(this.contentEl)
					.setName("All tables of the note")
					.setDesc("One sheet per table, named after the heading above it, or its headers when it has none. A reference from one table to another keeps working.")
					.addToggle((t) =>
						t.setValue(this.allTables).onChange((value) => {
							this.allTables = value;
						}),
					);
			}
		}

		if (this.opts.hasSelection) {
			new Setting(this.contentEl)
				.setName("Only the selection")
				.setDesc("Export the selected cells instead of the whole table.")
				.addToggle((t) => t.onChange((value) => (this.selectionOnly = value)));
		}

		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Export")
					.setCta()
					.onClick(() => {
						this.close();
						this.opts.onExport({
							fileName: this.fileName,
							csv: this.csv,
							xlsxDetectNumbers: this.detectNumbers,
							selectionOnly: this.selectionOnly,
							xlsxAllTables: this.allTables,
						});
					}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

const SOURCE_LABEL: Record<BackupSource, string> = {
	opened: "As opened",
	saved: "Saved",
	unsaved: "Never saved",
};

/**
 * `Restore previous version` (§13.2): the last ten serialized regions, newest first.
 *
 * Nothing is previewed until a version is picked. A restore replaces the whole grid, so the
 * decision needs the diff against what is in the grid right now, not three lines of context.
 */
export class RestoreModal extends Modal {
	private selected: BackupEntry | null = null;
	private itemEls: HTMLElement[] = [];
	private previewEl!: HTMLElement;
	private restoreButtonEl: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private readonly opts: {
			backups: BackupEntry[];
			/** The grid as it stands, which is what a restore would replace. */
			current: string;
			now: number;
			onRestore(entry: BackupEntry): void;
		},
	) {
		super(app);
	}

	override onOpen(): void {
		this.modalEl.addClass("mds-restore-modal");
		this.titleEl.setText("Restore a previous version");
		if (this.opts.backups.length === 0) {
			this.contentEl.createEl("p", {
				text: "No earlier versions of this table have been recorded yet. One is kept every time the table is opened or written back.",
			});
			new Setting(this.contentEl).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
			return;
		}

		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: "Pick a version to see what it would change. Restoring replaces the grid; nothing reaches the note until the next save.",
		});

		const layout = this.contentEl.createDiv({ cls: "mds-restore-layout" });
		const list = layout.createDiv({ cls: "mds-restore-list" });
		for (const entry of this.opts.backups) {
			const item = list.createEl("button", { cls: "mds-restore-item", attr: { type: "button" } });
			item.createDiv({ cls: "mds-restore-when", text: relativeTime(entry.at, this.opts.now) });
			const same = entry.text.trimEnd() === this.opts.current.trimEnd();
			const meta = [SOURCE_LABEL[entry.source ?? "saved"], new Date(entry.at).toLocaleString(), tableShape(entry.text)];
			if (same) meta.push("same as now");
			item.createDiv({ cls: "mds-restore-meta", text: meta.join(" · ") });
			this.itemEls.push(item);
			item.addEventListener("click", () => this.select(entry, item));
		}

		this.previewEl = layout.createDiv({ cls: "mds-restore-preview-pane" });
		this.previewEl.createDiv({
			cls: "mds-restore-placeholder",
			text: "Select a version on the left.",
		});

		new Setting(this.contentEl)
			.addButton((b) => {
				b.setButtonText("Restore this version")
					.setCta()
					.onClick(() => {
						const entry = this.selected;
						if (!entry) return;
						this.close();
						this.opts.onRestore(entry);
					});
				b.setDisabled(true);
				this.restoreButtonEl = b.buttonEl;
			})
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	private select(entry: BackupEntry, item: HTMLElement): void {
		this.selected = entry;
		for (const el of this.itemEls) el.toggleClass("is-selected", el === item);
		this.restoreButtonEl?.removeAttribute("disabled");
		this.renderDiff(entry);
	}

	private renderDiff(entry: BackupEntry): void {
		this.previewEl.empty();
		const lines = diffLines(this.opts.current, entry.text);
		const stats = diffStats(lines);
		const head = this.previewEl.createDiv({ cls: "mds-restore-diff-head" });
		head.createSpan({ cls: "mds-restore-diff-summary", text: describeDiff(stats) });
		if (stats.added > 0 || stats.removed > 0) {
			head.createSpan({ cls: "mds-modal-note", text: "− the grid now · + the version picked" });
		}

		const body = this.previewEl.createDiv({ cls: "mds-restore-diff" });
		for (const line of lines) {
			const row = body.createDiv({ cls: `mds-diff-line is-${line.kind}` });
			row.createSpan({ cls: "mds-diff-gutter", text: line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " " });
			row.createSpan({ cls: "mds-diff-text", text: line.text });
		}
	}

	override onClose(): void {
		this.contentEl.empty();
		this.itemEls = [];
		this.restoreButtonEl = null;
	}
}

/**
 * The region as the grid has it against the region as the note has it (§13.2).
 *
 * Same unified view as the restore dialog: with a conflict banner on screen the question is which
 * lines differ, and two `pre` blocks side by side leave that to the reader.
 */
export class DiffModal extends Modal {
	constructor(
		app: App,
		private readonly opts: {
			mine: string;
			theirs: string;
			title?: string;
			legend?: string;
			confirm?: { label: string; onConfirm(): void };
		},
	) {
		super(app);
	}

	override onOpen(): void {
		this.modalEl.addClass("mds-restore-modal");
		this.titleEl.setText(this.opts.title ?? "Compare with the note");
		const lines = diffLines(this.opts.mine, this.opts.theirs);
		const head = this.contentEl.createDiv({ cls: "mds-restore-diff-head" });
		head.createSpan({ cls: "mds-restore-diff-summary", text: describeDiff(diffStats(lines)) });
		head.createSpan({ cls: "mds-modal-note", text: this.opts.legend ?? "− in this grid · + in the note" });
		const body = this.contentEl.createDiv({ cls: "mds-restore-diff" });
		for (const line of lines) {
			const row = body.createDiv({ cls: `mds-diff-line is-${line.kind}` });
			row.createSpan({ cls: "mds-diff-gutter", text: line.kind === "add" ? "+" : line.kind === "remove" ? "\u2212" : " " });
			row.createSpan({ cls: "mds-diff-text", text: line.text });
		}
		const confirm = this.opts.confirm;
		if (confirm) {
			new Setting(this.contentEl)
				.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
				.addButton((b) =>
					b
						.setButtonText(confirm.label)
						.setCta()
						.onClick(() => {
							this.close();
							confirm.onConfirm();
						}),
				);
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Conditional formatting (decisions 37 and 39): the rules the table already carries, and the form
 * for adding one to the selection.
 *
 * Two things a rule needs to be usable, and both are here. **Seeing** it — every rule of the table
 * is listed with its range, its condition and its format, so a note that inherited rules from an
 * afternoon of experimenting still says what is going on. **Writing** a formula condition — the
 * value field suggests functions and column values, and the panel floats over the grid instead of
 * covering it, so a cell can be clicked and its address lands in the formula, exactly like the
 * formula bar.
 */
export class ConditionalFormatModal extends Modal {
	private op: ConditionalOp = ">";
	private value = "";
	private format: ConditionalFormat = "bold";
	private suggest: CellSuggest | null = null;
	private valueEl: HTMLInputElement | null = null;

	constructor(
		app: App,
		private readonly opts: {
			/** `F2:F9`, or `F2` for one cell — the range the comment will govern. */
			rangeLabel: string;
			/** Every rule the table carries, so they can be seen and removed. */
			rules: ConditionalRule[];
			/** Rules covering the selection, used to prefill the form. */
			existing: ConditionalRule[];
			onApply(rule: Omit<ConditionalRule, "row" | "col">): void;
			onClear(): void;
			onRemove(rule: ConditionalRule): void;
			onReveal(rule: ConditionalRule): void;
			/** Point mode: a click in the grid writes its address into the value field. */
			attachSink(sink: ReferenceSinkLike | null): void;
			columnValues(): string[];
			sourcePath: string;
		},
	) {
		super(app);
		const first = opts.existing[0];
		if (first !== undefined) {
			this.op = first.op;
			this.value = first.value;
			this.format = first.format;
		}
	}

	override onOpen(): void {
		this.containerEl.addClass("mds-cf-floating");
		this.titleEl.setText("Conditional formatting");

		if (this.opts.rules.length > 0) {
			new Setting(this.contentEl).setName("Rules in this table").setHeading();
			for (const rule of this.opts.rules) {
				new Setting(this.contentEl)
					.setName(`${ruleLabel(rule)} · ${describeCondition(rule)}`)
					.setDesc(`${FORMAT_LABELS[rule.format]} · written in ${colName(rule.col)}${rule.row + 1}`)
					.addButton((b) =>
						b.setButtonText("Show").onClick(() => {
							this.close();
							this.opts.onReveal(rule);
						}),
					)
					.addButton((b) =>
						b.setButtonText("Remove").onClick(() => {
							this.close();
							this.opts.onRemove(rule);
						}),
					);
			}
			new Setting(this.contentEl).setName("Add a rule").setHeading();
		}

		new Setting(this.contentEl)
			.setName("Range")
			.setDesc(`The selection this rule covers: ${this.opts.rangeLabel}. The rule itself is a comment in its first cell.`);

		new Setting(this.contentEl).setName("Condition").addDropdown((d) => {
			for (const op of [">", ">=", "<", "<=", "=", "<>", "contains", "if"] as ConditionalOp[]) {
				d.addOption(op, OP_LABELS[op]);
			}
			d.setValue(this.op).onChange((value) => {
				this.op = value as ConditionalOp;
				this.renderValue();
			});
		});

		new Setting(this.contentEl)
			.setName("Value")
			.setDesc("A number for the comparisons, text for the two equality operators and for contains — or a whole formula for the last option, evaluated cell by cell like a spreadsheet does.")
			.addText((t) => {
				t.setPlaceholder("1000").setValue(this.value);
				t.onChange((value) => {
					this.value = value;
				});
				this.valueEl = t.inputEl;
			});

		new Setting(this.contentEl).setName("Format").addDropdown((d) => {
			for (const format of ["bold", "italic", "strike", "code", "highlight"] as ConditionalFormat[]) {
				d.addOption(format, FORMAT_LABELS[format]);
			}
			d.setValue(this.format).onChange((value) => {
				this.format = value as ConditionalFormat;
			});
		});

		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Apply")
					.setCta()
					.onClick(() => {
						if (this.value.trim() === "" && this.op !== "=" && this.op !== "<>") return;
						this.close();
						this.opts.onApply({ r1: 0, c1: 0, r2: 0, c2: 0, op: this.op, value: this.value.trim(), format: this.format });
					}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

		this.renderValue();
	}

	/** The formula condition is the one field worth helping with: suggestions, and clicks in the grid. */
	private renderValue(): void {
		const input = this.valueEl;
		if (input === null) return;
		if (this.op !== "if") {
			this.suggest?.close();
			this.suggest = null;
			this.opts.attachSink(null);
			input.placeholder = "1000";
			return;
		}
		input.placeholder = "A formula, or click cells";
		if (this.suggest === null) {
			// The list is a sibling of the field, not a child of it: an `<input>` cannot hold elements.
			this.suggest = new CellSuggest(input.parentElement ?? this.contentEl, input, {
				app: this.app,
				sourcePath: this.opts.sourcePath,
				columnValues: () => this.opts.columnValues(),
				browseAll: true,
			});
			// `CellSuggest` does not listen by itself: the cell editor and the formula bar each call
			// `update()` from their own input handler, and this field is a third place a formula is
			// typed, so it needs the same two hooks.
			const suggest = this.suggest;
			input.addEventListener("input", () => suggest.update());
			input.addEventListener("keydown", (event) => {
				if (suggest.handleKey(event) === false) return;
				event.preventDefault();
				event.stopPropagation();
			});
		}
		this.opts.attachSink({
			// The host only points at cells while the text it holds starts with `=`. A rule's value
			// is an expression and may be written without it (`B2>1000`), so the sink reports one:
			// the field is a formula box for as long as this condition is chosen, and a click in the
			// grid is then a reference, as it is in Excel's own dialog.
			value: () => `=${input.value}`,
			selection: () => ({ start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length }),
			prefix: () => "",
			replace: (start, end, text) => {
				const next = input.value.slice(0, start) + text + input.value.slice(end);
				input.value = next;
				this.value = next;
				const caret = start + text.length;
				input.setSelectionRange(caret, caret);
				input.focus();
			},
		});
	}

	override onClose(): void {
		this.suggest?.close();
		this.suggest = null;
		this.opts.attachSink(null);
		this.contentEl.empty();
	}
}

/** The shape `GridHost.setReferenceSink` expects, without importing the host into a dialog. */
import type { ReferenceSinkLike } from "./toolModals";

export type { ReferenceSinkLike };

/** `F2` or `F2:K9`, the range a rule governs. */
export function ruleLabel(rule: ConditionalRule): string {
	const first = `${colName(rule.c1)}${rule.r1 + 1}`;
	const last = `${colName(rule.c2)}${rule.r2 + 1}`;
	return first === last ? first : `${first}:${last}`;
}

/** The condition in words: `> 1000`, `contains "done"`, `=SUM($B$2:B2)>1500`. */
export function describeCondition(rule: ConditionalRule): string {
	return rule.op === "if" ? rule.value : `${rule.op} ${rule.value}`.trim();
}

const OP_LABELS: Record<ConditionalOp, string> = {
	">": "is greater than",
	">=": "is at least",
	"<": "is less than",
	"<=": "is at most",
	"=": "equals",
	"<>": "is not",
	contains: "contains",
	if: "matches the formula",
};

const FORMAT_LABELS: Record<ConditionalFormat, string> = {
	bold: "Bold",
	italic: "Italic",
	strike: "Strikethrough",
	code: "Code",
	highlight: "Highlight",
};
