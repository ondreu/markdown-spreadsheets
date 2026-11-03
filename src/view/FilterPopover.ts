import type { ColumnFilter, FilterKind } from "../feature/transform";
import { plainText } from "../feature/exportCsv";
import { asElement, asNode } from "./dom";

export interface FilterPopoverOptions {
	col: number;
	title: string;
	/** Distinct values of the column; "" stands for an empty cell. */
	values: string[];
	current: ColumnFilter | null;
	onSort(ascending: boolean): void;
	onApply(filter: ColumnFilter | null): void;
	onClose(): void;
}

const CONDITIONS: Array<[FilterKind, string]> = [
	["contains", "Contains"],
	["notContains", "Does not contain"],
	["equals", "Equals"],
	["notEquals", "Does not equal"],
	["startsWith", "Starts with"],
	["endsWith", "Ends with"],
	["gt", "Greater than"],
	["gte", "Greater than or equal"],
	["lt", "Less than"],
	["lte", "Less than or equal"],
	["empty", "Is empty"],
	["notEmpty", "Is not empty"],
];

/**
 * The drop-down behind the arrow in a column header: sort, a condition, or a checklist of the
 * column's values — the spreadsheet AutoFilter. Clicking the header itself still selects the
 * column; only the arrow opens this.
 *
 * Plain DOM in the grid host rather than a `Menu`, because it needs inputs and checkboxes. It is
 * display-only like every filter here (§11): hidden rows are still written to the note.
 */
export class FilterPopover {
	private readonly el: HTMLElement;
	private readonly offDocument: () => void;

	constructor(parent: HTMLElement, anchor: HTMLElement, private readonly opts: FilterPopoverOptions) {
		this.el = parent.createDiv({ cls: "mds-filter-popover" });
		const parentBox = parent.getBoundingClientRect();
		const box = anchor.getBoundingClientRect();
		const left = Math.max(4, Math.min(box.left - parentBox.left, parentBox.width - 260));
		this.el.setCssProps({ "--mds-pop-x": `${left}px`, "--mds-pop-y": `${box.bottom - parentBox.top + 2}px` });
		this.build();

		const doc = parent.ownerDocument;
		const onDown = (evt: MouseEvent) => {
			const node = asNode(evt.target);
			if (node !== null && (this.el.contains(node) || anchor.contains(node))) return;
			this.close();
		};
		const onKey = (evt: KeyboardEvent) => {
			if (evt.key !== "Escape") return;
			evt.stopPropagation();
			this.close();
		};
		doc.addEventListener("mousedown", onDown, true);
		this.el.addEventListener("keydown", onKey);
		this.offDocument = () => doc.removeEventListener("mousedown", onDown, true);
	}

	close(): void {
		this.offDocument();
		this.el.detach();
		this.opts.onClose();
	}

	private build(): void {
		const { current } = this.opts;
		this.el.createDiv({ cls: "mds-filter-title", text: this.opts.title });

		const sort = this.el.createDiv({ cls: "mds-filter-row" });
		const asc = sort.createEl("button", { text: "Sort ascending", attr: { type: "button" } });
		const desc = sort.createEl("button", { text: "Sort descending", attr: { type: "button" } });
		asc.addEventListener("click", () => {
			this.opts.onSort(true);
			this.close();
		});
		desc.addEventListener("click", () => {
			this.opts.onSort(false);
			this.close();
		});

		this.el.createDiv({ cls: "mds-filter-label", text: "Condition" });
		const condRow = this.el.createDiv({ cls: "mds-filter-row" });
		const select = condRow.createEl("select", { cls: "dropdown" });
		select.createEl("option", { text: "None", attr: { value: "" } });
		for (const [kind, label] of CONDITIONS) select.createEl("option", { text: label, attr: { value: kind } });
		const query = condRow.createEl("input", { attr: { type: "text", placeholder: "Value", spellcheck: "false" } });
		if (current && current.kind !== "values") {
			select.value = current.kind;
			query.value = current.query ?? "";
		}
		const syncQuery = () => query.toggleClass("mds-hidden", select.value === "" || select.value === "empty" || select.value === "notEmpty");
		select.addEventListener("change", syncQuery);
		syncQuery();

		this.el.createDiv({ cls: "mds-filter-label", text: "Values" });
		const search = this.el.createEl("input", { attr: { type: "search", placeholder: "Search values", spellcheck: "false" } });
		const list = this.el.createDiv({ cls: "mds-filter-values" });
		const chosen = new Set<string>(current?.kind === "values" ? (current.values ?? []) : this.opts.values);
		const boxes: Array<{ value: string; row: HTMLElement; box: HTMLInputElement }> = [];
		const allRow = list.createEl("label", { cls: "mds-filter-value is-all" });
		const allBox = allRow.createEl("input", { attr: { type: "checkbox" } });
		allRow.createSpan({ text: "Select all" });
		for (const value of this.opts.values) {
			const row = list.createEl("label", { cls: "mds-filter-value" });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = chosen.has(value);
			// Shown as the note shows it; matched on the Markdown source.
			row.createSpan({ text: value === "" ? "(empty)" : plainText(value) || value });
			boxes.push({ value, row, box });
		}
		const syncAll = () => {
			const visible = boxes.filter((b) => !b.row.hasClass("mds-hidden"));
			allBox.checked = visible.length > 0 && visible.every((b) => b.box.checked);
		};
		syncAll();
		allBox.addEventListener("change", () => {
			for (const b of boxes) if (!b.row.hasClass("mds-hidden")) b.box.checked = allBox.checked;
		});
		list.addEventListener("change", (evt) => {
			if (asElement(evt.target) !== allBox) syncAll();
		});
		search.addEventListener("input", () => {
			const q = search.value.trim().toLowerCase();
			for (const b of boxes) b.row.toggleClass("mds-hidden", q !== "" && !plainText(b.value).toLowerCase().includes(q));
			syncAll();
		});

		const actions = this.el.createDiv({ cls: "mds-filter-actions" });
		const clear = actions.createEl("button", { text: "Clear", attr: { type: "button" } });
		const apply = actions.createEl("button", { cls: "mod-cta", text: "Apply", attr: { type: "button" } });
		clear.addEventListener("click", () => {
			this.opts.onApply(null);
			this.close();
		});
		apply.addEventListener("click", () => {
			const col = this.opts.col;
			const kind = select.value as FilterKind | "";
			let filter: ColumnFilter | null = null;
			if (kind !== "") {
				filter = { col, kind, query: query.value };
			} else {
				const values = boxes.filter((b) => b.box.checked).map((b) => b.value);
				// Everything ticked is the same as no filter at all.
				if (values.length < boxes.length) filter = { col, kind: "values", values };
			}
			this.opts.onApply(filter);
			this.close();
		});
		query.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") apply.click();
		});
		window.setTimeout(() => (current?.kind === "values" || current === null ? search : query).focus(), 0);
	}
}
