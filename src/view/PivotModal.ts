import { Modal, Notice, Setting, type App } from "obsidian";
import type { GridModel } from "../model/GridModel";
import { aggregateName, pivot, pivotValues, type PivotAggregate, type PivotOptions } from "../feature/pivot";

/**
 * The pivot panel.
 *
 * A view, not a generated table: it reads the open table every time the dialog is shown and writes
 * nothing unless **Insert as a table** is pressed, which is a snapshot and says so. That is the only
 * honest shape without metadata — a pivot that regenerated itself would have to remember which rows
 * produced it, and this plugin keeps nothing outside the note.
 *
 * The preview is the part that matters: one header, a label column, a right-aligned number column in
 * tabular figures, a rule above the total, and a caption saying what was left out. It is the same
 * shape on a phone, where the dialog takes the full width.
 */
export class PivotModal extends Modal {
	private state: PivotOptions;
	private previewEl: HTMLElement | null = null;
	private captionEl: HTMLElement | null = null;
	private insertButton: HTMLButtonElement | null = null;
	private counts = { rows: 0, groups: 0, empty: 0, skipped: 0 };

	constructor(
		app: App,
		private readonly opts: {
			model: GridModel;
			/** Header text per column, for the dropdowns. */
			headers: string[];
			/** The column that groups best, chosen when the panel opens. */
			suggestedGroupCol?: number;
			/** The column with the most numbers, chosen as the value when the panel opens. */
			suggestedValueCol?: number;
			format(value: number): string;
			/** Writes the snapshot into the grid at the active cell. */
			insert(values: string[][]): void;
			copy(text: string): void;
		},
	) {
		super(app);
		const first = Math.max(opts.headers.length, 1);
		const group = Math.min(Math.max(opts.suggestedGroupCol ?? 0, 0), first - 1);
		const value = Math.min(Math.max(opts.suggestedValueCol ?? (group === 0 ? 1 : 0), 0), first - 1);
		this.state = {
			groupCol: group,
			valueCol: value,
			aggregate: "sum",
			sort: "value",
		};
	}

	override onOpen(): void {
		this.titleEl.setText("Pivot");
		this.modalEl.addClass("mds-pivot-modal");
		this.contentEl.createEl("p", {
			cls: "mds-modal-note",
			text: "Group the rows of this table by one column and add up another. The preview reads the table as it is now; nothing is written until you insert it.",
		});

		const columnDropdown = (setting: Setting, current: number, onChange: (col: number) => void): void => {
			setting.addDropdown((d) => {
				this.opts.headers.forEach((name, col) => {
					d.addOption(String(col), name === "" ? `Column ${col + 1}` : name);
				});
				d.setValue(String(current));
				d.onChange((value) => {
					onChange(Number.parseInt(value, 10));
					this.refresh();
				});
			});
		};

		new Setting(this.contentEl).setName("Group by").addDropdown((d) => {
			this.opts.headers.forEach((name, col) => {
				d.addOption(String(col), name === "" ? `Column ${col + 1}` : name);
			});
			d.setValue(String(this.state.groupCol));
			d.onChange((value) => {
				this.state.groupCol = Number.parseInt(value, 10);
				this.refresh();
			});
		});

		const values = new Setting(this.contentEl).setName("Values");
		columnDropdown(values, this.state.valueCol, (col) => (this.state.valueCol = col));

		new Setting(this.contentEl).setName("Summarise").addDropdown((d) => {
			for (const aggregate of ["sum", "average", "count", "min", "max"] as PivotAggregate[]) {
				d.addOption(aggregate, aggregateName(aggregate));
			}
			d.setValue(this.state.aggregate);
			d.onChange((value) => {
				this.state.aggregate = value as PivotAggregate;
				this.refresh();
			});
		});

		new Setting(this.contentEl).setName("Order").addDropdown((d) => {
			d.addOption("value", "Largest first");
			d.addOption("label", "Alphabetical");
			d.setValue(this.state.sort);
			d.onChange((value) => {
				this.state.sort = value === "label" ? "label" : "value";
				this.refresh();
			});
		});

		this.captionEl = this.contentEl.createEl("p", { cls: "mds-pivot-caption" });
		this.previewEl = this.contentEl.createDiv({ cls: "mds-pivot" });

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Copy as Markdown").onClick(() => this.copyMarkdown()))
			.addButton((b) => {
				this.insertButton = b.buttonEl;
				b.setButtonText("Insert as a table")
					.setCta()
					.onClick(() => this.insert());
			})
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));

		this.refresh();
	}

	private result(): ReturnType<typeof pivot> {
		return pivot(this.opts.model, this.state);
	}

	private refresh(): void {
		const result = this.result();
		const preview = this.previewEl;
		if (!preview || !this.captionEl) return;
		preview.empty();
		this.counts = { rows: 0, groups: result.groups.length, empty: result.empty, skipped: result.groups.reduce((n, g) => n + g.skipped, 0) };

		if (result.groups.length === 0) {
			preview.createDiv({ cls: "mds-pivot-empty", text: "Nothing to group: this column has no values below the header." });
			this.insertButton?.setAttribute("disabled", "true");
			this.captionEl.setText("");
			return;
		}
		this.insertButton?.removeAttribute("disabled");

		const scroll = preview.createDiv({ cls: "mds-pivot-scroll" });
		const table = scroll.createEl("table", { cls: "mds-pivot-table" });
		const head = table.createEl("thead").createEl("tr");
		head.createEl("th", { text: result.headers.label, attr: { scope: "col" } });
		head.createEl("th", { text: result.headers.value, attr: { scope: "col" }, cls: "is-number" });
		const body = table.createEl("tbody");
		for (const group of result.groups) {
			const row = body.createEl("tr");
			row.createEl("th", { text: group.label, attr: { scope: "row" } });
			row.createEl("td", { text: this.opts.format(group.value), cls: "is-number" });
		}
		if (result.groups.length > 1) {
			const foot = table.createEl("tfoot").createEl("tr");
			foot.createEl("th", { text: "Total", attr: { scope: "row" } });
			foot.createEl("td", { text: this.opts.format(result.total), cls: "is-number" });
		}

		const parts = [`${this.countRows(result)} rows`, `${result.groups.length} ${result.groups.length === 1 ? "group" : "groups"}`];
		if (result.empty > 0) parts.push(`${result.empty} without a value in ${result.headers.label}`);
		if (this.counts.skipped > 0) parts.push(`${this.counts.skipped} not a number`);
		if (result.hidden > 0) parts.push(`${result.hidden} more hidden`);
		this.captionEl.setText(parts.join(" · "));
	}

	private countRows(result: ReturnType<typeof pivot>): number {
		return result.groups.reduce((sum, group) => sum + group.rows, 0) + result.empty;
	}

	private markdown(): string {
		const result = this.result();
		const values = pivotValues(result, (value) => this.opts.format(value));
		const lines = values.map((row) => `| ${row.join(" | ")} |`);
		lines.splice(1, 0, `| ${values[0].map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`);
		return `${lines.join("\n")}\n`;
	}

	private copyMarkdown(): void {
		this.opts.copy(this.markdown());
	}

	private insert(): void {
		const result = this.result();
		if (result.groups.length === 0) return;
		const values = pivotValues(result, (value) => this.opts.format(value));
		this.opts.insert(values);
		new Notice(`Inserted the pivot as a snapshot: ${values.length} rows, values only.`);
		this.close();
	}
}
