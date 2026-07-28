import { Modal, Setting, type App } from "obsidian";
import { colName } from "../model/address";
import { describeDiff, diffLines, diffStats, relativeTime, tableShape } from "../feature/diff";
import type { GridModel } from "../model/GridModel";
import { previewOf } from "../file/scanTables";
import type { ScoredRegion } from "../file/AnchorResolver";
import type { BackupEntry } from "../store/Sidecar";
import { CALC_FUNCTIONS, applyFunction, type Aggregate, type CalcFunction } from "../feature/QuickCalc";
import { formatResult } from "../feature/QuickCalc";
import type { CsvOptions } from "../feature/exportCsv";
import type { FindOptions } from "../feature/ops";

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
	constructor(
		app: App,
		private readonly candidates: ScoredRegion[],
		private readonly onPick: (candidate: ScoredRegion) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Choose the right table");
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: "Several tables in this note look alike, so the earlier one could not be identified with confidence.",
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
				this.close();
				this.onPick(candidate);
			});
		}
	}

	override onClose(): void {
		this.contentEl.empty();
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

	constructor(
		app: App,
		private readonly opts: {
			onFind(options: FindOptions): number;
			onReplaceAll(options: FindOptions, replacement: string): number;
		},
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Find and replace");
		const status = this.contentEl.createDiv({ cls: "mds-modal-note" });

		new Setting(this.contentEl).setName("Find").addText((t) =>
			t.setValue(this.options.query).onChange((value) => {
				this.options.query = value;
				const n = this.opts.onFind(this.options);
				status.setText(value === "" ? "" : `${n} matching ${n === 1 ? "cell" : "cells"}`);
			}),
		);
		new Setting(this.contentEl).setName("Replace with").addText((t) =>
			t.onChange((value) => {
				this.replacement = value;
			}),
		);
		new Setting(this.contentEl).setName("Match case").addToggle((t) =>
			t.onChange((value) => {
				this.options.matchCase = value;
			}),
		);
		new Setting(this.contentEl)
			.setName("Match the whole cell")
			.setDesc("Replaces the entire cell rather than the matching part.")
			.addToggle((t) =>
				t.onChange((value) => {
					this.options.wholeCell = value;
				}),
			);
		new Setting(this.contentEl).setName("Regular expression").addToggle((t) =>
			t.onChange((value) => {
				this.options.regex = value;
			}),
		);

		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Replace all")
					.setCta()
					.onClick(() => {
						const n = this.opts.onReplaceAll(this.options, this.replacement);
						status.setText(`Replaced in ${n} ${n === 1 ? "cell" : "cells"}`);
					}),
			)
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export class SortModal extends Modal {
	private col: number;
	private ascending = true;
	private selectionOnly = false;

	constructor(
		app: App,
		private readonly opts: {
			model: GridModel;
			defaultCol: number;
			hasMultiRowSelection: boolean;
			onSort(col: number, ascending: boolean, selectionOnly: boolean): void;
		},
	) {
		super(app);
		this.col = opts.defaultCol;
	}

	override onOpen(): void {
		this.titleEl.setText("Sort");
		const cols = Math.max(this.opts.model.usedRange.cols, 1);

		new Setting(this.contentEl).setName("Sort by").addDropdown((d) => {
			for (let c = 0; c < cols; c++) {
				const header = this.opts.model.cells.get(`0:${c}`)?.raw ?? "";
				d.addOption(String(c), header === "" ? colName(c) : `${colName(c)} — ${header}`);
			}
			d.setValue(String(this.col)).onChange((value) => {
				this.col = Number.parseInt(value, 10);
			});
		});

		new Setting(this.contentEl).setName("Order").addDropdown((d) =>
			d
				.addOption("asc", "Ascending")
				.addOption("desc", "Descending")
				.setValue("asc")
				.onChange((value) => {
					this.ascending = value === "asc";
				}),
		);

		if (this.opts.hasMultiRowSelection) {
			new Setting(this.contentEl)
				.setName("Selected rows only")
				.setDesc("Leave off to sort every data row. The header row never moves.")
				.addToggle((t) =>
					t.onChange((value) => {
						this.selectionOnly = value;
					}),
				);
		}

		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Sort")
					.setCta()
					.onClick(() => {
						this.close();
						this.opts.onSort(this.col, this.ascending, this.selectionOnly);
					}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export class FilterModal extends Modal {
	private readonly queries = new Map<number, string>();

	constructor(
		app: App,
		private readonly opts: {
			model: GridModel;
			current: Array<{ col: number; query: string }>;
			onApply(filters: Array<{ col: number; query: string }>): void;
		},
	) {
		super(app);
		for (const f of opts.current) this.queries.set(f.col, f.query);
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
								.map(([col, query]) => ({ col, query })),
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
}

export class ExportModal extends Modal {
	private fileName: string;
	private csv: CsvOptions;
	private detectNumbers = true;

	constructor(
		app: App,
		private readonly opts: {
			format: "csv" | "xlsx";
			defaultName: string;
			csvDefaults: CsvOptions;
			onExport(choice: ExportChoice): void;
		},
	) {
		super(app);
		this.fileName = opts.defaultName;
		this.csv = Object.assign({}, opts.csvDefaults, {});
	}

	override onOpen(): void {
		const isCsv = this.opts.format === "csv";
		this.titleEl.setText(isCsv ? "Export to CSV" : "Export to Excel");

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
		} else {
			new Setting(this.contentEl)
				.setName("Convert numbers")
				.setDesc("Cells that look numeric become real numbers instead of text.")
				.addToggle((t) =>
					t.setValue(this.detectNumbers).onChange((value) => {
						this.detectNumbers = value;
					}),
				);
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
						});
					}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

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
			item.createDiv({ cls: "mds-restore-stamp", text: new Date(entry.at).toLocaleString() });
			const shape = tableShape(entry.text);
			const same = entry.text.trimEnd() === this.opts.current.trimEnd();
			item.createDiv({ cls: "mds-restore-shape", text: same ? `${shape} · same as now` : shape });
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
		private readonly opts: { mine: string; theirs: string },
	) {
		super(app);
	}

	override onOpen(): void {
		this.modalEl.addClass("mds-restore-modal");
		this.titleEl.setText("Compare with the note");
		const lines = diffLines(this.opts.mine, this.opts.theirs);
		const head = this.contentEl.createDiv({ cls: "mds-restore-diff-head" });
		head.createSpan({ cls: "mds-restore-diff-summary", text: describeDiff(diffStats(lines)) });
		head.createSpan({ cls: "mds-modal-note", text: "− in this grid · + in the note" });
		const body = this.contentEl.createDiv({ cls: "mds-restore-diff" });
		for (const line of lines) {
			const row = body.createDiv({ cls: `mds-diff-line is-${line.kind}` });
			row.createSpan({ cls: "mds-diff-gutter", text: line.kind === "add" ? "+" : line.kind === "remove" ? "\u2212" : " " });
			row.createSpan({ cls: "mds-diff-text", text: line.text });
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
