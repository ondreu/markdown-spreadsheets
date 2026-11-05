import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { createModel, recomputeUsedRange, setRaw, type GridModel } from "../model/GridModel";
import { parseTable } from "../model/parse";
import { formatNumber } from "../model/numbers";
import {
	consolidate,
	pivot,
	suggestGroupColumn,
	suggestValueColumn,
	withLookup,
	type PivotAggregate,
	type PivotOptions,
} from "../feature/pivot";
import { scanTables } from "../file/scanTables";
import type MarkdownSpreadsheetsPlugin from "../main";
import { GridHost } from "./GridHost";
import { defaultLayout } from "../store/Sidecar";
import { iconName } from "./icons";

export const VIEW_TYPE_PIVOT = "markdown-pivot-view";

interface PivotState {
	path: string;
	/** The table the view was opened from, so it starts on the right one. */
	tableIndex?: number;
}

const AGGREGATES: Array<[PivotAggregate, string]> = [
	["sum", "Sum"],
	["average", "Average"],
	["count", "Count"],
	["min", "Minimum"],
	["max", "Maximum"],
];

/**
 * A pivot as a temporary view.
 *
 * It is a real leaf with a real grid, but the grid is **read-only and belongs to no note**: the model
 * is built from the tables of one note, the settings above it pick which ones, and closing the tab
 * leaves nothing behind. No metadata, no sidecar, no generated table in the file — the note stays the
 * source of truth, and this is one way of looking at it.
 *
 * Several tables are consolidated first: rows appended, columns matched by header, so a month per
 * table (or a table per site) can be pivoted together without any of them being rewritten.
 */
export class PivotView extends ItemView {
	private path = "";
	private models: GridModel[] = [];
	private selected: boolean[] = [];
	private state: PivotOptions = { groupCol: 0, valueCol: 1, aggregate: "sum", sort: "value" };
	/** A column brought over from another table, off until asked for. */
	private lookup = { on: false, table: 0, keyCol: 0, tableKeyCol: 0, valueCol: 1 };
	private lookupNoteEl: HTMLElement | null = null;
	/** How many groups the last calculation produced, for the caption. */
	private lastGroups = 0;
	private host: GridHost | null = null;
	private hostEl: HTMLElement | null = null;
	private captionEl: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: MarkdownSpreadsheetsPlugin,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE_PIVOT;
	}

	override getDisplayText(): string {
		return "Pivot";
	}

	override getIcon(): string {
		return iconName("pivotTable");
	}

	override async setState(state: unknown, result: Parameters<ItemView["setState"]>[1]): Promise<void> {
		const incoming = (state ?? {}) as PivotState;
		await super.setState(state, result);
		if (incoming.path === undefined) return;
		this.path = incoming.path;
		await this.loadTables(incoming.tableIndex ?? 0);
	}

	override async onOpen(): Promise<void> {
		this.contentEl.addClass("markdown-pivot-view");
	}

	private async loadTables(from: number): Promise<void> {
		const file = this.app.vault.getFileByPath(this.path);
		if (!file) {
			new Notice(`Cannot find ${this.path}.`);
			return;
		}
		const text = await this.app.vault.cachedRead(file);
		this.models = scanTables(text).map((region) => parseTable(region.text));
		this.selected = this.models.map((_, i) => i === Math.min(from, this.models.length - 1));
		// Open on the columns that group and sum something, not on the first two there are.
		const source = this.models[Math.min(from, this.models.length - 1)];
		const group = suggestGroupColumn(source);
		this.state.groupCol = group;
		this.state.valueCol = suggestValueColumn(source, group);
		if (this.models.length === 0) {
			this.contentEl.empty();
			this.contentEl.createEl("p", { cls: "mds-pivot-empty", text: "This note has no table to pivot." });
			return;
		}
		this.build();
	}

	private build(): void {
		// The bar is rebuilt whenever the tables in play change, and it owns the element the grid is
		// mounted in — so the old host has to go, or it keeps drawing into a detached node.
		this.host?.destroy();
		this.host = null;
		this.contentEl.empty();
		const bar = this.contentEl.createDiv({ cls: "mds-pivot-bar" });

		const sources = bar.createDiv({ cls: "mds-pivot-sources", attr: { role: "group", "aria-label": "Tables to pivot" } });
		sources.createSpan({ cls: "mds-pivot-label", text: this.models.length > 1 ? "Tables" : "Table" });
		this.models.forEach((model, index) => {
			const button = sources.createEl("button", {
				cls: "mds-pivot-source",
				attr: { type: "button", "aria-pressed": String(this.selected[index]) },
			});
			button.toggleClass("is-on", this.selected[index]);
			const head = Array.from({ length: Math.min(2, Math.max(model.usedRange.cols, 1)) }, (_, c) => model.cells.get(`0:${c}`)?.raw ?? "")
				.filter((value) => value.trim() !== "")
				.join(", ");
			button.setText(head === "" ? `Table ${index + 1}` : head);
			button.setAttribute("title", `Table ${index + 1}${head === "" ? "" : `: ${head}`}`);
			button.addEventListener("click", () => {
				if (this.selected[index] && this.selected.filter(Boolean).length === 1) return;
				this.selected[index] = !this.selected[index];
				// The column lists belong to the chosen tables, so the whole bar is rebuilt.
				this.build();
			});
		});

		const controls = bar.createDiv({ cls: "mds-pivot-controls" });
		const select = (label: string, options: Array<[string, string]>, value: string, onChange: (value: string) => void): void => {
			const wrap = controls.createDiv({ cls: "mds-pivot-field" });
			const id = `mds-pivot-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
			wrap.createEl("label", { text: label, attr: { for: id } });
			const el = wrap.createEl("select", { attr: { id } });
			for (const [key, text] of options) {
				const option = el.createEl("option", { text, attr: { value: key } });
				if (key === value) option.selected = true;
			}
			el.addEventListener("change", () => onChange(el.value));
		};

		const columns = this.currentColumns().map((name, i): [string, string] => [String(i), name === "" ? `Column ${i + 1}` : name]);
		select("Group by", columns, String(Math.min(this.state.groupCol, Math.max(columns.length - 1, 0))), (value) => {
			this.state.groupCol = Number.parseInt(value, 10);
			this.refresh();
		});
		select("Values", columns, String(Math.min(this.state.valueCol, Math.max(columns.length - 1, 0))), (value) => {
			this.state.valueCol = Number.parseInt(value, 10);
			this.refresh();
		});
		select("Summarise", AGGREGATES.map(([key, label]): [string, string] => [key, label]), this.state.aggregate, (value) => {
			this.state.aggregate = value as PivotAggregate;
			this.refresh();
		});
		select("Order", [["value", "Largest first"], ["label", "Alphabetical"]], this.state.sort, (value) => {
			this.state.sort = value === "label" ? "label" : "value";
			this.refresh();
		});

		// A lookup is a second row of the bar, always visible: "None" is the default and the rest is
		// one select each. Changing the donor re-reads the columns it offers, so the bar is rebuilt.
		const lookupBar = this.contentEl.createDiv({ cls: "mds-pivot-bar mds-pivot-lookup" });
		const donor = this.lookup.on ? Math.min(this.lookup.table, this.models.length - 1) : -1;
		const provider = donor === -1 ? this.models[0] : this.models[donor];
		const providerCols = Array.from({ length: Math.max(provider.usedRange.cols, 1) }, (_, c): [string, string] => [
			String(c),
			(provider.cells.get(`0:${c}`)?.raw ?? "").trim() || `Column ${c + 1}`,
		]);
		const lookupControls = lookupBar.createDiv({ cls: "mds-pivot-controls" });
		const pick = (label: string, options: Array<[string, string]>, value: string, onChange: (value: string) => void): void => {
			const wrap = lookupControls.createDiv({ cls: "mds-pivot-field" });
			wrap.createEl("label", { text: label });
			const el = wrap.createEl("select");
			for (const [key, text] of options) {
				const option = el.createEl("option", { text, attr: { value: key } });
				if (key === value) option.selected = true;
			}
			el.addEventListener("change", () => {
				onChange(el.value);
				this.refresh();
			});
		};
		pick(
			"Lookup",
			[["none", "None"], ...this.models.map((_, i): [string, string] => [String(i), `Table ${i + 1}`])],
			donor === -1 ? "none" : String(donor),
			(value) => {
				this.lookup.on = value !== "none";
				this.lookup.table = value === "none" ? 0 : Number.parseInt(value, 10);
				this.lookup.tableKeyCol = 0;
				this.lookup.valueCol = providerCols.length > 1 ? 1 : 0;
				if (this.lookup.on) this.build();
			},
		);
		pick("match", columns, String(Math.min(this.lookup.keyCol, Math.max(columns.length - 1, 0))), (value) => {
			this.lookup.keyCol = Number.parseInt(value, 10);
		});
		pick("with", providerCols, String(Math.min(this.lookup.tableKeyCol, Math.max(providerCols.length - 1, 0))), (value) => {
			this.lookup.tableKeyCol = Number.parseInt(value, 10);
		});
		pick("bring", providerCols, String(Math.min(this.lookup.valueCol, Math.max(providerCols.length - 1, 0))), (value) => {
			this.lookup.valueCol = Number.parseInt(value, 10);
		});
		this.lookupNoteEl = lookupBar.createDiv({ cls: "mds-pivot-caption" });

		this.captionEl = bar.createDiv({ cls: "mds-pivot-caption" });
		bar.createDiv({
			cls: "mds-pivot-note",
			text: "Temporary view — nothing here is written to the note.",
		});

		this.hostEl = this.contentEl.createDiv({ cls: "mds-pivot-body" });
		this.refresh();
	}

	/** The headers of the tables in play, for the column pickers. */
	private currentColumns(): string[] {
		const chosen = this.models.filter((_, i) => this.selected[i]);
		if (chosen.length === 0) return [];
		const base = chosen.length === 1 ? chosen[0] : consolidate(chosen).model;
		let source = base;
		if (this.lookup.on && this.models.length > 1) {
			const donor = this.models[Math.min(this.lookup.table, this.models.length - 1)];
			const joined = withLookup(base, {
				keyCol: Math.min(this.lookup.keyCol, Math.max(base.usedRange.cols - 1, 0)),
				table: donor,
				tableKeyCol: Math.min(this.lookup.tableKeyCol, Math.max(donor.usedRange.cols - 1, 0)),
				tableValueCol: Math.min(this.lookup.valueCol, Math.max(donor.usedRange.cols - 1, 0)),
			});
			source = joined.model;
			this.lookupNoteEl?.setText(`${joined.matched} matched${joined.unmatched > 0 ? `, ${joined.unmatched} without a key` : ""}${joined.duplicates > 0 ? `, ${joined.duplicates} repeated key` : ""}`);
		}
		const cols = Math.max(source.usedRange.cols, 1);
		const names = Array.from({ length: cols }, (_, c) => (source.cells.get(`0:${c}`)?.raw ?? "").trim());
		if (this.lookup.on && this.models.length > 1) {
			const donor = this.models[Math.min(this.lookup.table, this.models.length - 1)];
			const header = donor.cells.get(`0:${Math.min(this.lookup.valueCol, Math.max(donor.usedRange.cols - 1, 0))}`)?.raw ?? "Lookup";
			names.push(`${header.trim()} (lookup)`);
		}
		return names;
	}

	/** The model the grid shows: the pivot of the selected tables, as values. */
	private pivotModel(): GridModel | null {
		const chosen = this.models.filter((_, i) => this.selected[i]);
		if (chosen.length === 0) return null;
		const base = chosen.length === 1 ? chosen[0] : consolidate(chosen).model;
		let source = base;
		if (this.lookup.on && this.models.length > 1) {
			const donor = this.models[Math.min(this.lookup.table, this.models.length - 1)];
			const joined = withLookup(base, {
				keyCol: Math.min(this.lookup.keyCol, Math.max(base.usedRange.cols - 1, 0)),
				table: donor,
				tableKeyCol: Math.min(this.lookup.tableKeyCol, Math.max(donor.usedRange.cols - 1, 0)),
				tableValueCol: Math.min(this.lookup.valueCol, Math.max(donor.usedRange.cols - 1, 0)),
			});
			source = joined.model;
			this.lookupNoteEl?.setText(`${joined.matched} matched${joined.unmatched > 0 ? `, ${joined.unmatched} without a key` : ""}${joined.duplicates > 0 ? `, ${joined.duplicates} repeated key` : ""}`);
		}
		const cols = Math.max(source.usedRange.cols, 1);
		const group = Math.min(this.state.groupCol, cols - 1);
		const value = Math.min(this.state.valueCol === group ? (group === 0 ? 1 : 0) : this.state.valueCol, cols - 1);
		const result = pivot(source, { ...this.state, groupCol: group, valueCol: value }, this.plugin.sidecar.settings.decimalSeparator ? { decimalSeparator: this.plugin.sidecar.settings.decimalSeparator } : undefined);
		this.lastGroups = result.groups.length;
		const model = createModel();
		setRaw(model, 0, 0, result.headers.label);
		setRaw(model, 0, 1, result.headers.value);
		result.groups.forEach((group, row) => {
			setRaw(model, row + 1, 0, group.label);
			setRaw(model, row + 1, 1, this.format(group.value));
		});
		if (result.groups.length > 1) {
			const at = result.groups.length + 1;
			setRaw(model, at, 0, "**Total**");
			setRaw(model, at, 1, `**${this.format(result.total)}**`);
		}
		model.colAlign = ["left", "right"];
		recomputeUsedRange(model);
		return model;
	}

	private format(value: number): string {
		const settings = this.plugin.sidecar.settings;
		return Number.isInteger(value)
			? formatNumber(value, 0, settings.numberLocale)
			: formatNumber(value, settings.defaultDecimals, settings.numberLocale);
	}

	private refresh(): void {
		const model = this.pivotModel();
		if (!this.hostEl) return;
		if (model === null) {
			this.host?.destroy();
			this.host = null;
			this.hostEl.empty();
			this.hostEl.createEl("p", { cls: "mds-pivot-empty", text: "Pick at least one table." });
			return;
		}
		const tables = this.selected.filter(Boolean).length;
		this.captionEl?.setText(`${this.lastGroups} ${this.lastGroups === 1 ? "group" : "groups"} from ${tables} ${tables === 1 ? "table" : "tables"}`);
		if (this.host !== null) {
			this.host.replaceData(model, defaultLayout(this.plugin.sidecar.settings));
			return;
		}
		this.hostEl.empty();
		this.host = new GridHost(
			{
				app: this.app,
				component: this,
				sourcePath: this.path,
				settings: this.plugin.sidecar.settings,
				touch: false,
				readOnly: true,
				callbacks: {
					onDirty: () => {},
					onLayoutChange: () => {},
					onSelectionChange: () => {},
					onNotice: () => {},
					onCalcPlaced: () => {},
				},
			},
			model,
			defaultLayout(this.plugin.sidecar.settings),
		);
		this.host.mount(this.hostEl);
	}

	override async onClose(): Promise<void> {
		this.host?.destroy();
		this.host = null;
	}
}
