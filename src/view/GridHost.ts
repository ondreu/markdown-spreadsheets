import { Component, MarkdownRenderer, Menu, type App } from "obsidian";
import { cellLabel, colName, rangeLabel } from "../model/address";
import { getRaw, recomputeUsedRange, setRaw, type Align, type GridModel } from "../model/GridModel";
import { fnv1a } from "../model/hash";
import type { NumberParseOptions } from "../model/numbers";
import type { MarkdownSpreadsheetsSettings } from "../settings";
import type { TableLayout } from "../store/Sidecar";
import { fromMarkdownTable, fromTsv, looksLikeGrid, toTsv } from "../feature/clipboard";
import {
	applyInlineFormat,
	clearRange,
	deleteCols,
	deleteRows,
	fillRange,
	inlineFormatsOf,
	insertCols,
	insertRows,
	moveCol,
	moveRow,
	normalizeRect,
	readRange,
	rectCols,
	rectRows,
	setColAlign,
	sortRows,
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
import { iconName } from "./icons";

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
	/** The in-cell editor's text changed, so the formula bar can mirror it. */
	onEditorInput?(value: string): void;
}

export interface GridHostContext {
	app: App;
	/** The view, never the plugin — `no-plugin-as-component` (§15.2, §5). */
	component: Component;
	sourcePath: string;
	settings: MarkdownSpreadsheetsSettings;
	callbacks: GridHostCallbacks;
}

type RenderMode = "raw" | "rendered";

interface PendingCalc {
	label: string;
	text: string;
}

/**
 * How an edit started, which decides what the arrow keys do — Excel's two modes. Typing into a
 * cell is "enter": the arrows commit and move on, so a column can be filled without touching
 * Enter. F2 or a double-click is "edit": the arrows move the caret inside the text.
 */
type EditMode = "enter" | "edit";

/** What a drag that started with a mouse press is extending. */
type DragKind = "cells" | "cols" | "rows";

const ARROWS: Record<string, [number, number]> = {
	ArrowUp: [-1, 0],
	ArrowDown: [1, 0],
	ArrowLeft: [0, -1],
	ArrowRight: [0, 1],
};

const SELECTION_CLASSES = ["is-selected", "is-active", "is-sel-top", "is-sel-bottom", "is-sel-left", "is-sel-right"];

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
	private editing: { row: number; col: number; input: HTMLInputElement; original: string; mode: EditMode } | null = null;
	private renderMode: RenderMode;
	private renderCache = new Map<string, DocumentFragment>();
	private observer: IntersectionObserver | null = null;
	private filters: ColumnFilter[] = [];
	private hiddenRows = new Set<number>();
	private pendingCalc: PendingCalc | null = null;
	private readonly styles = new GridStyles();
	private geometryTimer: number | null = null;
	private dragging: DragKind | null = null;
	private scrollFrame: number | null = null;
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
		this.hostEl = parent.createDiv({ cls: "mds-host" });
		this.hintEl = this.hostEl.createDiv({ cls: "mds-hint mds-hidden" });
		this.scrollEl = this.hostEl.createDiv({ cls: "mds-scroll", attr: { tabindex: "0" } });
		this.canvasEl = this.scrollEl.createDiv({ cls: "mds-canvas" });
		this.fillHandleEl = this.canvasEl.createDiv({ cls: "mds-fill-handle mds-hidden" });

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
		if (this.scrollFrame !== null) this.scrollEl.ownerDocument.defaultView?.cancelAnimationFrame(this.scrollFrame);
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

	/** Inline formats the active cell carries as a whole, for the ribbon's pressed state. */
	activeFormats(): Set<InlineFormat> {
		const { row, col } = this.selection.active;
		return inlineFormatsOf(getRaw(this.model, row, col));
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

		this.headRowEl = this.canvasEl.createDiv({ cls: "mds-row mds-head-row" });
		this.headRowEl.createDiv({ cls: "mds-corner", attr: { "aria-hidden": "true" } });
		for (let c = 0; c < this.cols; c++) this.appendColHead(c);

		const frag = this.canvasEl.ownerDocument.win.createFragment();
		for (let r = 0; r < this.rows; r++) frag.append(this.buildRow(r));
		this.canvasEl.append(frag);
		// Last in the canvas, so at equal z-index it paints over frozen rows but under the headers.
		this.fillHandleEl = this.canvasEl.createDiv({ cls: "mds-fill-handle mds-hidden" });

		this.applyGeometry(true);
		this.markUsedRange();
		if (this.renderMode === "rendered") this.setupObserver();
	}

	private appendColHead(c: number): void {
		const el = this.headRowEl.createDiv({
			cls: "mds-colhead",
			text: colName(c),
			attr: { "data-col": String(c) },
		});
		if (c < this.layout.frozenCols) el.addClass("is-frozen-col");
		if (c === this.layout.frozenCols - 1) el.addClass("is-frozen-edge");
		this.colHeadEls.set(c, el);
	}

	private buildRow(r: number): HTMLElement {
		const win = this.canvasEl.ownerDocument.win;
		const rowEl = win.createDiv({ cls: `mds-row mds-r${r}`, attr: { "data-row": String(r) } });
		if (r === 0) rowEl.addClass("is-header-row");
		if (r < this.layout.frozenRows) rowEl.addClass("is-frozen-row");
		if (r === this.layout.frozenRows - 1) rowEl.addClass("is-frozen-edge");

		// Row 0 is the markdown header row; label it so its special status is visible (§9).
		rowEl.createDiv({ cls: "mds-rowhead", text: String(r + 1), attr: { "data-row": String(r) } });

		for (let c = 0; c < this.cols; c++) rowEl.append(this.buildCell(r, c));
		this.rowEls.set(r, rowEl);
		return rowEl;
	}

	private buildCell(r: number, c: number): HTMLElement {
		const el = this.canvasEl.ownerDocument.win.createDiv({
			cls: "mds-cell",
			attr: { "data-row": String(r), "data-col": String(c) },
		});
		if (c < this.layout.frozenCols) el.addClass("is-frozen-col");
		if (c === this.layout.frozenCols - 1) el.addClass("is-frozen-edge");
		if (this.layout.wrapCols.includes(c)) el.addClass("is-wrap");
		this.paintCell(el, r, c);
		return el;
	}

	/**
	 * Alignment is a column property in GFM (§3), and it changes under the grid: a repaint has
	 * to re-apply it, otherwise `setAlignment` only shows up after the tab is reopened.
	 */
	private applyAlign(el: HTMLElement, c: number): void {
		const align = this.model.colAlign[c] ?? null;
		for (const candidate of ["left", "center", "right"] as const) {
			el.toggleClass(`is-align-${candidate}`, align === candidate);
		}
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
		delete el.dataset.pending;
		el.removeAttribute("aria-label");
		this.applyAlign(el, c);
		if (raw === "") return;
		if (this.renderMode === "rendered") {
			// Content seen before is cloned straight away. Painting the raw text first and waiting
			// for the observer made every visible cell flash its Markdown source on every edit.
			const cached = this.renderCache.get(fnv1a(raw));
			if (cached) {
				el.addClass("is-rendered");
				el.append(cached.cloneNode(true));
				return;
			}
			// New content arrives when the cell scrolls into view; until then the raw text is
			// shown so the grid never looks empty.
			el.setText(raw);
			el.dataset.pending = "1";
			return;
		}
		el.setText(raw);
	}

	private repaintCell(r: number, c: number): Promise<void> {
		const el = this.cellEl(r, c);
		if (!el) return Promise.resolve();
		this.paintCell(el, r, c);
		this.updateUsedRangeFor(r, c);
		return this.renderMode === "rendered" ? this.renderCell(el, r, c) : Promise.resolve();
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
		this.paintSelection();
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
		this.canvasEl.append(this.fillHandleEl);
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

	/**
	 * `active` is the anchor: the cell that receives typing and the fixed corner when a range is
	 * extended. The moving corner is whichever corner of the rect sits opposite it. The first
	 * version extended from the rect's top-left instead, so Shift+Up past the anchor, or a drag up
	 * and to the left, lost the starting cell after the first step.
	 */
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

	/** Selects one cell and brings it into view — used by find and by the formula bar. */
	goTo(row: number, col: number): void {
		this.ensureExtent(row, col);
		this.setSelection({ r1: row, c1: col, r2: row, c2: col }, { row, col });
		this.scrollIntoView(row, col);
	}

	/** The corner that moves when the range is extended. */
	private head(): { row: number; col: number } {
		const { rect, active } = this.selection;
		return {
			row: active.row === rect.r1 ? rect.r2 : rect.r1,
			col: active.col === rect.c1 ? rect.c2 : rect.c1,
		};
	}

	private extendTo(row: number, col: number): void {
		const { active } = this.selection;
		this.setSelection({ r1: active.row, c1: active.col, r2: row, c2: col }, active);
	}

	private paintSelection(): void {
		for (const el of this.selectedEls) el.removeClasses(SELECTION_CLASSES);
		this.selectedEls = [];
		for (const el of this.selectedHeads) el.removeClass("is-selected");
		this.selectedHeads = [];

		const { rect, active } = this.selection;
		const single = rect.r1 === rect.r2 && rect.c1 === rect.c2;
		for (let r = rect.r1; r <= rect.r2; r++) {
			const rowEl = this.rowEls.get(r);
			if (!rowEl) continue;
			const head = rowEl.firstElementChild;
			if (head !== null && head.instanceOf(HTMLElement)) {
				head.addClass("is-selected");
				this.selectedHeads.push(head);
			}
			for (let c = rect.c1; c <= rect.c2; c++) {
				const el = this.cellEl(r, c);
				if (!el) continue;
				// The range is drawn as one outline; the cells on its edges carry the border.
				if (!single) el.addClass("is-selected");
				if (r === rect.r1) el.addClass("is-sel-top");
				if (r === rect.r2) el.addClass("is-sel-bottom");
				if (c === rect.c1) el.addClass("is-sel-left");
				if (c === rect.c2) el.addClass("is-sel-right");
				this.selectedEls.push(el);
			}
		}
		for (let c = rect.c1; c <= rect.c2; c++) {
			const head = this.colHeadEls.get(c);
			if (!head) continue;
			head.addClass("is-selected");
			this.selectedHeads.push(head);
		}
		const activeEl = this.cellEl(active.row, active.col);
		if (activeEl) {
			activeEl.addClass("is-active");
			if (!this.selectedEls.includes(activeEl)) this.selectedEls.push(activeEl);
		}
		this.positionFillHandle();
	}

	private selectedHeads: HTMLElement[] = [];

	/**
	 * The fill handle sits on the bottom-right corner of the range.
	 *
	 * Measured with bounding rects rather than `offsetTop`: a frozen row is `position: sticky`, so
	 * its cells' offsets are relative to the row, not the canvas, and the handle of a header-row
	 * selection used to land a row too high. For the same reason it is re-placed on scroll, and
	 * hidden while its corner is scrolled under the frozen panes instead of painting over them.
	 */
	private positionFillHandle(): void {
		const rect = this.selection.rect;
		const anchor = this.cellEl(rect.r2, rect.c2);
		if (!anchor || this.editing || this.hiddenRows.has(rect.r2)) {
			this.fillHandleEl.addClass("mds-hidden");
			return;
		}
		const canvasBox = this.canvasEl.getBoundingClientRect();
		const cellBox = anchor.getBoundingClientRect();
		const x = cellBox.right - canvasBox.left;
		const y = cellBox.bottom - canvasBox.top;
		const { height, width } = this.frozenExtent();
		const underRows = rect.r2 >= this.layout.frozenRows && y - 4 < this.scrollEl.scrollTop + HEAD_HEIGHT + height;
		const underCols = rect.c2 >= this.layout.frozenCols && x - 4 < this.scrollEl.scrollLeft + ROW_HEAD_WIDTH + width;
		if (underRows || underCols) {
			this.fillHandleEl.addClass("mds-hidden");
			return;
		}
		this.fillHandleEl.removeClass("mds-hidden");
		this.fillHandleEl.setCssProps({ "--mds-fill-x": `${x}px`, "--mds-fill-y": `${y}px` });
	}

	/** Pixel size of the frozen rows and columns, header excluded. */
	private frozenExtent(): { height: number; width: number } {
		const rowDefault = this.layout.rowHeightDefault ?? this.ctx.settings.defaultRowHeight;
		let height = 0;
		for (let r = 0; r < this.layout.frozenRows; r++) {
			const h = this.layout.rowHeights[String(r)];
			height += h !== undefined && h > 0 ? h : rowDefault;
		}
		let width = 0;
		for (let c = 0; c < this.layout.frozenCols; c++) {
			const w = this.layout.colWidths[c];
			width += w !== undefined && w > 0 ? w : this.ctx.settings.defaultColWidth;
		}
		return { height, width };
	}

	/** Scrolls so the cell is visible below and right of the frozen panes. */
	private scrollIntoView(row: number, col: number): void {
		const el = this.cellEl(row, col);
		if (!el) return;
		const { height, width } = this.frozenExtent();
		const canvasBox = this.canvasEl.getBoundingClientRect();
		const box = el.getBoundingClientRect();
		const top = box.top - canvasBox.top;
		const left = box.left - canvasBox.left;
		const bottom = top + box.height;
		const right = left + box.width;
		const viewTop = this.scrollEl.scrollTop + HEAD_HEIGHT + height;
		const viewLeft = this.scrollEl.scrollLeft + ROW_HEAD_WIDTH + width;
		const viewBottom = this.scrollEl.scrollTop + this.scrollEl.clientHeight;
		const viewRight = this.scrollEl.scrollLeft + this.scrollEl.clientWidth;

		// A frozen row or column is always on screen in that axis; scrolling for it only jumps.
		if (row >= this.layout.frozenRows) {
			if (top < viewTop) this.scrollEl.scrollTop = top - HEAD_HEIGHT - height;
			else if (bottom > viewBottom) this.scrollEl.scrollTop = bottom - this.scrollEl.clientHeight;
		}
		if (col >= this.layout.frozenCols) {
			if (left < viewLeft) this.scrollEl.scrollLeft = left - ROW_HEAD_WIDTH - width;
			else if (right > viewRight) this.scrollEl.scrollLeft = right - this.scrollEl.clientWidth;
		}
	}

	/* ------------------------------------------------------------ navigation */

	/** Moves the active cell. `extend` moves the far corner of the range instead. */
	moveActive(dRow: number, dCol: number, extend = false): void {
		const from = extend ? this.head() : this.selection.active;
		let row = Math.max(0, from.row + dRow);
		let col = Math.max(0, from.col + dCol);
		if (dRow > 0 || dCol > 0) this.ensureExtent(row, col);
		row = Math.min(row, this.rows - 1);
		col = Math.min(col, this.cols - 1);
		// Filtered rows are hidden, so stepping onto one would move the cursor out of sight.
		row = this.skipHidden(row, dRow);
		if (extend) this.extendTo(row, col);
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
		const from = extend ? this.head() : this.selection.active;
		let row = from.row;
		let col = from.col;
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
		if (extend) this.extendTo(row, col);
		else this.setSelection({ r1: row, c1: col, r2: row, c2: col }, { row, col });
		this.scrollIntoView(row, col);
	}

	/** Home and End: the first column, and the last used column, of the current row. */
	jumpToRowEdge(end: boolean, extend = false): void {
		const from = extend ? this.head() : this.selection.active;
		const col = end ? Math.max(0, this.model.usedRange.cols - 1) : 0;
		if (extend) this.extendTo(from.row, col);
		else this.setSelection({ r1: from.row, c1: col, r2: from.row, c2: col }, { row: from.row, col });
		this.scrollIntoView(from.row, col);
	}

	selectAll(): void {
		const rows = Math.max(this.model.usedRange.rows, 1);
		const cols = Math.max(this.model.usedRange.cols, 1);
		this.setSelection({ r1: 0, c1: 0, r2: rows - 1, c2: cols - 1 }, { row: 0, col: 0 });
	}

	/** Whole columns from `from` to `to`; the first one keeps the active cell, Excel style. */
	selectColumns(from: number, to = from): void {
		this.setSelection({ r1: 0, c1: from, r2: this.rows - 1, c2: to }, { row: 0, col: from });
	}

	selectRows(from: number, to = from): void {
		this.setSelection({ r1: from, c1: 0, r2: to, c2: this.cols - 1 }, { row: from, col: 0 });
	}

	/**
	 * The selection as far as data is concerned. A whole column selected from its header spans
	 * every row in the DOM — a hundred or more past the table — and copying or filling all of
	 * that would write a block of empty cells; whole rows and columns stop at the used range.
	 */
	private effectiveRect(): Rect {
		const rect = this.selection.rect;
		const used = this.model.usedRange;
		const out = { ...rect };
		if (rect.r1 === 0 && rect.r2 === this.rows - 1 && used.rows > 0) out.r2 = Math.max(0, used.rows - 1);
		if (rect.c1 === 0 && rect.c2 === this.cols - 1 && used.cols > 0) out.c2 = Math.max(0, used.cols - 1);
		return out;
	}

	/* --------------------------------------------------------------- editing */

	/**
	 * Opens the in-cell editor. `initial` is the keystroke that started it, which puts the editor
	 * in "enter" mode (arrows commit); without it the edit is F2-style and the arrows move the caret.
	 */
	beginEdit(initial?: string): void {
		if (this.editing) return;
		const { row, col } = this.selection.active;
		const el = this.cellEl(row, col);
		if (!el) return;
		const original = getRaw(this.model, row, col);
		el.empty();
		el.removeAttribute("aria-label");
		el.addClass("is-editing");
		const input = el.createEl("input", { cls: "mds-editor", attr: { type: "text", spellcheck: "false" } });
		input.value = initial ?? original;
		this.editing = { row, col, input, original, mode: initial === undefined ? "edit" : "enter" };
		this.fillHandleEl.addClass("mds-hidden");
		input.focus();
		// Caret at the end, as F2 does in Excel; selecting everything made the next key wipe the cell.
		input.setSelectionRange(input.value.length, input.value.length);

		const onKey = (evt: KeyboardEvent) => this.onEditorKey(evt);
		// A blur commits but must not pull focus back: the person clicked somewhere else on purpose.
		const onBlur = () => this.commitEdit(0, 0, false);
		const onInput = () => this.ctx.callbacks.onEditorInput?.(input.value);
		input.addEventListener("keydown", onKey);
		input.addEventListener("blur", onBlur);
		input.addEventListener("input", onInput);
		// Per-edit, not appended to `cleanup`: that array lives as long as the grid, so pushing
		// closures per edited cell would keep every editor ever opened reachable.
		this.editorCleanup = () => {
			input.removeEventListener("keydown", onKey);
			input.removeEventListener("blur", onBlur);
			input.removeEventListener("input", onInput);
		};
		this.ctx.callbacks.onEditorInput?.(input.value);
	}

	private editorCleanup: (() => void) | null = null;

	private releaseEditor(): void {
		this.editorCleanup?.();
		this.editorCleanup = null;
	}

	private onEditorKey(evt: KeyboardEvent): void {
		if (evt.isComposing) return;
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
		if (evt.key === "F2" && this.editing) {
			// Excel's toggle between the two modes, for when the arrows should move the caret.
			evt.preventDefault();
			this.editing.mode = this.editing.mode === "enter" ? "edit" : "enter";
			return;
		}
		const arrow = ARROWS[evt.key];
		if (arrow && this.editing?.mode === "enter" && !evt.shiftKey && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
			evt.preventDefault();
			evt.stopPropagation();
			this.commitEdit(arrow[0], arrow[1]);
			return;
		}
		// Everything else belongs to the input; keep it away from the grid's own handlers.
		evt.stopPropagation();
	}

	/** Commits the open editor, if any. `refocus` is false when focus is already moving elsewhere. */
	commitEdit(dRow = 0, dCol = 0, refocus = true): void {
		const editing = this.editing;
		if (!editing) return;
		this.editing = null;
		this.releaseEditor();
		const value = editing.input.value;
		const el = this.cellEl(editing.row, editing.col);
		el?.removeClass("is-editing");
		if (value !== editing.original) {
			this.mutate("Edit cell", () => setRaw(this.model, editing.row, editing.col, value), "cell");
			void this.repaintCell(editing.row, editing.col).then(() => this.fitWrappedRows([editing.row]));
			this.fitWrappedRows([editing.row]);
		} else if (el) {
			this.paintCell(el, editing.row, editing.col);
			if (this.renderMode === "rendered") void this.renderCell(el, editing.row, editing.col);
		}
		if (refocus) this.focus();
		if (dRow !== 0 || dCol !== 0) this.moveActive(dRow, dCol);
		else this.paintSelection();
		this.ctx.callbacks.onSelectionChange(this.selection);
	}

	cancelEdit(): void {
		const editing = this.editing;
		if (!editing) return;
		this.editing = null;
		this.releaseEditor();
		const el = this.cellEl(editing.row, editing.col);
		if (el) {
			el.removeClass("is-editing");
			this.paintCell(el, editing.row, editing.col);
			if (this.renderMode === "rendered") void this.renderCell(el, editing.row, editing.col);
		}
		this.paintSelection();
		this.ctx.callbacks.onSelectionChange(this.selection);
	}

	/** Formula-bar commit path: writes into the active cell without entering cell edit mode. */
	setActiveValue(value: string): void {
		const { row, col } = this.selection.active;
		this.setValueAt(row, col, value);
	}

	/** Writes one cell — the formula bar uses it for the cell it was editing, which may no longer be active. */
	setValueAt(row: number, col: number, value: string): void {
		if (getRaw(this.model, row, col) === value) return;
		this.mutate("Edit cell", () => setRaw(this.model, row, col, value), "cell");
		void this.repaintCell(row, col).then(() => this.fitWrappedRows([row]));
		this.fitWrappedRows([row]);
	}

	/* --------------------------------------------------------------- mutation */

	/**
	 * Single funnel for every model change: snapshot for undo, run, recompute, notify.
	 *
	 * Nothing outside this class may touch the model, so there is no path to a change that
	 * skips the undo stack or leaves the note marked clean. An open cell editor is committed
	 * first, as its own undo step: a repaint would otherwise destroy it with the text still in it.
	 */
	mutate(label: string, fn: () => void, repaint: "cell" | "all" = "all"): void {
		if (this.editing) this.commitEdit(0, 0, false);
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
		this.commitEdit(0, 0, false);
		const snapshot = this.undo.undo({ model: this.model, layout: this.layout });
		if (!snapshot) return false;
		this.replaceData(snapshot.model, snapshot.layout);
		this.ctx.callbacks.onDirty(`Undo ${snapshot.label.toLowerCase()}`);
		this.ctx.callbacks.onLayoutChange();
		return true;
	}

	redoLast(): boolean {
		this.commitEdit(0, 0, false);
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

	/** Sorts every data row by one column; the header row never moves. */
	sortByColumn(col: number, ascending: boolean, rows?: number[]): void {
		this.mutate("Sort rows", () =>
			sortRows(this.model, this.layout, { col, ascending, ...(rows && rows.length > 1 ? { rows } : {}) }, this.numberOpts()),
		);
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
		if (cols.length === 0) return;
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

	/**
	 * Fits each column to its widest cell as displayed, capped so one long cell cannot fill the
	 * viewport. Measured off-screen from the text and font each cell actually shows, so it can
	 * shrink a column as well as widen it, and a bold header is measured bold.
	 */
	autofitColumns(cols: number[]): void {
		const used = Math.max(this.model.usedRange.rows, 1);
		const widths = this.layout.colWidths.slice();
		for (const c of cols) {
			let widest = MIN_COL_WIDTH;
			for (let r = 0; r < Math.min(used, this.rows); r++) {
				if (getRaw(this.model, r, c) === "") continue;
				const el = this.cellEl(r, c);
				if (!el) continue;
				widest = Math.max(widest, this.measureText(el.textContent ?? "", el) + 18);
			}
			while (widths.length <= c) widths.push(0);
			widths[c] = Math.min(Math.round(widest), AUTOFIT_MAX_WIDTH);
		}
		this.layout.colWidths = widths;
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
		this.fitWrappedRows(this.usedRowIndexes());
	}

	/**
	 * Fits each row to its tallest cell. The first version read `scrollHeight`, which for a
	 * fixed-height row is the row's own height, so every click grew the row by six pixels and
	 * nothing ever shrank. The row is now laid out at `height: auto` for one measurement.
	 */
	autofitRows(rows: number[]): void {
		this.fitRows(rows);
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	private fitRows(rows: number[]): boolean {
		const base = this.layout.rowHeightDefault ?? this.ctx.settings.defaultRowHeight;
		let changed = false;
		for (const r of rows) {
			const natural = this.naturalRowHeight(r);
			if (natural === null) continue;
			const key = String(r);
			const before = this.layout.rowHeights[key];
			if (natural <= base) delete this.layout.rowHeights[key];
			else this.layout.rowHeights[key] = Math.min(natural, MAX_ROW_HEIGHT);
			if (before !== this.layout.rowHeights[key]) changed = true;
		}
		return changed;
	}

	/** Re-fits rows that have a wrapped, non-empty cell — wrapped text only shows when the row grows. */
	private fitWrappedRows(rows: number[]): void {
		if (this.layout.wrapCols.length === 0) return;
		const targets = rows.filter((r) => this.layout.wrapCols.some((c) => getRaw(this.model, r, c) !== ""));
		if (targets.length === 0) return;
		if (this.fitRows(targets)) {
			this.applyGeometry(true);
			this.ctx.callbacks.onLayoutChange();
		}
	}

	private naturalRowHeight(r: number): number | null {
		const rowEl = this.rowEls.get(r);
		if (!rowEl || this.hiddenRows.has(r)) return null;
		rowEl.addClass("is-measuring");
		const height = rowEl.getBoundingClientRect().height;
		rowEl.removeClass("is-measuring");
		return height > 0 ? Math.ceil(height) : null;
	}

	private usedRowIndexes(): number[] {
		const out: number[] = [];
		for (let r = 0; r < Math.min(this.model.usedRange.rows, this.rows); r++) out.push(r);
		return out;
	}

	private measureEl: HTMLElement | null = null;

	private measureText(text: string, sample: HTMLElement): number {
		if (!this.measureEl) this.measureEl = this.hostEl.createDiv({ cls: "mds-measure" });
		const style = sample.ownerDocument.defaultView?.getComputedStyle(sample);
		this.measureEl.setCssProps({
			"--mds-measure-font": style ? `${style.fontWeight} ${style.fontSize} ${style.fontFamily}` : "inherit",
		});
		this.measureEl.setText(text);
		return this.measureEl.offsetWidth;
	}

	/**
	 * Wrapping is visual (§8.3), but a wrapped cell in a one-line row looks exactly like an
	 * unwrapped one with the ellipsis removed — the toggle appeared to do nothing. Rows with text
	 * in the column are fitted to the wrapped height, and fitted back when it is turned off.
	 */
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
		const rows = this.usedRowIndexes().filter((r) => cols.some((c) => getRaw(this.model, r, c) !== ""));
		this.fitRows(rows);
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	setFreeze(rows: number, cols: number): void {
		this.layout.frozenRows = Math.max(0, Math.min(rows, 10));
		this.layout.frozenCols = Math.max(0, Math.min(cols, 10));
		const fr = this.layout.frozenRows;
		const fc = this.layout.frozenCols;
		for (const [r, rowEl] of this.rowEls) {
			rowEl.toggleClass("is-frozen-row", r < fr);
			rowEl.toggleClass("is-frozen-edge", r === fr - 1);
		}
		for (let c = 0; c < this.cols; c++) {
			const frozen = c < fc;
			const edge = c === fc - 1;
			const head = this.colHeadEls.get(c);
			head?.toggleClass("is-frozen-col", frozen);
			head?.toggleClass("is-frozen-edge", edge);
			for (let r = 0; r < this.rows; r++) {
				const el = this.cellEl(r, c);
				el?.toggleClass("is-frozen-col", frozen);
				el?.toggleClass("is-frozen-edge", edge);
			}
		}
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	/** Excel's "Freeze panes": everything above and left of the active cell stays put. */
	freezeAtSelection(): boolean {
		const { row, col } = this.selection.active;
		if (row === 0 && col === 0) return false;
		this.setFreeze(row, col);
		return true;
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
	 *
	 * Every repaint used to create a new observer without disconnecting the old one, so each edit
	 * left another observer watching every pending cell for the life of the tab.
	 */
	private setupObserver(): void {
		this.observer?.disconnect();
		this.observer = null;
		const win = this.scrollEl.ownerDocument.defaultView;
		if (!win || typeof win.IntersectionObserver !== "function") return;
		const observer = new win.IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const el = entry.target;
					observer.unobserve(el);
					if (!el.instanceOf(HTMLElement)) continue;
					const row = Number.parseInt(el.dataset.row ?? "", 10);
					const col = Number.parseInt(el.dataset.col ?? "", 10);
					if (Number.isFinite(row) && Number.isFinite(col)) void this.renderCell(el, row, col);
				}
			},
			{ root: this.scrollEl, rootMargin: "200px" },
		);
		this.observer = observer;
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) {
				const el = this.cellEl(r, c);
				if (el && el.dataset.pending === "1") observer.observe(el);
			}
		}
	}

	private async renderCell(el: HTMLElement, row: number, col: number): Promise<void> {
		if (this.renderMode !== "rendered") return;
		if (this.editing && this.editing.row === row && this.editing.col === col) return;
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
		const holder = this.hostEl.createDiv({ cls: "mds-render-scratch" });
		// The component is the view, so rendered children are unloaded with the tab and not
		// with the plugin (`no-plugin-as-component`, §15.2).
		await MarkdownRenderer.render(this.ctx.app, raw, holder, this.ctx.sourcePath, this.ctx.component);
		const frag = holder.ownerDocument.win.createFragment();
		// Markdown always produces a block wrapper; unwrap a lone paragraph so the cell is one line.
		const only = holder.children.length === 1 ? holder.children.item(0) : null;
		const source = only !== null && only.tagName === "P" ? only : holder;
		while (source.firstChild) frag.append(source.firstChild);
		holder.detach();
		if (this.renderCache.size > 4000) this.renderCache.clear();
		this.renderCache.set(key, frag);
		const current = this.cellEl(row, col);
		const editingHere = this.editing !== null && this.editing.row === row && this.editing.col === col;
		if (current && !editingHere && getRaw(this.model, row, col) === raw) {
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
		this.hintEl.createSpan({ cls: "mds-hint-hint", text: "Esc to cancel" });
		this.hintEl.removeClass("mds-hidden");
		this.hostEl.addClass("is-placing");
	}

	cancelCalcPlacement(): void {
		this.pendingCalc = null;
		this.hintEl.addClass("mds-hidden");
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
		return toTsv(readRange(this.model, this.effectiveRect()));
	}

	cutSelection(): string {
		const text = this.copySelection();
		const rect = this.effectiveRect();
		this.mutate("Cut", () => clearRange(this.model, rect));
		return text;
	}

	/**
	 * Pastes at the active cell.
	 *
	 * A Markdown table (copied out of a note) is read as one, TSV (Excel, LibreOffice, Sheets) as
	 * a grid. A single value pasted onto a range fills the range, which is what a spreadsheet does.
	 */
	pasteText(text: string): void {
		const { row, col } = this.selection.active;
		const values = fromMarkdownTable(text) ?? (looksLikeGrid(text) ? fromTsv(text) : [[text]]);
		if (values.length === 0 || values[0].length === 0) return;
		const rect = this.effectiveRect();
		const multi = rect.r1 !== rect.r2 || rect.c1 !== rect.c2;
		if (values.length === 1 && values[0].length === 1 && multi) {
			const value = values[0][0].replace(/\r?\n/g, " ");
			const fill: string[][] = [];
			for (let r = rect.r1; r <= rect.r2; r++) {
				const line: string[] = [];
				for (let c = rect.c1; c <= rect.c2; c++) line.push(value);
				fill.push(line);
			}
			this.mutate("Paste", () => writeRange(this.model, rect.r1, rect.c1, fill));
			return;
		}
		const flat = values.map((line) => line.map((v) => v.replace(/\r?\n/g, " ")));
		const height = flat.length;
		const width = flat[0].length;
		if (!this.ensureExtent(row + height - 1, col + width - 1)) return;
		this.mutate("Paste", () => writeRange(this.model, row, col, flat));
		this.setSelection({ r1: row, c1: col, r2: row + height - 1, c2: col + width - 1 }, { row, col });
	}

	/** Markdown of the current selection, for `Export ▸ Copy as markdown`. */
	selectionAsMarkdown(): string[][] {
		return readRange(this.model, this.effectiveRect());
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

		on(this.scrollEl, "scroll", () => this.onScroll(), { passive: true });
		on(this.scrollEl, "mousedown", (evt) => this.onMouseDown(evt));
		on(this.scrollEl, "mousemove", (evt) => this.onMouseMove(evt));
		on(this.scrollEl, "mouseover", (evt) => this.onMouseOver(evt));
		on(this.scrollEl, "click", (evt) => this.onClick(evt));
		on(this.scrollEl, "dblclick", (evt) => this.onDoubleClick(evt));
		on(this.scrollEl, "contextmenu", (evt) => this.onContextMenu(evt));
		on(this.scrollEl, "keydown", (evt) => this.onContainerKey(evt));

		// Clipboard events go to the element holding the text selection, or to `body` when there is
		// none — and the grid deliberately has none. Listening on the grid itself therefore missed
		// Ctrl+C whenever nothing had been clicked yet, so the document listens and checks focus.
		const doc = this.scrollEl.ownerDocument;
		const onCopy = (evt: ClipboardEvent) => this.onCopy(evt, false);
		const onCut = (evt: ClipboardEvent) => this.onCopy(evt, true);
		const onPaste = (evt: ClipboardEvent) => this.onPaste(evt);
		doc.addEventListener("copy", onCopy);
		doc.addEventListener("cut", onCut);
		doc.addEventListener("paste", onPaste);
		this.cleanup.push(() => {
			doc.removeEventListener("copy", onCopy);
			doc.removeEventListener("cut", onCut);
			doc.removeEventListener("paste", onPaste);
		});

		const win = doc.defaultView;
		if (win) {
			const up = (evt: MouseEvent) => this.onMouseUp(evt);
			win.addEventListener("mouseup", up);
			this.cleanup.push(() => win.removeEventListener("mouseup", up));
		}
	}

	/** True when keyboard focus is on the grid itself, not in an editor or anywhere else. */
	private hasGridFocus(): boolean {
		return this.scrollEl.ownerDocument.activeElement === this.scrollEl;
	}

	private onScroll(): void {
		this.maybeGrow();
		if (this.scrollFrame !== null) return;
		const win = this.scrollEl.ownerDocument.defaultView;
		if (!win) return;
		this.scrollFrame = win.requestAnimationFrame(() => {
			this.scrollFrame = null;
			this.positionFillHandle();
		});
	}

	/**
	 * Plain typing starts an edit. Everything with a modifier, and every navigation key, is
	 * handled by the view's `Scope` (§10) so it cannot collide with the note editor.
	 */
	private onContainerKey(evt: KeyboardEvent): void {
		if (this.editing || evt.defaultPrevented || evt.isComposing) return;
		if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
		if (evt.key.length !== 1) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.beginEdit(evt.key);
	}

	private onCopy(evt: ClipboardEvent, cut: boolean): void {
		if (evt.defaultPrevented || this.editing || !this.hasGridFocus()) return;
		evt.preventDefault();
		const text = cut ? this.cutSelection() : this.copySelection();
		evt.clipboardData?.setData("text/plain", text);
	}

	/** `editor-drop-paste` (§15.2): respect an already-handled event, then claim this one. */
	private onPaste(evt: ClipboardEvent): void {
		if (evt.defaultPrevented || this.editing || !this.hasGridFocus()) return;
		const text = evt.clipboardData?.getData("text/plain");
		if (text === undefined || text === "") return;
		evt.preventDefault();
		this.pasteText(text);
	}

	private hit(evt: MouseEvent): { kind: "cell" | "colhead" | "rowhead" | "corner" | "none"; row: number; col: number; el: HTMLElement | null } {
		const target = asElement(evt.target);
		if (target === null) return { kind: "none", row: -1, col: -1, el: null };
		const el = target.closest(".mds-cell, .mds-colhead, .mds-rowhead, .mds-corner, .mds-fill-handle");
		if (el === null || !el.instanceOf(HTMLElement)) return { kind: "none", row: -1, col: -1, el: null };
		const row = Number.parseInt(el.dataset.row ?? "-1", 10);
		const col = Number.parseInt(el.dataset.col ?? "-1", 10);
		if (el.hasClass("mds-fill-handle")) return { kind: "none", row: -1, col: -1, el };
		if (el.hasClass("mds-cell")) return { kind: "cell", row, col, el };
		if (el.hasClass("mds-colhead")) return { kind: "colhead", row: -1, col, el };
		if (el.hasClass("mds-rowhead")) return { kind: "rowhead", row, col: -1, el };
		return { kind: "corner", row: -1, col: -1, el };
	}

	private onMouseDown(evt: MouseEvent): void {
		if (evt.button !== 0) return;
		const target = asElement(evt.target);
		// A click inside the open editor belongs to the editor: it places the caret or starts a
		// text selection. Committing here would make it impossible to click into a word.
		if (this.editing !== null && target !== null && target.hasClass("mds-editor")) return;
		if (target !== null && target.hasClass("mds-fill-handle")) {
			evt.preventDefault();
			this.fillDrag = { source: this.selection.rect, last: this.selection.rect };
			return;
		}
		// Mod+click on a link in a rendered cell follows it; see `onClick`.
		if (target !== null && (evt.ctrlKey || evt.metaKey) && target.closest("a") !== null) return;

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

		if (hit.kind === "none") return;
		// Focus is set by hand below; the default would only start a text selection.
		evt.preventDefault();
		if (this.editing) this.commitEdit(0, 0, false);

		switch (hit.kind) {
			case "cell": {
				if (this.pendingCalc) {
					this.placeCalc(hit.row, hit.col);
					return;
				}
				this.dragging = "cells";
				if (evt.shiftKey) this.extendTo(hit.row, hit.col);
				else this.setSelection({ r1: hit.row, c1: hit.col, r2: hit.row, c2: hit.col }, { row: hit.row, col: hit.col });
				break;
			}
			case "colhead": {
				this.dragging = "cols";
				const from = evt.shiftKey ? this.selection.active.col : hit.col;
				this.selectColumns(from, hit.col);
				break;
			}
			case "rowhead": {
				this.dragging = "rows";
				const from = evt.shiftKey ? this.selection.active.row : hit.row;
				this.selectRows(from, hit.row);
				break;
			}
			case "corner":
				this.selectAll();
				break;
		}
		this.focus();
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

		if (this.dragging !== null) {
			const hit = this.hit(evt);
			const { active } = this.selection;
			if (this.dragging === "cells" && hit.kind === "cell") this.extendTo(hit.row, hit.col);
			else if (this.dragging === "cols" && hit.col >= 0) this.selectColumns(active.col, hit.col);
			else if (this.dragging === "rows" && hit.row >= 0) this.selectRows(active.row, hit.row);
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

	/**
	 * The full text as a tooltip, but only on a cell that is actually cut off. A tooltip on every
	 * cell followed the pointer around the whole grid and said nothing the cell did not.
	 */
	private onMouseOver(evt: MouseEvent): void {
		const target = asElement(evt.target);
		const el = target?.closest(".mds-cell") ?? null;
		if (el === null || !el.instanceOf(HTMLElement) || el.hasClass("is-editing")) return;
		const row = Number.parseInt(el.dataset.row ?? "-1", 10);
		const col = Number.parseInt(el.dataset.col ?? "-1", 10);
		const raw = row >= 0 && col >= 0 ? getRaw(this.model, row, col) : "";
		const clipped = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
		if (raw !== "" && clipped) el.setAttribute("aria-label", raw);
		else el.removeAttribute("aria-label");
	}

	/**
	 * Links in rendered cells. A plain click selects the cell like anywhere else — following a link
	 * on every click makes a cell impossible to select — and must not let the browser navigate the
	 * app window. Ctrl/Cmd+click opens the link in a new tab, never in this one.
	 */
	private onClick(evt: MouseEvent): void {
		const target = asElement(evt.target);
		const link = target?.closest("a") ?? null;
		if (link === null || !link.instanceOf(HTMLElement)) return;
		evt.preventDefault();
		if (!(evt.ctrlKey || evt.metaKey)) return;
		evt.stopPropagation();
		if (link.hasClass("internal-link")) {
			const href = link.getAttribute("data-href") ?? link.getAttribute("href");
			if (href) void this.ctx.app.workspace.openLinkText(href, this.ctx.sourcePath, "tab");
			return;
		}
		const href = link.getAttribute("href");
		if (href && /^[a-z][a-z0-9+.-]*:/i.test(href)) this.scrollEl.ownerDocument.defaultView?.open(href, "_blank");
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
		this.dragging = null;
		if (this.fillDrag) {
			const target = this.fillDrag.last;
			this.fillDrag = null;
			for (const el of this.previewEls) el.removeClass("is-fill-preview");
			this.previewEls = [];
			this.fillFromHandle(target);
		}
	}

	private onDoubleClick(evt: MouseEvent): void {
		const target = asElement(evt.target);
		// Double-click inside the editor selects a word, which is the input's job, not ours.
		if (this.editing !== null && target !== null && target.hasClass("mds-editor")) return;
		const hit = this.hit(evt);
		if (hit.kind === "colhead" && hit.el) {
			const edge = this.colResizeEdge(evt, hit.el, hit.col);
			if (edge !== null) {
				evt.preventDefault();
				const selected = rectCols(this.selection.rect);
				this.autofitColumns(selected.includes(edge) && selected.length > 1 ? selected : [edge]);
				return;
			}
		}
		if (hit.kind === "rowhead" && hit.el) {
			const edge = this.rowResizeEdge(evt, hit.el, hit.row);
			if (edge !== null) {
				evt.preventDefault();
				const selected = rectRows(this.selection.rect);
				this.autofitRows(selected.includes(edge) && selected.length > 1 ? selected : [edge]);
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
		if (this.editing) this.commitEdit(0, 0, false);
		const menu = new Menu();

		if (hit.kind === "colhead") {
			if (!rectCols(this.selection.rect).includes(hit.col)) this.selectColumns(hit.col);
			menu.addItem((i) => i.setTitle("Insert column left").setIcon(iconName("colLeft")).onClick(() => this.insertColsAt("left")));
			menu.addItem((i) => i.setTitle("Insert column right").setIcon(iconName("colRight")).onClick(() => this.insertColsAt("right")));
			menu.addItem((i) => i.setTitle("Delete column").setIcon(iconName("remove")).onClick(() => this.deleteSelectedCols()));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Sort ascending").setIcon(iconName("sortAsc")).onClick(() => this.sortByColumn(hit.col, true)));
			menu.addItem((i) => i.setTitle("Sort descending").setIcon(iconName("sortDesc")).onClick(() => this.sortByColumn(hit.col, false)));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Autofit width").setIcon(iconName("autofitCols")).onClick(() => this.autofitColumns(rectCols(this.selection.rect))));
			menu.addItem((i) => i.setTitle("Wrap text").setIcon(iconName("wrap")).onClick(() => this.toggleWrap(rectCols(this.selection.rect))));
		} else if (hit.kind === "rowhead") {
			if (!rectRows(this.selection.rect).includes(hit.row)) this.selectRows(hit.row);
			menu.addItem((i) =>
				i
					.setTitle("Insert row above")
					.setIcon(iconName("rowAbove"))
					.setDisabled(this.selection.rect.r1 === 0)
					.onClick(() => this.insertRowsAt("above")),
			);
			menu.addItem((i) => i.setTitle("Insert row below").setIcon(iconName("rowBelow")).onClick(() => this.insertRowsAt("below")));
			menu.addItem((i) =>
				i
					.setTitle("Delete row")
					.setIcon(iconName("remove"))
					.setDisabled(hit.row === 0)
					.onClick(() => this.deleteSelectedRows()),
			);
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Autofit height").setIcon(iconName("autofitRows")).onClick(() => this.autofitRows(rectRows(this.selection.rect))));
			menu.addItem((i) => i.setTitle("Reset height").setIcon(iconName("reset")).onClick(() => this.resetRowHeights(rectRows(this.selection.rect))));
		} else {
			if (hit.kind === "cell" && !this.rectContains(hit.row, hit.col)) {
				this.setSelection({ r1: hit.row, c1: hit.col, r2: hit.row, c2: hit.col }, { row: hit.row, col: hit.col });
			}
			const headerOnly = this.selection.rect.r1 === 0 && this.selection.rect.r2 === 0;
			menu.addItem((i) => i.setTitle("Edit cell").setIcon(iconName("edit")).onClick(() => this.beginEdit()));
			menu.addItem((i) => i.setTitle("Clear contents").setIcon(iconName("clear")).onClick(() => this.clearSelectionContents()));
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("Insert row above")
					.setIcon(iconName("rowAbove"))
					.setDisabled(this.selection.rect.r1 === 0)
					.onClick(() => this.insertRowsAt("above")),
			);
			menu.addItem((i) => i.setTitle("Insert row below").setIcon(iconName("rowBelow")).onClick(() => this.insertRowsAt("below")));
			menu.addItem((i) => i.setTitle("Insert column left").setIcon(iconName("colLeft")).onClick(() => this.insertColsAt("left")));
			menu.addItem((i) => i.setTitle("Insert column right").setIcon(iconName("colRight")).onClick(() => this.insertColsAt("right")));
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("Delete row")
					.setIcon(iconName("remove"))
					.setDisabled(headerOnly)
					.onClick(() => this.deleteSelectedRows()),
			);
			menu.addItem((i) => i.setTitle("Delete column").setIcon(iconName("remove")).onClick(() => this.deleteSelectedCols()));
		}
		menu.showAtMouseEvent(evt);
	}

	private rectContains(row: number, col: number): boolean {
		const r = this.selection.rect;
		return row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
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
