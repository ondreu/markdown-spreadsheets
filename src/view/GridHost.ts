import { Component, MarkdownRenderer, Menu, type App } from "obsidian";
import { cellLabel, colName, rangeLabel } from "../model/address";
import { getRaw, recomputeUsedRange, setRaw, type Align, type GridModel } from "../model/GridModel";
import { fnv1a } from "../model/hash";
import type { NumberParseOptions } from "../model/numbers";
import type { MarkdownGridSettings } from "../settings";
import type { TableLayout } from "../store/Sidecar";
import { fromTsv, looksLikeGrid, toTsv } from "../feature/clipboard";
import {
	applyInlineFormat,
	clearRange,
	deleteCols,
	deleteRows,
	fillRange,
	insertCols,
	insertRows,
	moveCol,
	moveRow,
	normalizeRect,
	readRange,
	rectCols,
	rectRows,
	setColAlign,
	writeRange,
	type InlineFormat,
	type Rect,
} from "../feature/ops";
import { UndoStack } from "../feature/undo";
import {
	AUTOFIT_MAX_WIDTH,
	GROW_COLS,
	GROW_ROWS,
	GROW_THRESHOLD_COLS,
	GROW_THRESHOLD_ROWS,
	HEAD_HEIGHT,
	MAX_COLS,
	MAX_COL_WIDTH,
	MAX_ROWS,
	MAX_ROW_HEIGHT,
	MIN_COL_WIDTH,
	MIN_ROW_HEIGHT,
	RESIZE_GRIP,
	ROW_HEAD_WIDTH,
} from "./constants";
import { asElement } from "./dom";
import { GridStyles, type GeometrySpec } from "./gridStyles";

export interface Selection {
	rect: Rect;
	/** The cell that receives typing; always inside `rect`. */
	active: { row: number; col: number };
}

export interface ColumnFilter {
	col: number;
	query: string;
}

export interface GridHostCallbacks {
	/** The model changed and the note is now out of date. */
	onDirty(label: string): void;
	/** Cosmetic state changed; only the sidecar needs to know. */
	onLayoutChange(): void;
	onSelectionChange(selection: Selection): void;
	onNotice(message: string): void;
	/** A calculated value was placed, so the pending-target mode can end. */
	onCalcPlaced(): void;
}

export interface GridHostContext {
	app: App;
	/** The view, never the plugin — `no-plugin-as-component` (§15.2, §5). */
	component: Component;
	sourcePath: string;
	settings: MarkdownGridSettings;
	callbacks: GridHostCallbacks;
}

type RenderMode = "raw" | "rendered";

interface PendingCalc {
	label: string;
	text: string;
}

/**
 * The grid itself: plain DOM, no virtualization (D8).
 *
 * 500 rows × 30 columns is ~15 000 elements, which the browser lays out without help. A
 * windowing layer would add scroll jitter, lost focus and broken selection for no gain at this
 * scale, so rows are only ever appended (grow-on-demand, §9) and never recycled.
 */
export class GridHost {
	private model: GridModel;
	private layout: TableLayout;
	readonly undo = new UndoStack();

	private hostEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private canvasEl!: HTMLElement;
	private headRowEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private fillHandleEl!: HTMLElement;
	private readonly rowEls = new Map<number, HTMLElement>();
	private readonly colHeadEls = new Map<number, HTMLElement>();

	private rows = 0;
	private cols = 0;
	private selection: Selection = { rect: { r1: 0, c1: 0, r2: 0, c2: 0 }, active: { row: 0, col: 0 } };
	private selectedEls: HTMLElement[] = [];
	private editing: { row: number; col: number; input: HTMLInputElement; original: string } | null = null;
	private renderMode: RenderMode;
	private renderCache = new Map<string, DocumentFragment>();
	private observer: IntersectionObserver | null = null;
	private filters: ColumnFilter[] = [];
	private hiddenRows = new Set<number>();
	private pendingCalc: PendingCalc | null = null;
	private readonly styles = new GridStyles();
	private geometryTimer: number | null = null;
	private mouseSelecting = false;
	private fillDrag: { source: Rect; last: Rect } | null = null;
	private cleanup: Array<() => void> = [];

	constructor(
		private readonly ctx: GridHostContext,
		model: GridModel,
		layout: TableLayout,
	) {
		this.model = model;
		this.layout = layout;
		this.renderMode = ctx.settings.defaultRenderMode;
	}

	/* ------------------------------------------------------------- lifecycle */

	mount(parent: HTMLElement): void {
		this.hostEl = parent.createDiv({ cls: "mg-host" });
		this.hintEl = this.hostEl.createDiv({ cls: "mg-hint mg-hidden" });
		this.scrollEl = this.hostEl.createDiv({ cls: "mg-scroll", attr: { tabindex: "0" } });
		this.canvasEl = this.scrollEl.createDiv({ cls: "mg-canvas" });
		this.fillHandleEl = this.canvasEl.createDiv({ cls: "mg-fill-handle mg-hidden" });

		const mode = this.styles.attach(this.hostEl);
		if (mode === "inline") {
			this.ctx.callbacks.onNotice("Constructable stylesheets are unavailable; row sizing falls back to per-row styles.");
		}

		this.rows = this.initialRows();
		this.cols = this.initialCols();
		this.build();
		this.registerEvents();
		this.setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 }, { row: 0, col: 0 });
	}

	destroy(): void {
		this.cancelEdit();
		if (this.geometryTimer !== null) window.clearTimeout(this.geometryTimer);
		this.observer?.disconnect();
		this.observer = null;
		for (const off of this.cleanup) off();
		this.cleanup = [];
		this.styles.detach(this.hostEl);
		this.renderCache.clear();
		this.hostEl.detach();
	}

	focus(): void {
		this.scrollEl.focus();
	}

	/* ----------------------------------------------------------------- state */

	getModel(): GridModel {
		return this.model;
	}

	getLayout(): TableLayout {
		return this.layout;
	}

	getSelection(): Selection {
		return this.selection;
	}

	isEditing(): boolean {
		return this.editing !== null;
	}

	getRenderMode(): RenderMode {
		return this.renderMode;
	}

	getGeometryMode(): "stylesheet" | "inline" {
		return this.styles.getMode();
	}

	getFilters(): ColumnFilter[] {
		return this.filters.slice();
	}

	numberOpts(): NumberParseOptions {
		return { decimalSeparator: this.ctx.settings.decimalSeparator };
	}

	/** Swaps in a new model/layout (undo, reload after an external change, table switch). */
	replaceData(model: GridModel, layout: TableLayout, keepSelection = true): void {
		this.cancelEdit();
		this.model = model;
		this.layout = layout;
		this.renderCache.clear();
		const before = this.selection;
		this.rows = Math.max(this.rows, this.initialRows());
		this.cols = Math.max(this.cols, this.initialCols());
		this.build();
		this.applyFilters();
		if (keepSelection) {
			const row = Math.min(before.active.row, this.rows - 1);
			const col = Math.min(before.active.col, this.cols - 1);
			this.setSelection({ r1: row, c1: col, r2: row, c2: col }, { row, col });
		} else {
			this.setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 }, { row: 0, col: 0 });
		}
	}

	private initialRows(): number {
		return Math.min(MAX_ROWS, Math.max(this.model.usedRange.rows + this.ctx.settings.padRows, 100));
	}

	private initialCols(): number {
		return Math.min(MAX_COLS, Math.max(this.model.usedRange.cols + this.ctx.settings.padCols, 26));
	}

	/* ----------------------------------------------------------------- build */

	private build(): void {
		this.canvasEl.empty();
		this.rowEls.clear();
		this.colHeadEls.clear();
		this.selectedEls = [];
		this.observer?.disconnect();
		this.observer = null;

		this.fillHandleEl = this.canvasEl.createDiv({ cls: "mg-fill-handle mg-hidden" });
		this.headRowEl = this.canvasEl.createDiv({ cls: "mg-row mg-head-row" });
		this.headRowEl.createDiv({ cls: "mg-corner", attr: { "aria-hidden": "true" } });
		for (let c = 0; c < this.cols; c++) this.appendColHead(c);

		const frag = this.canvasEl.ownerDocument.win.createFragment();
		for (let r = 0; r < this.rows; r++) frag.append(this.buildRow(r));
		this.canvasEl.append(frag);

		this.applyGeometry(true);
		this.markUsedRange();
		if (this.renderMode === "rendered") this.setupObserver();
	}

	private appendColHead(c: number): void {
		const el = this.headRowEl.createDiv({
			cls: "mg-colhead",
			text: colName(c),
			attr: { "data-col": String(c) },
		});
		if (c < this.layout.frozenCols) el.addClass("is-frozen-col");
		this.colHeadEls.set(c, el);
	}

	private buildRow(r: number): HTMLElement {
		const win = this.canvasEl.ownerDocument.win;
		const rowEl = win.createDiv({ cls: `mg-row mg-r${r}`, attr: { "data-row": String(r) } });
		if (r === 0) rowEl.addClass("is-header-row");
		if (r < this.layout.frozenRows) rowEl.addClass("is-frozen-row");

		// Row 0 is the markdown header row; label it so its special status is visible (§9).
		rowEl.createDiv({ cls: "mg-rowhead", text: String(r + 1), attr: { "data-row": String(r) } });

		for (let c = 0; c < this.cols; c++) rowEl.append(this.buildCell(r, c));
		this.rowEls.set(r, rowEl);
		return rowEl;
	}

	private buildCell(r: number, c: number): HTMLElement {
		const el = this.canvasEl.ownerDocument.win.createDiv({
			cls: "mg-cell",
			attr: { "data-row": String(r), "data-col": String(c) },
		});
		if (c < this.layout.frozenCols) el.addClass("is-frozen-col");
		if (this.layout.wrapCols.includes(c)) el.addClass("is-wrap");
		const align = this.model.colAlign[c];
		if (align) el.addClass(`is-align-${align}`);
		this.paintCell(el, r, c);
		return el;
	}

	private cellEl(r: number, c: number): HTMLElement | null {
		const rowEl = this.rowEls.get(r);
		if (!rowEl) return null;
		const el = rowEl.children.item(c + 1);
		return el !== null && el.instanceOf(HTMLElement) ? el : null;
	}

	private paintCell(el: HTMLElement, r: number, c: number): void {
		const raw = getRaw(this.model, r, c);
		el.empty();
		el.removeClass("is-rendered");
		if (raw === "") {
			el.removeAttribute("aria-label");
			return;
		}
		if (this.renderMode === "rendered") {
			// Content arrives when the cell scrolls into view; until then the raw text is shown
			// so the grid never looks empty.
			el.setText(raw);
			el.dataset.pending = "1";
		} else {
			el.setText(raw);
		}
		// Full content in the tooltip, because a non-wrapped cell ellipsizes (§8.3).
		el.setAttribute("aria-label", raw);
	}

	private repaintCell(r: number, c: number): void {
		const el = this.cellEl(r, c);
		if (!el) return;
		this.paintCell(el, r, c);
		if (this.renderMode === "rendered") void this.renderCell(el, r, c);
		this.updateUsedRangeFor(r, c);
	}

	private repaintAll(): void {
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) {
				const el = this.cellEl(r, c);
				if (el) this.paintCell(el, r, c);
			}
		}
		this.markUsedRange();
		if (this.renderMode === "rendered") this.setupObserver();
	}

	/* ------------------------------------------------------- used range paint */

	/** Visually separates what will be written from what is only scratch space (§9). */
	private markUsedRange(): void {
		const { rows, cols } = this.model.usedRange;
		for (let r = 0; r < this.rows; r++) {
			const rowEl = this.rowEls.get(r);
			if (!rowEl) continue;
			rowEl.toggleClass("is-outside", r >= rows);
			for (let c = 0; c < this.cols; c++) {
				const el = this.cellEl(r, c);
				if (el) el.toggleClass("is-outside", r >= rows || c >= cols);
			}
		}
		for (let c = 0; c < this.cols; c++) this.colHeadEls.get(c)?.toggleClass("is-outside", c >= cols);
	}

	private updateUsedRangeFor(_r: number, _c: number): void {
		// The bounding box can grow or shrink from a single edit, so repaint the flags wholesale.
		this.markUsedRange();
	}

	/* ------------------------------------------------------------- geometry */

	private geometrySpec(): GeometrySpec {
		return {
			rowDefault: this.layout.rowHeightDefault ?? this.ctx.settings.defaultRowHeight,
			rowHeights: this.layout.rowHeights,
			colWidths: this.layout.colWidths,
			colDefault: this.ctx.settings.defaultColWidth,
			frozenRows: this.layout.frozenRows,
			frozenCols: this.layout.frozenCols,
			headHeight: HEAD_HEIGHT,
			rowHeadWidth: ROW_HEAD_WIDTH,
			rowCount: this.rows,
			colCount: this.cols,
		};
	}

	/** `immediate` is for structural changes; drags coalesce (§8.5/4). */
	applyGeometry(immediate = false): void {
		const spec = this.geometrySpec();
		this.styles.applyColumnWidths(this.hostEl, spec);
		const run = () => {
			this.styles.applyGeometry(this.geometrySpec(), this.rowEls);
			this.positionFillHandle();
		};
		if (immediate) {
			if (this.geometryTimer !== null) {
				window.clearTimeout(this.geometryTimer);
				this.geometryTimer = null;
			}
			run();
			return;
		}
		if (this.geometryTimer !== null) window.clearTimeout(this.geometryTimer);
		this.geometryTimer = window.setTimeout(() => {
			this.geometryTimer = null;
			run();
		}, 60);
	}

	/* ------------------------------------------------------ grow on demand */

	/**
	 * Appends rows/columns when the viewport approaches the end.
	 *
	 * Rows are never removed, which is the whole reason this is two orders of magnitude simpler
	 * than windowing (§9).
	 */
	private maybeGrow(): void {
		const rowH = this.layout.rowHeightDefault ?? this.ctx.settings.defaultRowHeight;
		const bottomGap = this.scrollEl.scrollHeight - (this.scrollEl.scrollTop + this.scrollEl.clientHeight);
		if (bottomGap < rowH * GROW_THRESHOLD_ROWS) this.growRows(GROW_ROWS);

		const colW = this.ctx.settings.defaultColWidth;
		const rightGap = this.scrollEl.scrollWidth - (this.scrollEl.scrollLeft + this.scrollEl.clientWidth);
		if (rightGap < colW * GROW_THRESHOLD_COLS) this.growCols(GROW_COLS);
	}

	private growRows(count: number): boolean {
		if (this.rows >= MAX_ROWS) {
			this.ctx.callbacks.onNotice("Grid limit reached. This plugin targets tables up to ~500 rows.");
			return false;
		}
		const target = Math.min(MAX_ROWS, this.rows + count);
		const frag = this.canvasEl.ownerDocument.win.createFragment();
		for (let r = this.rows; r < target; r++) frag.append(this.buildRow(r));
		this.canvasEl.append(frag);
		this.rows = target;
		this.applyGeometry(true);
		this.markUsedRange();
		return true;
	}

	private growCols(count: number): boolean {
		if (this.cols >= MAX_COLS) {
			this.ctx.callbacks.onNotice(`Column limit reached (${MAX_COLS} columns).`);
			return false;
		}
		const target = Math.min(MAX_COLS, this.cols + count);
		for (let c = this.cols; c < target; c++) this.appendColHead(c);
		for (const [r, rowEl] of this.rowEls) {
			for (let c = this.cols; c < target; c++) rowEl.append(this.buildCell(r, c));
		}
		this.cols = target;
		this.applyGeometry(true);
		this.markUsedRange();
		return true;
	}

	/** Makes sure `row`/`col` exist in the DOM, growing if needed. Returns false at the cap. */
	private ensureExtent(row: number, col: number): boolean {
		let ok = true;
		while (row >= this.rows && ok) ok = this.growRows(Math.max(GROW_ROWS, row - this.rows + 1));
		while (col >= this.cols && ok) ok = this.growCols(Math.max(GROW_COLS, col - this.cols + 1));
		return ok && row < this.rows && col < this.cols;
	}

	/* ---------------------------------------------------------- selection */

	setSelection(rect: Rect, active?: { row: number; col: number }): void {
		const norm = normalizeRect(rect);
		const bounded: Rect = {
			r1: Math.max(0, Math.min(norm.r1, this.rows - 1)),
			c1: Math.max(0, Math.min(norm.c1, this.cols - 1)),
			r2: Math.max(0, Math.min(norm.r2, this.rows - 1)),
			c2: Math.max(0, Math.min(norm.c2, this.cols - 1)),
		};
		const act = active ?? { row: bounded.r1, col: bounded.c1 };
		this.selection = {
			rect: bounded,
			active: {
				row: Math.max(bounded.r1, Math.min(act.row, bounded.r2)),
				col: Math.max(bounded.c1, Math.min(act.col, bounded.c2)),
			},
		};
		this.paintSelection();
		this.ctx.callbacks.onSelectionChange(this.selection);
	}

	private paintSelection(): void {
		for (const el of this.selectedEls) {
			el.removeClass("is-selected");
			el.removeClass("is-active");
		}
		this.selectedEls = [];
		for (let c = 0; c < this.cols; c++) this.colHeadEls.get(c)?.removeClass("is-selected");
		for (const rowEl of this.rowEls.values()) {
			const head = rowEl.firstElementChild;
			if (head !== null && head.instanceOf(HTMLElement)) head.removeClass("is-selected");
		}

		const { rect, active } = this.selection;
		for (let r = rect.r1; r <= rect.r2; r++) {
			const rowEl = this.rowEls.get(r);
			if (!rowEl) continue;
			const head = rowEl.firstElementChild;
			if (head !== null && head.instanceOf(HTMLElement)) head.addClass("is-selected");
			for (let c = rect.c1; c <= rect.c2; c++) {
				const el = this.cellEl(r, c);
				if (!el) continue;
				el.addClass("is-selected");
				this.selectedEls.push(el);
			}
		}
		for (let c = rect.c1; c <= rect.c2; c++) this.colHeadEls.get(c)?.addClass("is-selected");
		const activeEl = this.cellEl(active.row, active.col);
		if (activeEl) {
			activeEl.addClass("is-active");
			if (!this.selectedEls.includes(activeEl)) this.selectedEls.push(activeEl);
		}
		this.positionFillHandle();
	}

	private positionFillHandle(): void {
		const rect = this.selection.rect;
		const anchor = this.cellEl(rect.r2, rect.c2);
		if (!anchor || this.editing) {
			this.fillHandleEl.addClass("mg-hidden");
			return;
		}
		this.fillHandleEl.removeClass("mg-hidden");
		this.fillHandleEl.setCssProps({
			"--mg-fill-x": `${anchor.offsetLeft + anchor.offsetWidth}px`,
			"--mg-fill-y": `${anchor.offsetTop + anchor.offsetHeight}px`,
		});
	}

	private scrollIntoView(row: number, col: number): void {
		const el = this.cellEl(row, col);
		if (!el) return;
		const top = el.offsetTop;
		const left = el.offsetLeft;
		const bottom = top + el.offsetHeight;
		const right = left + el.offsetWidth;
		const viewTop = this.scrollEl.scrollTop + HEAD_HEIGHT;
		const viewLeft = this.scrollEl.scrollLeft + ROW_HEAD_WIDTH;
		const viewBottom = this.scrollEl.scrollTop + this.scrollEl.clientHeight;
		const viewRight = this.scrollEl.scrollLeft + this.scrollEl.clientWidth;

		if (top < viewTop) this.scrollEl.scrollTop = top - HEAD_HEIGHT;
		else if (bottom > viewBottom) this.scrollEl.scrollTop = bottom - this.scrollEl.clientHeight;
		if (left < viewLeft) this.scrollEl.scrollLeft = left - ROW_HEAD_WIDTH;
		else if (right > viewRight) this.scrollEl.scrollLeft = right - this.scrollEl.clientWidth;
	}

	/* ------------------------------------------------------------ navigation */

	/** Moves the active cell. `extend` grows the selection instead of collapsing it. */
	moveActive(dRow: number, dCol: number, extend = false): void {
		const { active, rect } = this.selection;
		let row = Math.max(0, active.row + dRow);
		let col = Math.max(0, active.col + dCol);
		if (dRow > 0 || dCol > 0) this.ensureExtent(row, col);
		row = Math.min(row, this.rows - 1);
		col = Math.min(col, this.cols - 1);
		// Filtered rows are hidden, so stepping onto one would move the cursor out of sight.
		row = this.skipHidden(row, dRow);
		if (extend) this.setSelection({ r1: rect.r1, c1: rect.c1, r2: row, c2: col }, { row, col });
		else this.setSelection({ r1: row, c1: col, r2: row, c2: col }, { row, col });
		this.scrollIntoView(row, col);
	}

	private skipHidden(row: number, dRow: number): number {
		if (this.hiddenRows.size === 0 || dRow === 0) return row;
		const step = dRow > 0 ? 1 : -1;
		let r = row;
		while (r > 0 && r < this.rows - 1 && this.hiddenRows.has(r)) r += step;
		return this.hiddenRows.has(r) ? row - dRow : r;
	}

	/** Ctrl+arrow: jump to the edge of the data block, Excel style. */
	jumpToEdge(dRow: number, dCol: number, extend = false): void {
		const { active, rect } = this.selection;
		let row = active.row;
		let col = active.col;
		const occupied = (r: number, c: number) => getRaw(this.model, r, c) !== "";
		const inBounds = (r: number, c: number) => r >= 0 && c >= 0 && r < this.rows && c < this.cols;

		if (occupied(row, col) && inBounds(row + dRow, col + dCol) && occupied(row + dRow, col + dCol)) {
			while (inBounds(row + dRow, col + dCol) && occupied(row + dRow, col + dCol)) {
				row += dRow;
				col += dCol;
			}
		} else {
			let moved = false;
			while (inBounds(row + dRow, col + dCol)) {
				row += dRow;
				col += dCol;
				if (occupied(row, col)) {
					moved = true;
					break;
				}
			}
			if (!moved) {
				row = dRow > 0 ? Math.max(0, this.model.usedRange.rows - 1) : dRow < 0 ? 0 : row;
				col = dCol > 0 ? Math.max(0, this.model.usedRange.cols - 1) : dCol < 0 ? 0 : col;
			}
		}
		if (extend) this.setSelection({ r1: rect.r1, c1: rect.c1, r2: row, c2: col }, { row, col });
		else this.setSelection({ r1: row, c1: col, r2: row, c2: col }, { row, col });
		this.scrollIntoView(row, col);
	}

	selectAll(): void {
		const rows = Math.max(this.model.usedRange.rows, 1);
		const cols = Math.max(this.model.usedRange.cols, 1);
		this.setSelection({ r1: 0, c1: 0, r2: rows - 1, c2: cols - 1 }, this.selection.active);
	}

	selectColumns(cols: number[]): void {
		if (cols.length === 0) return;
		const c1 = Math.min(...cols);
		const c2 = Math.max(...cols);
		this.setSelection({ r1: 0, c1, r2: this.rows - 1, c2 }, { row: 0, col: c1 });
	}

	selectRows(rows: number[]): void {
		if (rows.length === 0) return;
		const r1 = Math.min(...rows);
		const r2 = Math.max(...rows);
		this.setSelection({ r1, c1: 0, r2, c2: this.cols - 1 }, { row: r1, col: 0 });
	}

	/* --------------------------------------------------------------- editing */

	beginEdit(initial?: string): void {
		if (this.editing) return;
		const { row, col } = this.selection.active;
		const el = this.cellEl(row, col);
		if (!el) return;
		const original = getRaw(this.model, row, col);
		el.empty();
		el.addClass("is-editing");
		const input = el.createEl("input", { cls: "mg-editor", attr: { type: "text" } });
		input.value = initial ?? original;
		this.editing = { row, col, input, original };
		this.fillHandleEl.addClass("mg-hidden");
		input.focus();
		if (initial === undefined) input.select();
		else input.setSelectionRange(input.value.length, input.value.length);

		const onKey = (evt: KeyboardEvent) => this.onEditorKey(evt);
		const onBlur = () => this.commitEdit(0, 0);
		input.addEventListener("keydown", onKey);
		input.addEventListener("blur", onBlur);
		this.editing.input.dataset.bound = "1";
		this.cleanup.push(() => {
			input.removeEventListener("keydown", onKey);
			input.removeEventListener("blur", onBlur);
		});
	}

	private onEditorKey(evt: KeyboardEvent): void {
		if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			this.cancelEdit();
			this.focus();
			return;
		}
		if (evt.key === "Enter") {
			evt.preventDefault();
			evt.stopPropagation();
			this.commitEdit(evt.shiftKey ? -1 : 1, 0);
			return;
		}
		if (evt.key === "Tab") {
			evt.preventDefault();
			evt.stopPropagation();
			this.commitEdit(0, evt.shiftKey ? -1 : 1);
			return;
		}
		// Everything else belongs to the input; keep it away from the grid's own handlers.
		evt.stopPropagation();
	}

	commitEdit(dRow: number, dCol: number): void {
		const editing = this.editing;
		if (!editing) return;
		this.editing = null;
		const value = editing.input.value;
		const el = this.cellEl(editing.row, editing.col);
		el?.removeClass("is-editing");
		if (value !== editing.original) {
			this.mutate("Edit cell", () => setRaw(this.model, editing.row, editing.col, value));
			this.repaintCell(editing.row, editing.col);
		} else if (el) {
			this.paintCell(el, editing.row, editing.col);
			if (this.renderMode === "rendered") void this.renderCell(el, editing.row, editing.col);
		}
		this.focus();
		if (dRow !== 0 || dCol !== 0) this.moveActive(dRow, dCol);
		else this.paintSelection();
	}

	cancelEdit(): void {
		const editing = this.editing;
		if (!editing) return;
		this.editing = null;
		const el = this.cellEl(editing.row, editing.col);
		if (el) {
			el.removeClass("is-editing");
			this.paintCell(el, editing.row, editing.col);
			if (this.renderMode === "rendered") void this.renderCell(el, editing.row, editing.col);
		}
		this.paintSelection();
	}

	/** Formula-bar commit path: writes into the active cell without entering cell edit mode. */
	setActiveValue(value: string): void {
		const { row, col } = this.selection.active;
		if (getRaw(this.model, row, col) === value) return;
		this.mutate("Edit cell", () => setRaw(this.model, row, col, value));
		this.repaintCell(row, col);
	}

	/* --------------------------------------------------------------- mutation */

	/**
	 * Single funnel for every model change: snapshot for undo, run, recompute, notify.
	 *
	 * Nothing outside this class may touch the model, so there is no path to a change that
	 * skips the undo stack or leaves the note marked clean.
	 */
	mutate(label: string, fn: () => void, repaint: "cell" | "all" = "all"): void {
		this.undo.push(label, this.model, this.layout);
		fn();
		recomputeUsedRange(this.model);
		if (repaint === "all") this.repaintAll();
		this.applyGeometry(true);
		this.applyFilters();
		this.ctx.callbacks.onDirty(label);
		this.ctx.callbacks.onSelectionChange(this.selection);
	}

	undoLast(): boolean {
		const snapshot = this.undo.undo({ model: this.model, layout: this.layout });
		if (!snapshot) return false;
		this.replaceData(snapshot.model, snapshot.layout);
		this.ctx.callbacks.onDirty(`Undo ${snapshot.label.toLowerCase()}`);
		this.ctx.callbacks.onLayoutChange();
		return true;
	}

	redoLast(): boolean {
		const snapshot = this.undo.redo({ model: this.model, layout: this.layout });
		if (!snapshot) return false;
		this.replaceData(snapshot.model, snapshot.layout);
		this.ctx.callbacks.onDirty(`Redo ${snapshot.label.toLowerCase()}`);
		this.ctx.callbacks.onLayoutChange();
		return true;
	}

	/* ------------------------------------------------------------ operations */

	clearSelectionContents(): void {
		this.mutate("Clear cells", () => clearRange(this.model, this.selection.rect));
	}

	insertRowsAt(where: "above" | "below"): void {
		const rect = this.selection.rect;
		const count = rect.r2 - rect.r1 + 1;
		const at = where === "above" ? rect.r1 : rect.r2 + 1;
		if (at <= 0) {
			this.ctx.callbacks.onNotice("Row 1 is the table header and cannot be moved down.");
			return;
		}
		this.ensureExtent(Math.min(this.rows - 1 + count, MAX_ROWS - 1), rect.c2);
		this.mutate("Insert rows", () => insertRows(this.model, this.layout, at, count));
		this.setSelection({ r1: at, c1: rect.c1, r2: at + count - 1, c2: rect.c2 }, { row: at, col: rect.c1 });
	}

	deleteSelectedRows(): void {
		const rows = rectRows(this.selection.rect).filter((r) => r > 0);
		if (rows.length === 0) {
			this.ctx.callbacks.onNotice("The header row cannot be deleted — GFM requires it.");
			return;
		}
		this.mutate("Delete rows", () => deleteRows(this.model, this.layout, rows));
		const row = Math.min(rows[0], Math.max(1, this.model.usedRange.rows - 1));
		this.setSelection({ r1: row, c1: 0, r2: row, c2: this.cols - 1 }, { row, col: 0 });
		this.ctx.callbacks.onLayoutChange();
	}

	insertColsAt(where: "left" | "right"): void {
		const rect = this.selection.rect;
		const count = rect.c2 - rect.c1 + 1;
		const at = where === "left" ? rect.c1 : rect.c2 + 1;
		this.ensureExtent(rect.r2, Math.min(this.cols - 1 + count, MAX_COLS - 1));
		this.mutate("Insert columns", () => insertCols(this.model, this.layout, at, count));
		this.setSelection({ r1: rect.r1, c1: at, r2: rect.r2, c2: at + count - 1 }, { row: rect.r1, col: at });
		this.ctx.callbacks.onLayoutChange();
	}

	deleteSelectedCols(): void {
		const cols = rectCols(this.selection.rect);
		if (cols.length >= Math.max(this.model.usedRange.cols, 1)) {
			this.ctx.callbacks.onNotice("A table needs at least one column.");
			return;
		}
		this.mutate("Delete columns", () => deleteCols(this.model, this.layout, cols));
		const col = Math.min(cols[0], Math.max(0, this.model.usedRange.cols - 1));
		this.setSelection({ r1: 0, c1: col, r2: this.rows - 1, c2: col }, { row: 0, col });
		this.ctx.callbacks.onLayoutChange();
	}

	moveSelectedRow(delta: number): void {
		const rect = this.selection.rect;
		if (rect.r1 !== rect.r2) {
			this.ctx.callbacks.onNotice("Select a single row to move it.");
			return;
		}
		const from = rect.r1;
		const to = from + delta;
		if (from <= 0 || to <= 0 || to >= Math.max(this.model.usedRange.rows, 2)) return;
		this.mutate("Move row", () => moveRow(this.model, this.layout, from, delta > 0 ? to + 1 : to));
		this.setSelection({ r1: to, c1: rect.c1, r2: to, c2: rect.c2 }, { row: to, col: rect.c1 });
		this.ctx.callbacks.onLayoutChange();
	}

	moveSelectedCol(delta: number): void {
		const rect = this.selection.rect;
		if (rect.c1 !== rect.c2) {
			this.ctx.callbacks.onNotice("Select a single column to move it.");
			return;
		}
		const from = rect.c1;
		const to = from + delta;
		if (to < 0 || to >= Math.max(this.model.usedRange.cols, 1)) return;
		this.mutate("Move column", () => moveCol(this.model, this.layout, from, delta > 0 ? to + 1 : to));
		this.setSelection({ r1: rect.r1, c1: to, r2: rect.r2, c2: to }, { row: rect.r1, col: to });
		this.ctx.callbacks.onLayoutChange();
	}

	/** Alignment is per column in GFM (§3), so this applies to whole columns by definition. */
	setAlignment(align: Align): void {
		const cols = rectCols(this.selection.rect);
		this.mutate("Set alignment", () => setColAlign(this.model, cols, align));
	}

	format(kind: InlineFormat): void {
		this.mutate("Format cells", () => applyInlineFormat(this.model, this.selection.rect, kind));
	}

	/* --------------------------------------------------------------- sizing */

	setColumnWidth(cols: number[], width: number): void {
		const w = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width)));
		const widths = this.layout.colWidths.slice();
		const needed = Math.max(...cols) + 1;
		while (widths.length < needed) widths.push(0);
		for (const c of cols) widths[c] = w;
		this.layout.colWidths = widths;
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	setRowHeight(rows: number[], height: number): void {
		const h = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round(height)));
		for (const r of rows) this.layout.rowHeights[String(r)] = h;
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	resetRowHeights(rows: number[]): void {
		for (const r of rows) delete this.layout.rowHeights[String(r)];
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	/** Widest visible cell plus padding, capped so one long cell cannot fill the viewport. */
	autofitColumns(cols: number[]): void {
		for (const c of cols) {
			let widest = MIN_COL_WIDTH;
			for (let r = 0; r < this.rows; r++) {
				const el = this.cellEl(r, c);
				if (!el) continue;
				const raw = getRaw(this.model, r, c);
				if (raw === "") continue;
				widest = Math.max(widest, this.measureText(raw, el) + 20);
			}
			this.setColumnWidth([c], Math.min(widest, AUTOFIT_MAX_WIDTH));
		}
	}

	autofitRows(rows: number[]): void {
		// Wrapped text only has a natural height once the width is fixed, so measure the DOM.
		for (const r of rows) {
			const rowEl = this.rowEls.get(r);
			if (!rowEl) continue;
			let tallest = MIN_ROW_HEIGHT;
			for (let c = 0; c < this.cols; c++) {
				const el = this.cellEl(r, c);
				if (!el) continue;
				tallest = Math.max(tallest, el.scrollHeight + 6);
			}
			this.setRowHeight([r], Math.min(tallest, MAX_ROW_HEIGHT));
		}
	}

	private measureEl: HTMLElement | null = null;

	private measureText(text: string, sample: HTMLElement): number {
		if (!this.measureEl) this.measureEl = this.hostEl.createDiv({ cls: "mg-measure" });
		const style = sample.ownerDocument.defaultView?.getComputedStyle(sample);
		this.measureEl.setCssProps({
			"--mg-measure-font": style ? `${style.fontSize} ${style.fontFamily}` : "inherit",
		});
		this.measureEl.setText(text);
		return this.measureEl.offsetWidth;
	}

	toggleWrap(cols: number[]): void {
		const set = new Set(this.layout.wrapCols);
		const allWrapped = cols.every((c) => set.has(c));
		for (const c of cols) {
			if (allWrapped) set.delete(c);
			else set.add(c);
		}
		this.layout.wrapCols = Array.from(set).sort((a, b) => a - b);
		for (let r = 0; r < this.rows; r++) {
			for (const c of cols) this.cellEl(r, c)?.toggleClass("is-wrap", !allWrapped);
		}
		this.ctx.callbacks.onLayoutChange();
	}

	setFreeze(rows: number, cols: number): void {
		this.layout.frozenRows = Math.max(0, Math.min(rows, 10));
		this.layout.frozenCols = Math.max(0, Math.min(cols, 10));
		for (const [r, rowEl] of this.rowEls) rowEl.toggleClass("is-frozen-row", r < this.layout.frozenRows);
		for (let c = 0; c < this.cols; c++) {
			const frozen = c < this.layout.frozenCols;
			this.colHeadEls.get(c)?.toggleClass("is-frozen-col", frozen);
			for (let r = 0; r < this.rows; r++) this.cellEl(r, c)?.toggleClass("is-frozen-col", frozen);
		}
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	/* ------------------------------------------------------------ render mode */

	setRenderMode(mode: RenderMode): void {
		if (this.renderMode === mode) return;
		this.renderMode = mode;
		this.observer?.disconnect();
		this.observer = null;
		this.repaintAll();
	}

	/**
	 * Rendered mode is lazy on purpose: a markdown render per cell over hundreds of cells is
	 * the one thing that can make this view feel slow (§5), so only cells that actually enter
	 * the viewport are rendered, and identical content is rendered once and cloned.
	 */
	private setupObserver(): void {
		const win = this.scrollEl.ownerDocument.defaultView;
		if (!win || typeof win.IntersectionObserver !== "function") return;
		this.observer = new win.IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const el = entry.target;
					if (!el.instanceOf(HTMLElement)) continue;
					const row = Number.parseInt(el.dataset.row ?? "", 10);
					const col = Number.parseInt(el.dataset.col ?? "", 10);
					if (Number.isFinite(row) && Number.isFinite(col)) void this.renderCell(el, row, col);
				}
			},
			{ root: this.scrollEl, rootMargin: "200px" },
		);
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) {
				const el = this.cellEl(r, c);
				if (el && el.dataset.pending === "1") this.observer.observe(el);
			}
		}
	}

	private async renderCell(el: HTMLElement, row: number, col: number): Promise<void> {
		if (this.renderMode !== "rendered") return;
		const raw = getRaw(this.model, row, col);
		if (raw === "") return;
		const key = fnv1a(raw);
		delete el.dataset.pending;
		const cached = this.renderCache.get(key);
		if (cached) {
			el.empty();
			el.addClass("is-rendered");
			el.append(cached.cloneNode(true));
			return;
		}
		const holder = this.hostEl.createDiv({ cls: "mg-render-scratch" });
		// The component is the view, so rendered children are unloaded with the tab and not
		// with the plugin (`no-plugin-as-component`, §15.2).
		await MarkdownRenderer.render(this.ctx.app, raw, holder, this.ctx.sourcePath, this.ctx.component);
		const frag = holder.ownerDocument.win.createFragment();
		// Markdown always produces a block wrapper; unwrap a lone paragraph so the cell is one line.
		const only = holder.children.length === 1 ? holder.children.item(0) : null;
		const source = only !== null && only.tagName === "P" ? only : holder;
		while (source.firstChild) frag.append(source.firstChild);
		holder.detach();
		this.renderCache.set(key, frag);
		if (this.renderCache.size > 4000) this.renderCache.clear();
		const current = this.cellEl(row, col);
		if (current && getRaw(this.model, row, col) === raw) {
			current.empty();
			current.addClass("is-rendered");
			current.append(frag.cloneNode(true));
		}
	}

	/* ---------------------------------------------------------------- filter */

	setFilters(filters: ColumnFilter[]): void {
		this.filters = filters.filter((f) => f.query.trim() !== "");
		this.applyFilters();
	}

	/** Display only — filtering never changes what gets written to the note (§11). */
	private applyFilters(): void {
		this.hiddenRows.clear();
		if (this.filters.length > 0) {
			for (let r = 1; r < this.rows; r++) {
				const match = this.filters.every((f) => {
					const raw = getRaw(this.model, r, f.col).toLowerCase();
					return raw.includes(f.query.trim().toLowerCase());
				});
				if (!match) this.hiddenRows.add(r);
			}
		}
		for (const [r, rowEl] of this.rowEls) rowEl.toggleClass("is-filtered", this.hiddenRows.has(r));
		this.hostEl.toggleClass("has-filter", this.filters.length > 0);
	}

	/* ------------------------------------------------------------ quick calc */

	/** Arms "click a cell to place this value" mode (§12). */
	beginCalcPlacement(label: string, text: string): void {
		this.pendingCalc = { label, text };
		this.hintEl.empty();
		this.hintEl.createSpan({ text: `Click a cell to insert ${label} = ${text}` });
		this.hintEl.createSpan({ cls: "mg-hint-hint", text: "Esc to cancel" });
		this.hintEl.removeClass("mg-hidden");
		this.hostEl.addClass("is-placing");
	}

	cancelCalcPlacement(): void {
		this.pendingCalc = null;
		this.hintEl.addClass("mg-hidden");
		this.hostEl.removeClass("is-placing");
	}

	hasPendingCalc(): boolean {
		return this.pendingCalc !== null;
	}

	private placeCalc(row: number, col: number): void {
		const pending = this.pendingCalc;
		if (!pending) return;
		this.cancelCalcPlacement();
		this.mutate("Insert calculated value", () => setRaw(this.model, row, col, pending.text));
		this.ctx.callbacks.onCalcPlaced();
	}

	/* -------------------------------------------------------------- clipboard */

	copySelection(): string {
		return toTsv(readRange(this.model, this.selection.rect));
	}

	cutSelection(): string {
		const text = this.copySelection();
		this.clearSelectionContents();
		return text;
	}

	pasteText(text: string): void {
		const { row, col } = this.selection.active;
		if (!looksLikeGrid(text)) {
			this.mutate("Paste", () => setRaw(this.model, row, col, text.replace(/\r?\n/g, " ")));
			return;
		}
		const values = fromTsv(text);
		if (values.length === 0) return;
		const height = values.length;
		const width = values[0].length;
		if (!this.ensureExtent(row + height - 1, col + width - 1)) return;
		this.mutate("Paste", () => writeRange(this.model, row, col, values));
		this.setSelection(
			{ r1: row, c1: col, r2: row + height - 1, c2: col + width - 1 },
			{ row, col },
		);
	}

	/** Markdown of the current selection, for `Export ▸ Copy as markdown`. */
	selectionAsMarkdown(): string[][] {
		return readRange(this.model, this.selection.rect);
	}

	/* ------------------------------------------------------------------ fill */

	fillFromHandle(target: Rect): void {
		const src = this.selection.rect;
		const tgt = normalizeRect(target);
		const direction =
			tgt.r2 > src.r2 ? "down" : tgt.r1 < src.r1 ? "up" : tgt.c2 > src.c2 ? "right" : tgt.c1 < src.c1 ? "left" : null;
		if (!direction) return;
		this.mutate("Fill", () => fillRange(this.model, src, tgt, direction, this.numberOpts()));
		this.setSelection({ r1: Math.min(src.r1, tgt.r1), c1: Math.min(src.c1, tgt.c1), r2: Math.max(src.r2, tgt.r2), c2: Math.max(src.c2, tgt.c2) }, this.selection.active);
	}

	/* ---------------------------------------------------------------- events */

	private registerEvents(): void {
		const on = <K extends keyof HTMLElementEventMap>(
			el: HTMLElement,
			type: K,
			handler: (evt: HTMLElementEventMap[K]) => void,
			options?: AddEventListenerOptions,
		) => {
			el.addEventListener(type, handler as EventListener, options);
			this.cleanup.push(() => el.removeEventListener(type, handler as EventListener, options));
		};

		on(this.scrollEl, "scroll", () => this.maybeGrow(), { passive: true });
		on(this.scrollEl, "mousedown", (evt) => this.onMouseDown(evt));
		on(this.scrollEl, "mousemove", (evt) => this.onMouseMove(evt));
		on(this.scrollEl, "dblclick", (evt) => this.onDoubleClick(evt));
		on(this.scrollEl, "contextmenu", (evt) => this.onContextMenu(evt));
		on(this.scrollEl, "keydown", (evt) => this.onContainerKey(evt));
		on(this.scrollEl, "copy", (evt) => this.onCopy(evt, false));
		on(this.scrollEl, "cut", (evt) => this.onCopy(evt, true));
		on(this.scrollEl, "paste", (evt) => this.onPaste(evt));

		const win = this.scrollEl.ownerDocument.defaultView;
		if (win) {
			const up = (evt: MouseEvent) => this.onMouseUp(evt);
			win.addEventListener("mouseup", up);
			this.cleanup.push(() => win.removeEventListener("mouseup", up));
		}
	}

	/**
	 * Plain typing starts an edit. Everything with a modifier, and every navigation key, is
	 * handled by the view's `Scope` (§10) so it cannot collide with the note editor.
	 */
	private onContainerKey(evt: KeyboardEvent): void {
		if (this.editing) return;
		if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
		if (evt.key.length !== 1) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.beginEdit(evt.key);
	}

	private onCopy(evt: ClipboardEvent, cut: boolean): void {
		if (this.editing) return;
		if (evt.defaultPrevented) return;
		evt.preventDefault();
		const text = cut ? this.cutSelection() : this.copySelection();
		evt.clipboardData?.setData("text/plain", text);
	}

	/** `editor-drop-paste` (§15.2): respect an already-handled event, then claim this one. */
	private onPaste(evt: ClipboardEvent): void {
		if (this.editing) return;
		if (evt.defaultPrevented) return;
		const text = evt.clipboardData?.getData("text/plain");
		if (text === undefined || text === "") return;
		evt.preventDefault();
		this.pasteText(text);
	}

	private hit(evt: MouseEvent): { kind: "cell" | "colhead" | "rowhead" | "corner" | "none"; row: number; col: number; el: HTMLElement | null } {
		const target = asElement(evt.target);
		if (target === null) return { kind: "none", row: -1, col: -1, el: null };
		const el = target.closest(".mg-cell, .mg-colhead, .mg-rowhead, .mg-corner, .mg-fill-handle");
		if (el === null || !el.instanceOf(HTMLElement)) return { kind: "none", row: -1, col: -1, el: null };
		const row = Number.parseInt(el.dataset.row ?? "-1", 10);
		const col = Number.parseInt(el.dataset.col ?? "-1", 10);
		if (el.hasClass("mg-fill-handle")) return { kind: "none", row: -1, col: -1, el };
		if (el.hasClass("mg-cell")) return { kind: "cell", row, col, el };
		if (el.hasClass("mg-colhead")) return { kind: "colhead", row: -1, col, el };
		if (el.hasClass("mg-rowhead")) return { kind: "rowhead", row, col: -1, el };
		return { kind: "corner", row: -1, col: -1, el };
	}

	private onMouseDown(evt: MouseEvent): void {
		if (evt.button !== 0) return;
		const target = asElement(evt.target);
		if (target !== null && target.hasClass("mg-fill-handle")) {
			evt.preventDefault();
			this.fillDrag = { source: this.selection.rect, last: this.selection.rect };
			return;
		}

		const hit = this.hit(evt);
		if (hit.kind === "colhead" && hit.el) {
			const edge = this.colResizeEdge(evt, hit.el, hit.col);
			if (edge !== null) {
				evt.preventDefault();
				this.startColumnResize(evt, edge);
				return;
			}
		}
		if (hit.kind === "rowhead" && hit.el) {
			const edge = this.rowResizeEdge(evt, hit.el, hit.row);
			if (edge !== null) {
				evt.preventDefault();
				this.startRowResize(evt, edge);
				return;
			}
		}

		if (this.editing) this.commitEdit(0, 0);

		switch (hit.kind) {
			case "cell": {
				if (this.pendingCalc) {
					evt.preventDefault();
					this.placeCalc(hit.row, hit.col);
					return;
				}
				this.mouseSelecting = true;
				if (evt.shiftKey) {
					const rect = this.selection.rect;
					this.setSelection({ r1: rect.r1, c1: rect.c1, r2: hit.row, c2: hit.col }, { row: hit.row, col: hit.col });
				} else {
					this.setSelection({ r1: hit.row, c1: hit.col, r2: hit.row, c2: hit.col }, { row: hit.row, col: hit.col });
				}
				this.focus();
				break;
			}
			case "colhead":
				this.selectColumns([hit.col]);
				this.focus();
				break;
			case "rowhead":
				this.selectRows([hit.row]);
				this.focus();
				break;
			case "corner":
				this.selectAll();
				this.focus();
				break;
			default:
				break;
		}
	}

	private onMouseMove(evt: MouseEvent): void {
		if (this.fillDrag) {
			const hit = this.hit(evt);
			if (hit.kind !== "cell") return;
			const src = this.fillDrag.source;
			// The fill preview extends in one axis only, whichever the pointer moved further in.
			const dRow = hit.row > src.r2 ? hit.row - src.r2 : hit.row < src.r1 ? hit.row - src.r1 : 0;
			const dCol = hit.col > src.c2 ? hit.col - src.c2 : hit.col < src.c1 ? hit.col - src.c1 : 0;
			const preview =
				Math.abs(dRow) >= Math.abs(dCol)
					? { r1: Math.min(src.r1, hit.row), c1: src.c1, r2: Math.max(src.r2, hit.row), c2: src.c2 }
					: { r1: src.r1, c1: Math.min(src.c1, hit.col), r2: src.r2, c2: Math.max(src.c2, hit.col) };
			this.fillDrag.last = preview;
			this.previewFill(preview);
			return;
		}

		if (this.mouseSelecting) {
			const hit = this.hit(evt);
			if (hit.kind !== "cell") return;
			const rect = this.selection.rect;
			this.setSelection({ r1: rect.r1, c1: rect.c1, r2: hit.row, c2: hit.col }, this.selection.active);
			return;
		}

		// Resize affordance on the header borders.
		const hit = this.hit(evt);
		if (hit.kind === "colhead" && hit.el) {
			this.headRowEl.toggleClass("is-col-resize", this.colResizeEdge(evt, hit.el, hit.col) !== null);
		} else {
			this.headRowEl.removeClass("is-col-resize");
		}
		if (hit.kind === "rowhead" && hit.el) {
			hit.el.toggleClass("is-row-resize", this.rowResizeEdge(evt, hit.el, hit.row) !== null);
		}
	}

	private previewEls: HTMLElement[] = [];

	private previewFill(rect: Rect): void {
		for (const el of this.previewEls) el.removeClass("is-fill-preview");
		this.previewEls = [];
		const r = normalizeRect(rect);
		for (let row = r.r1; row <= r.r2; row++) {
			for (let col = r.c1; col <= r.c2; col++) {
				const el = this.cellEl(row, col);
				if (!el) continue;
				el.addClass("is-fill-preview");
				this.previewEls.push(el);
			}
		}
	}

	private onMouseUp(_evt: MouseEvent): void {
		this.mouseSelecting = false;
		if (this.fillDrag) {
			const target = this.fillDrag.last;
			this.fillDrag = null;
			for (const el of this.previewEls) el.removeClass("is-fill-preview");
			this.previewEls = [];
			this.fillFromHandle(target);
		}
	}

	private onDoubleClick(evt: MouseEvent): void {
		const hit = this.hit(evt);
		if (hit.kind === "colhead" && hit.el) {
			const edge = this.colResizeEdge(evt, hit.el, hit.col);
			if (edge !== null) {
				evt.preventDefault();
				this.autofitColumns([edge]);
				return;
			}
		}
		if (hit.kind === "rowhead" && hit.el) {
			const edge = this.rowResizeEdge(evt, hit.el, hit.row);
			if (edge !== null) {
				evt.preventDefault();
				this.autofitRows([edge]);
				return;
			}
		}
		if (hit.kind === "cell") {
			evt.preventDefault();
			this.setSelection({ r1: hit.row, c1: hit.col, r2: hit.row, c2: hit.col }, { row: hit.row, col: hit.col });
			this.beginEdit();
		}
	}

	private onContextMenu(evt: MouseEvent): void {
		const hit = this.hit(evt);
		if (hit.kind === "none") return;
		evt.preventDefault();
		const menu = new Menu();

		if (hit.kind === "colhead") {
			if (!rectCols(this.selection.rect).includes(hit.col)) this.selectColumns([hit.col]);
			menu.addItem((i) => i.setTitle("Insert column left").setIcon("between-horizontal-start").onClick(() => this.insertColsAt("left")));
			menu.addItem((i) => i.setTitle("Insert column right").setIcon("between-horizontal-end").onClick(() => this.insertColsAt("right")));
			menu.addItem((i) => i.setTitle("Delete column").setIcon("trash-2").onClick(() => this.deleteSelectedCols()));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Autofit width").setIcon("move-horizontal").onClick(() => this.autofitColumns(rectCols(this.selection.rect))));
			menu.addItem((i) => i.setTitle("Wrap text").setIcon("wrap-text").onClick(() => this.toggleWrap(rectCols(this.selection.rect))));
		} else if (hit.kind === "rowhead") {
			if (!rectRows(this.selection.rect).includes(hit.row)) this.selectRows([hit.row]);
			menu.addItem((i) => i.setTitle("Insert row above").setIcon("between-vertical-start").onClick(() => this.insertRowsAt("above")));
			menu.addItem((i) => i.setTitle("Insert row below").setIcon("between-vertical-end").onClick(() => this.insertRowsAt("below")));
			menu.addItem((i) =>
				i
					.setTitle("Delete row")
					.setIcon("trash-2")
					.setDisabled(hit.row === 0)
					.onClick(() => this.deleteSelectedRows()),
			);
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Autofit height").setIcon("move-vertical").onClick(() => this.autofitRows(rectRows(this.selection.rect))));
			menu.addItem((i) => i.setTitle("Reset height").setIcon("rotate-ccw").onClick(() => this.resetRowHeights(rectRows(this.selection.rect))));
		} else {
			menu.addItem((i) => i.setTitle("Edit cell").setIcon("pencil").onClick(() => this.beginEdit()));
			menu.addItem((i) => i.setTitle("Clear contents").setIcon("eraser").onClick(() => this.clearSelectionContents()));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Insert row above").onClick(() => this.insertRowsAt("above")));
			menu.addItem((i) => i.setTitle("Insert row below").onClick(() => this.insertRowsAt("below")));
			menu.addItem((i) => i.setTitle("Insert column left").onClick(() => this.insertColsAt("left")));
			menu.addItem((i) => i.setTitle("Insert column right").onClick(() => this.insertColsAt("right")));
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("Delete row")
					.setDisabled(this.selection.rect.r1 === 0 && this.selection.rect.r2 === 0)
					.onClick(() => this.deleteSelectedRows()),
			);
			menu.addItem((i) => i.setTitle("Delete column").onClick(() => this.deleteSelectedCols()));
		}
		menu.showAtMouseEvent(evt);
	}

	/* ---------------------------------------------------------------- resize */

	/** Returns the column whose right border is under the pointer, or null. */
	private colResizeEdge(evt: MouseEvent, el: HTMLElement, col: number): number | null {
		const rect = el.getBoundingClientRect();
		if (evt.clientX >= rect.right - RESIZE_GRIP) return col;
		if (evt.clientX <= rect.left + RESIZE_GRIP && col > 0) return col - 1;
		return null;
	}

	private rowResizeEdge(evt: MouseEvent, el: HTMLElement, row: number): number | null {
		const rect = el.getBoundingClientRect();
		if (evt.clientY >= rect.bottom - RESIZE_GRIP) return row;
		if (evt.clientY <= rect.top + RESIZE_GRIP && row > 0) return row - 1;
		return null;
	}

	/**
	 * Drag to resize.
	 *
	 * Listeners go on `ownerDocument`/`defaultView` rather than the globals so the drag keeps
	 * tracking in a popped-out window (`prefer-active-doc`, `no-global-this`, §8.5/3).
	 */
	private startColumnResize(evt: MouseEvent, col: number): void {
		const win = this.scrollEl.ownerDocument.defaultView;
		if (!win) return;
		const selected = rectCols(this.selection.rect);
		// Dragging one border of a multi-column selection sizes them all alike (§8.1).
		const cols = selected.includes(col) && selected.length > 1 ? selected : [col];
		const startX = evt.clientX;
		const startW = this.cellEl(0, col)?.offsetWidth ?? this.ctx.settings.defaultColWidth;
		this.hostEl.addClass("is-resizing");

		const move = (e: MouseEvent) => {
			const width = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, startW + (e.clientX - startX)));
			const widths = this.layout.colWidths.slice();
			while (widths.length < Math.max(...cols) + 1) widths.push(0);
			for (const c of cols) widths[c] = Math.round(width);
			this.layout.colWidths = widths;
			this.styles.applyColumnWidths(this.hostEl, this.geometrySpec());
		};
		const up = () => {
			win.removeEventListener("mousemove", move);
			win.removeEventListener("mouseup", up);
			this.hostEl.removeClass("is-resizing");
			this.applyGeometry(true);
			// One coalesced write when the drag ends, not one per mouse move (§8.5/4).
			this.ctx.callbacks.onLayoutChange();
		};
		win.addEventListener("mousemove", move);
		win.addEventListener("mouseup", up);
	}

	private startRowResize(evt: MouseEvent, row: number): void {
		const win = this.scrollEl.ownerDocument.defaultView;
		if (!win) return;
		const selected = rectRows(this.selection.rect);
		const rows = selected.includes(row) && selected.length > 1 ? selected : [row];
		const startY = evt.clientY;
		const startH = this.rowEls.get(row)?.offsetHeight ?? this.ctx.settings.defaultRowHeight;
		this.hostEl.addClass("is-resizing");

		const move = (e: MouseEvent) => {
			const height = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, startH + (e.clientY - startY)));
			for (const r of rows) this.layout.rowHeights[String(r)] = Math.round(height);
			this.styles.applyGeometry(this.geometrySpec(), this.rowEls);
		};
		const up = () => {
			win.removeEventListener("mousemove", move);
			win.removeEventListener("mouseup", up);
			this.hostEl.removeClass("is-resizing");
			this.applyGeometry(true);
			this.ctx.callbacks.onLayoutChange();
		};
		win.addEventListener("mousemove", move);
		win.addEventListener("mouseup", up);
	}

	/* ------------------------------------------------------------- info text */

	usedRangeLabel(): string {
		const { rows, cols } = this.model.usedRange;
		if (rows === 0 || cols === 0) return "Empty table";
		return `${rangeLabel(0, 0, rows - 1, cols - 1)} · ${rows} × ${cols} · ${this.model.cells.size} filled`;
	}

	activeLabel(): string {
		const { active, rect } = this.selection;
		const single = rect.r1 === rect.r2 && rect.c1 === rect.c2;
		return single ? cellLabel(active.row, active.col) : rangeLabel(rect.r1, rect.c1, rect.r2, rect.c2);
	}
}
