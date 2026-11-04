import { Component, MarkdownRenderer, Menu, moment, type App } from "obsidian";
import { cellLabel, colName, rangeLabel } from "../model/address";
import { cloneModel, getRaw, recomputeUsedRange, setRaw, type Align, type GridModel } from "../model/GridModel";
import { fnv1a } from "../model/hash";
import { formatNumber, type NumberParseOptions } from "../model/numbers";
import type { MarkdownSpreadsheetsSettings } from "../settings";
import type { TableLayout } from "../store/Sidecar";
import { fromMarkdownTable, fromTsv, looksLikeGrid, shiftFormulas, toTsv } from "../feature/clipboard";
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
import { DEFAULT_GESTURE, GestureTracker } from "../feature/gesture";
import { plainText } from "../feature/exportCsv";
import { adjustFormulaRefs, editTextOf, isFormulaCell, rawFromEdit, recalculate, stripFormula } from "../feature/formula";
import {
	applyTextTransform,
	distinctColumnValues,
	duplicateCols,
	duplicateRows,
	rowMatches,
	type ColumnFilter,
	type TextTransform,
} from "../feature/transform";
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
import { CellSuggest } from "./CellSuggest";
import { FilterPopover } from "./FilterPopover";
import { iconName, setIconSafe } from "./icons";

export interface Selection {
	rect: Rect;
	/** The cell that receives typing; always inside `rect`. */
	active: { row: number; col: number };
}

export type { ColumnFilter } from "../feature/transform";

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
	/**
	 * A model change is about to happen. Pending input held outside the grid — the formula bar —
	 * has to land first, in the cell it was typed for, before rows move under it.
	 */
	onBeforeMutate?(): void;
	/** Files pasted or dropped onto a cell: the view saves them as attachments and links them. */
	onFiles?(files: File[], row: number, col: number): void;
	/** Text dropped onto a cell, e.g. a note dragged from the file explorer. */
	onDropText?(text: string, row: number, col: number): void;
	/** The column filters changed from the header drop-down. */
	onFiltersChange?(): void;
	/** A link in a rendered cell is hovered, for Obsidian's page preview. */
	onHoverLink?(evt: MouseEvent, link: HTMLElement, linktext: string): void;
	/** Cut, copy and paste from the context menu, through the system clipboard. */
	onClipboard?(action: "copy" | "cut" | "paste"): void;
	/** Range mode was switched on or off, so the touch bar can show it. */
	onRangeModeChange?(on: boolean): void;
}

export interface GridHostContext {
	app: App;
	/** The view, never the plugin — `no-plugin-as-component` (§15.2, §5). */
	component: Component;
	sourcePath: string;
	settings: MarkdownSpreadsheetsSettings;
	callbacks: GridHostCallbacks;
	/** The touch layout (decision 24): taps, long presses and pinches instead of mouse drags. */
	touch?: boolean;
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

/** What a pointer is over: a cell, a header, the corner, or nothing of the grid's. */
interface Hit {
	kind: "cell" | "colhead" | "rowhead" | "corner" | "none";
	row: number;
	col: number;
	el: HTMLElement | null;
}

/** What a drag that started with a mouse press is extending. */
type DragKind = "cells" | "cols" | "rows";

/**
 * Obsidian re-exports moment as a namespace type, which TypeScript will not call directly under
 * this project's module settings; the runtime value is the moment function.
 */
export function formatNow(format: string): string {
	const now = (moment as unknown as () => { format(f: string): string })();
	return now.format(format);
}

const ARROWS: Record<string, [number, number]> = {
	ArrowUp: [-1, 0],
	ArrowDown: [1, 0],
	ArrowLeft: [0, -1],
	ArrowRight: [0, 1],
};

const SELECTION_CLASSES = ["is-selected", "is-active", "is-sel-top", "is-sel-bottom", "is-sel-left", "is-sel-right", "is-cross"];

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
	private editing: { row: number; col: number; input: HTMLTextAreaElement; original: string; mode: EditMode; suggest: CellSuggest | null } | null = null;
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
	private headerDrag: { kind: "col" | "row"; from: number; to: number; moved: boolean } | null = null;
	private filterPopover: FilterPopover | null = null;
	private changedEls: HTMLElement[] = [];

	/**
	 * Where the last copy came from. The clipboard itself only carries text, so without this a
	 * pasted formula cannot know how far it moved — and a formula that does not move its relative
	 * references is wrong in a way that looks right.
	 */
	private copiedBlock: { r1: number; c1: number; text: string } | null = null;

	/**
	 * The reference the last pick wrote into the formula, and the cell it started from. A cell
	 * clicked while a formula is being typed is a reference, as in Excel: the grid is the picker.
	 */
	private pointing: { start: number; end: number; anchor: { row: number; col: number } } | null = null;
	private pointDrag = false;
	private pointEls: HTMLElement[] = [];
	private readonly gesture = new GestureTracker();
	private longPressTimer: number | null = null;
	/**
	 * When a finger last touched the grid. The browser follows a tap with emulated mouse events —
	 * `mousedown`, `dblclick`, and on Android a long press is also a `contextmenu` — which the
	 * mouse handlers would act on a second time; they stand down for a moment after a touch.
	 */
	private lastTouchAt = 0;
	/** Touch has no Shift: in range mode a tap extends the selection instead of moving it. */
	private rangeMode = false;
	private pinchZoom = 1;

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

		this.hostEl.toggleClass("is-touch", this.ctx.touch === true);
		this.hostEl.toggleClass("is-zebra", this.ctx.settings.zebraRows);
		this.hostEl.toggleClass("is-crosshair", this.ctx.settings.highlightActiveLine);
		this.applyZoomClass();
		this.rows = this.initialRows();
		this.cols = this.initialCols();
		const view = this.layout.view;
		if (view) {
			this.rows = Math.min(MAX_ROWS, Math.max(this.rows, view.row + GROW_ROWS));
			this.cols = Math.min(MAX_COLS, Math.max(this.cols, view.col + GROW_COLS));
		}
		this.build();
		this.registerEvents();
		if (view) {
			this.setSelection({ r1: view.row, c1: view.col, r2: view.row, c2: view.col }, { row: view.row, col: view.col });
			this.scrollEl.scrollTop = view.scrollTop;
			this.scrollEl.scrollLeft = view.scrollLeft;
		} else {
			this.setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 }, { row: 0, col: 0 });
		}
	}

	/** Where the grid is left — stored with the layout so the next open lands in the same place. */
	captureView(): void {
		if (!this.scrollEl) return;
		const { row, col } = this.selection.active;
		this.layout.view = { scrollTop: this.scrollEl.scrollTop, scrollLeft: this.scrollEl.scrollLeft, row, col };
	}

	destroy(): void {
		this.cancelEdit();
		this.filterPopover?.close();
		this.clearLongPress();
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

	/* ------------------------------------------------------------------ zoom */

	getZoom(): number {
		const z = this.layout.zoom ?? 1;
		return Number.isFinite(z) && z > 0 ? z : 1;
	}

	/** Zoom scales every size the grid draws; stored sizes stay at 100 % so they survive a reset. */
	setZoom(zoom: number): void {
		const z = Math.round(Math.max(0.5, Math.min(2, zoom)) * 10) / 10;
		if (z === this.getZoom()) return;
		if (z === 1) delete this.layout.zoom;
		else this.layout.zoom = z;
		this.applyZoomClass();
		this.applyGeometry(true);
		this.positionFillHandle();
		this.ctx.callbacks.onLayoutChange();
	}

	private applyZoomClass(): void {
		this.hostEl.setCssProps({ "--mds-zoom": String(this.getZoom()) });
	}

	private headH(): number {
		return Math.round(HEAD_HEIGHT * this.getZoom());
	}

	private rowHeadW(): number {
		return Math.round(ROW_HEAD_WIDTH * this.getZoom());
	}

	/* ------------------------------------------------------------- formulas */

	/** How a computed value is written: whole numbers without decimals, others to the table's places. */
	private formatValue = (value: number): string =>
		Number.isInteger(value)
			? formatNumber(value, 0, this.ctx.settings.numberLocale)
			: formatNumber(value, this.layout.decimals, this.ctx.settings.numberLocale);

	private hasFormulas(): boolean {
		for (const cell of this.model.cells.values()) if (isFormulaCell(cell.raw)) return true;
		return false;
	}

	/**
	 * On open the stored values may be stale — the note can have been edited by hand. A change here
	 * is a real edit: it goes through `mutate`, can be undone, and is what the next save writes.
	 */
	recalculateOnOpen(): void {
		if (!this.hasFormulas()) return;
		const probe = cloneModel(this.model);
		const result = recalculate(probe, { numberOpts: this.numberOpts(), format: this.formatValue });
		if (result.changed.length === 0) return;
		this.mutate("Recalculate formulas", () => {
			recalculate(this.model, { numberOpts: this.numberOpts(), format: this.formatValue });
		});
		this.ctx.callbacks.onNotice(`Recalculated ${result.changed.length} ${result.changed.length === 1 ? "formula" : "formulas"} whose values were out of date.`);
	}

	/** Visual hint for a fresh restore: the cells that differ from what was there before. */
	highlightCells(keys: Array<{ row: number; col: number }>): void {
		for (const el of this.changedEls) el.removeClass("is-changed");
		this.changedEls = [];
		for (const { row, col } of keys) {
			const el = this.cellEl(row, col);
			if (!el) continue;
			el.addClass("is-changed");
			this.changedEls.push(el);
		}
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
		const el = this.headRowEl.createDiv({ cls: "mds-colhead", attr: { "data-col": String(c) } });
		el.createSpan({ cls: "mds-colhead-label", text: colName(c) });
		const filter = el.createSpan({ cls: "mds-colhead-filter", attr: { "aria-label": "Sort and filter" } });
		setIconSafe(filter, "expand");
		if (c < this.layout.frozenCols) el.addClass("is-frozen-col");
		if (c === this.layout.frozenCols - 1) el.addClass("is-frozen-edge");
		if (this.isHiddenCol(c)) el.addClass("is-hidden-col");
		this.colHeadEls.set(c, el);
	}

	private isHiddenCol(c: number): boolean {
		return (this.layout.hiddenCols ?? []).includes(c);
	}

	/** "B · Price": the letter and, when the setting is on, the column's Markdown header as text. */
	private paintColHeads(): void {
		const named = this.ctx.settings.headerNamesInLetters;
		const filtered = new Set(this.filters.map((f) => f.col));
		const hidden = new Set(this.layout.hiddenCols ?? []);
		for (const [c, el] of this.colHeadEls) {
			const header = named ? plainText(getRaw(this.model, 0, c)) : "";
			const label = el.firstElementChild;
			const text = header === "" ? colName(c) : `${colName(c)} · ${header}`;
			if (label !== null && label.textContent !== text) label.textContent = text;
			el.toggleClass("is-filtered", filtered.has(c));
			el.toggleClass("is-hidden-col", hidden.has(c));
			el.toggleClass("has-hidden-after", hidden.has(c + 1) && !hidden.has(c));
		}
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
		if (this.isHiddenCol(c)) el.addClass("is-hidden-col");
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
		el.toggleClass("is-formula", raw !== "" && isFormulaCell(raw));
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
				if (!el) continue;
				el.toggleClass("is-outside", r >= rows || c >= cols);
				// The edge of what gets written: a line right of the last column, below the last row.
				el.toggleClass("is-used-right", c === cols - 1 && r < rows);
				el.toggleClass("is-used-bottom", r === rows - 1 && c < cols);
			}
		}
		for (let c = 0; c < this.cols; c++) this.colHeadEls.get(c)?.toggleClass("is-outside", c >= cols);
		this.paintColHeads();
	}

	private updateUsedRangeFor(_r: number, _c: number): void {
		// The bounding box can grow or shrink from a single edit, so repaint the flags wholesale.
		this.markUsedRange();
	}

	/* ------------------------------------------------------------- geometry */

	private geometrySpec(): GeometrySpec {
		const z = this.getZoom();
		const scale = (n: number) => Math.round(n * z);
		const rowHeights: Record<string, number> = {};
		for (const [key, value] of Object.entries(this.layout.rowHeights)) rowHeights[key] = scale(value);
		return {
			rowDefault: scale(this.layout.rowHeightDefault ?? this.ctx.settings.defaultRowHeight),
			rowHeights,
			colWidths: this.layout.colWidths.map((w) => (w > 0 ? scale(w) : 0)),
			colDefault: scale(this.ctx.settings.defaultColWidth),
			frozenRows: this.layout.frozenRows,
			frozenCols: this.layout.frozenCols,
			headHeight: this.headH(),
			rowHeadWidth: this.rowHeadW(),
			rowCount: this.rows,
			colCount: this.cols,
			hiddenCols: this.layout.hiddenCols ?? [],
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
		if (this.ctx.settings.highlightActiveLine && single) {
			// A faint cross through the active cell's row and column, within the used range.
			const used = this.model.usedRange;
			for (let c = 0; c < Math.max(used.cols, active.col + 1); c++) {
				const el = this.cellEl(active.row, c);
				if (el && c !== active.col) {
					el.addClass("is-cross");
					this.selectedEls.push(el);
				}
			}
			for (let r = 0; r < Math.max(used.rows, active.row + 1); r++) {
				const el = this.cellEl(r, active.col);
				if (el && r !== active.row) {
					el.addClass("is-cross");
					this.selectedEls.push(el);
				}
			}
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
		const underRows = rect.r2 >= this.layout.frozenRows && y - 4 < this.scrollEl.scrollTop + this.headH() + height;
		const underCols = rect.c2 >= this.layout.frozenCols && x - 4 < this.scrollEl.scrollLeft + this.rowHeadW() + width;
		if (underRows || underCols) {
			this.fillHandleEl.addClass("mds-hidden");
			return;
		}
		this.fillHandleEl.removeClass("mds-hidden");
		this.fillHandleEl.setCssProps({ "--mds-fill-x": `${x}px`, "--mds-fill-y": `${y}px` });
	}

	/** Pixel size of the frozen rows and columns, header excluded. */
	private frozenExtent(): { height: number; width: number } {
		const spec = this.geometrySpec();
		let height = 0;
		for (let r = 0; r < this.layout.frozenRows; r++) {
			const h = spec.rowHeights[String(r)];
			height += h !== undefined && h > 0 ? h : spec.rowDefault;
		}
		let width = 0;
		for (let c = 0; c < this.layout.frozenCols; c++) {
			if (this.isHiddenCol(c)) continue;
			const w = spec.colWidths[c];
			width += w !== undefined && w > 0 ? w : spec.colDefault;
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
		const viewTop = this.scrollEl.scrollTop + this.headH() + height;
		const viewLeft = this.scrollEl.scrollLeft + this.rowHeadW() + width;
		const viewBottom = this.scrollEl.scrollTop + this.scrollEl.clientHeight;
		const viewRight = this.scrollEl.scrollLeft + this.scrollEl.clientWidth;

		// A frozen row or column is always on screen in that axis; scrolling for it only jumps.
		if (row >= this.layout.frozenRows) {
			if (top < viewTop) this.scrollEl.scrollTop = top - this.headH() - height;
			else if (bottom > viewBottom) this.scrollEl.scrollTop = bottom - this.scrollEl.clientHeight;
		}
		if (col >= this.layout.frozenCols) {
			if (left < viewLeft) this.scrollEl.scrollLeft = left - this.rowHeadW() - width;
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
		// Filtered rows and hidden columns are not on screen, so the cursor steps over them.
		row = this.skipHidden(row, dRow);
		col = this.skipHiddenCol(col, dCol);
		if (extend) this.extendTo(row, col);
		else this.setSelection({ r1: row, c1: col, r2: row, c2: col }, { row, col });
		this.scrollIntoView(row, col);
	}

	private skipHiddenCol(col: number, dCol: number): number {
		const hidden = this.layout.hiddenCols ?? [];
		if (hidden.length === 0) return col;
		const step = dCol < 0 ? -1 : 1;
		let c = col;
		while (hidden.includes(c) && c + step >= 0 && c + step < this.cols) c += step;
		return hidden.includes(c) ? col - dCol : c;
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
	 *
	 * The editor is a textarea laid over the cell that grows with its content — wider first, then
	 * taller — so a long cell can be read and edited whole. It is still one line of Markdown:
	 * Enter commits, and a pasted line break becomes a space.
	 */
	beginEdit(initial?: string): void {
		if (this.editing) return;
		this.setRangeMode(false);
		const { row, col } = this.selection.active;
		const el = this.cellEl(row, col);
		if (!el) return;
		const original = getRaw(this.model, row, col);
		el.empty();
		el.removeAttribute("aria-label");
		el.addClass("is-editing");
		const input = el.createEl("textarea", { cls: "mds-editor", attr: { spellcheck: "false", rows: "1" } });
		// The on-screen keyboard's return key commits the cell, so it says so.
		if (this.ctx.touch) input.setAttribute("enterkeyhint", "done");
		input.value = initial ?? editTextOf(original);
		const suggest = this.ctx.settings.autocomplete
			? new CellSuggest(this.hostEl, input, {
					app: this.ctx.app,
					sourcePath: this.ctx.sourcePath,
					columnValues: () => distinctColumnValues(this.model, col, row),
				})
			: null;
		this.editing = { row, col, input, original, mode: initial === undefined ? "edit" : "enter", suggest };
		this.pointing = null;
		this.pointDrag = false;
		this.fillHandleEl.addClass("mds-hidden");
		input.focus();
		// Caret at the end, as F2 does in Excel; selecting everything made the next key wipe the cell.
		input.setSelectionRange(input.value.length, input.value.length);
		this.sizeEditor();

		const onKey = (evt: KeyboardEvent) => this.onEditorKey(evt);
		// A blur commits but must not pull focus back: the person clicked somewhere else on purpose.
		const onBlur = () => this.commitEdit(0, 0, false);
		const onInput = () => {
			this.sizeEditor();
			// Typing means the reference is finished; the next click starts a new one.
			this.pointing = null;
			suggest?.update();
			this.ctx.callbacks.onEditorInput?.(input.value);
		};
		input.addEventListener("keydown", onKey);
		input.addEventListener("blur", onBlur);
		input.addEventListener("input", onInput);
		// Per-edit, not appended to `cleanup`: that array lives as long as the grid, so pushing
		// closures per edited cell would keep every editor ever opened reachable.
		this.editorCleanup = () => {
			input.removeEventListener("keydown", onKey);
			input.removeEventListener("blur", onBlur);
			input.removeEventListener("input", onInput);
			suggest?.destroy();
		};
		if (initial !== undefined) suggest?.update();
		this.ctx.callbacks.onEditorInput?.(input.value);
	}

	/** Alt+Down: the values already used in this column, as a pick list. */
	openPickList(): void {
		if (!this.editing) this.beginEdit();
		this.editing?.suggest?.openColumnList();
	}

	private sizeEditor(): void {
		const editing = this.editing;
		if (!editing) return;
		const input = editing.input;
		const cell = input.parentElement;
		if (!cell) return;
		const z = this.getZoom();
		const base = cell.clientWidth;
		const wanted = this.measureText(input.value, input) + 24;
		const width = Math.max(base, Math.min(wanted, Math.round(480 * z)));
		input.setCssProps({ "--mds-editor-w": `${width}px`, "--mds-editor-h": "auto" });
		input.setCssProps({ "--mds-editor-h": `${Math.max(cell.clientHeight, input.scrollHeight)}px` });
	}

	/** True when the open editor holds a formula, so a click in the grid picks a reference. */
	private pointMode(): boolean {
		const editing = this.editing;
		return editing !== null && editing.input.value.trimStart().startsWith("=");
	}

	/** How a range reads inside a formula. Row 1 is the header, as everywhere else. */
	private referenceText(from: { row: number; col: number }, to: { row: number; col: number }): string {
		const first = `${colName(from.col)}${from.row + 1}`;
		const last = `${colName(to.col)}${to.row + 1}`;
		return first === last ? first : `${first}:${last}`;
	}

	/**
	 * Writes the reference of one cell — or, after a drag, of a range — into the formula at the
	 * caret. A reference already there is replaced rather than doubled, the way Excel picks the
	 * cell the caret just left, and the selection outline stays out of the way: the editor keeps
	 * focus and the pick is shown as a dashed outline instead.
	 */
	private pickReference(row: number, col: number): void {
		const editing = this.editing;
		if (editing === null) return;
		const input = editing.input;
		const value = input.value;
		const anchor = this.pointing?.anchor ?? { row, col };
		const text = this.referenceText(anchor, { row, col });
		let start = this.pointing?.start ?? input.selectionStart ?? value.length;
		const end = this.pointing?.end ?? input.selectionEnd ?? start;
		if (this.pointing === null) {
			// A reference directly before the caret is what this click is changing.
			const tail = /(\$?[A-Za-z]{1,3}\$?\d+)(:\$?[A-Za-z]{1,3}\$?\d+)?$/.exec(value.slice(0, start));
			if (tail !== null) start -= tail[0].length;
		}
		input.value = value.slice(0, start) + text + value.slice(end);
		const caret = start + text.length;
		input.setSelectionRange(caret, caret);
		this.pointing = { start, end: caret, anchor };
		this.sizeEditor();
		editing.suggest?.update();
		this.ctx.callbacks.onEditorInput?.(input.value);
		this.previewPoint({ r1: Math.min(anchor.row, row), c1: Math.min(anchor.col, col), r2: Math.max(anchor.row, row), c2: Math.max(anchor.col, col) });
	}

	private previewPoint(rect: Rect): void {
		for (const el of this.pointEls) el.removeClass("is-point-preview");
		this.pointEls = [];
		const r = normalizeRect(rect);
		for (let row = r.r1; row <= r.r2; row++) {
			for (let col = r.c1; col <= r.c2; col++) {
				const el = this.cellEl(row, col);
				if (!el) continue;
				el.addClass("is-point-preview");
				this.pointEls.push(el);
			}
		}
	}

	private clearPointPreview(): void {
		for (const el of this.pointEls) el.removeClass("is-point-preview");
		this.pointEls = [];
	}

	private editorCleanup: (() => void) | null = null;

	private releaseEditor(): void {
		this.editorCleanup?.();
		this.editorCleanup = null;
		this.clearPointPreview();
		this.pointDrag = false;
		this.pointing = null;
	}

	private onEditorKey(evt: KeyboardEvent): void {
		if (evt.isComposing) return;
		const editing = this.editing;
		if (!editing) return;
		const suggestion = editing.suggest?.handleKey(evt) ?? false;
		if (suggestion !== false) {
			evt.preventDefault();
			evt.stopPropagation();
			if (suggestion === "commit") this.commitEdit(evt.key === "Tab" ? 0 : 1, evt.key === "Tab" ? 1 : 0);
			return;
		}
		const mod = evt.ctrlKey || evt.metaKey;
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
			// Ctrl+Enter writes the entry into every selected cell, as in Excel.
			if (mod) this.commitEdit(0, 0, true, true);
			else this.commitEdit(evt.shiftKey ? -1 : 1, 0);
			return;
		}
		if (evt.key === "Tab") {
			evt.preventDefault();
			evt.stopPropagation();
			this.commitEdit(0, evt.shiftKey ? -1 : 1);
			return;
		}
		if (evt.key === "F2") {
			// Excel's toggle between the two modes, for when the arrows should move the caret.
			evt.preventDefault();
			editing.mode = editing.mode === "enter" ? "edit" : "enter";
			return;
		}
		if (evt.key === "ArrowDown" && evt.altKey) {
			evt.preventDefault();
			evt.stopPropagation();
			editing.suggest?.openColumnList();
			return;
		}
		if (mod && (evt.key === ";" || evt.key === ":" || evt.code === "Semicolon")) {
			evt.preventDefault();
			evt.stopPropagation();
			const time = evt.shiftKey || evt.key === ":";
			this.insertAtCaret(formatNow(time ? this.ctx.settings.timeFormat : this.ctx.settings.dateFormat));
			return;
		}
		if (mod && evt.key.toLowerCase() === "k") {
			evt.preventDefault();
			evt.stopPropagation();
			this.linkSelectionInEditor();
			return;
		}
		const arrow = ARROWS[evt.key];
		if (arrow && editing.mode === "enter" && !evt.shiftKey && !mod && !evt.altKey) {
			evt.preventDefault();
			evt.stopPropagation();
			this.commitEdit(arrow[0], arrow[1]);
			return;
		}
		// Everything else belongs to the input; keep it away from the grid's own handlers.
		evt.stopPropagation();
	}

	private insertAtCaret(text: string): void {
		const input = this.editing?.input;
		if (!input) return;
		const start = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? start;
		input.value = input.value.slice(0, start) + text + input.value.slice(end);
		input.setSelectionRange(start + text.length, start + text.length);
		input.dispatchEvent(new Event("input"));
	}

	/** Ctrl+K in the editor: the selection becomes `[[selection]]`, or `[[]]` opens the link list. */
	private linkSelectionInEditor(): void {
		const input = this.editing?.input;
		if (!input) return;
		const start = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? start;
		const selected = input.value.slice(start, end);
		input.value = `${input.value.slice(0, start)}[[${selected}]]${input.value.slice(end)}`;
		const caret = selected === "" ? start + 2 : start + selected.length + 4;
		input.setSelectionRange(caret, caret);
		input.dispatchEvent(new Event("input"));
	}

	/**
	 * Commits the open editor, if any. `refocus` is false when focus is already moving elsewhere.
	 * `fillSelection` writes the entry into every cell of the selection (Ctrl+Enter).
	 */
	commitEdit(dRow = 0, dCol = 0, refocus = true, fillSelection = false): void {
		const editing = this.editing;
		if (!editing) return;
		// An editor that still has focus is about to be removed from the DOM; without moving focus
		// to the grid it would fall to <body>, where none of the grid's keys reach. A commit caused
		// by focus moving elsewhere (blur) leaves focus where the person put it.
		const hadFocus = editing.input.ownerDocument.activeElement === editing.input;
		this.editing = null;
		this.releaseEditor();
		const text = editing.input.value.replace(/\r?\n/g, " ");
		// A formula cell is edited as `=EXPR`; turning that back into the stored form keeps the
		// value's emphasis. Untouched text means an untouched cell.
		const next = text === editTextOf(editing.original) ? editing.original : rawFromEdit(editing.original, text);
		const el = this.cellEl(editing.row, editing.col);
		el?.removeClass("is-editing");
		const rect = this.effectiveRect();
		const multi = rect.r1 !== rect.r2 || rect.c1 !== rect.c2;
		if (fillSelection && multi) {
			this.mutate("Fill selection", () => {
				for (let r = rect.r1; r <= rect.r2; r++) {
					for (let c = rect.c1; c <= rect.c2; c++) setRaw(this.model, r, c, r === editing.row && c === editing.col ? next : rawFromEdit(getRaw(this.model, r, c), text));
				}
			});
		} else if (next !== editing.original) {
			this.mutate("Edit cell", () => setRaw(this.model, editing.row, editing.col, next), this.hasFormulas() || isFormulaCell(next) ? "all" : "cell");
			void this.repaintCell(editing.row, editing.col).then(() => this.fitWrappedRows([editing.row]));
			this.fitWrappedRows([editing.row]);
		} else if (el) {
			this.paintCell(el, editing.row, editing.col);
			if (this.renderMode === "rendered") void this.renderCell(el, editing.row, editing.col);
		}
		if (refocus || hadFocus) this.focus();
		if (dRow !== 0 || dCol !== 0) this.moveActive(dRow, dCol);
		else this.paintSelection();
		this.ctx.callbacks.onSelectionChange(this.selection);
	}

	cancelEdit(): void {
		const editing = this.editing;
		if (!editing) return;
		const hadFocus = editing.input.ownerDocument.activeElement === editing.input;
		this.editing = null;
		this.releaseEditor();
		if (hadFocus) this.focus();
		const el = this.cellEl(editing.row, editing.col);
		if (el) {
			el.removeClass("is-editing");
			this.paintCell(el, editing.row, editing.col);
			if (this.renderMode === "rendered") void this.renderCell(el, editing.row, editing.col);
		}
		this.paintSelection();
		this.ctx.callbacks.onSelectionChange(this.selection);
	}

	/** What the formula bar shows for a cell: `=EXPR` for a formula, else the raw Markdown. */
	editTextAt(row: number, col: number): string {
		return editTextOf(getRaw(this.model, row, col));
	}

	/** Formula-bar commit path: writes into the active cell without entering cell edit mode. */
	setActiveValue(value: string): void {
		const { row, col } = this.selection.active;
		this.setValueAt(row, col, value);
	}

	/**
	 * Writes one cell from typed text — the formula bar uses it for the cell it was editing, which
	 * may no longer be active. `=…` becomes a formula, exactly as in the cell editor.
	 */
	setValueAt(row: number, col: number, value: string): void {
		const original = getRaw(this.model, row, col);
		const text = value.replace(/\r?\n/g, " ");
		if (text === editTextOf(original)) return;
		const next = rawFromEdit(original, text);
		if (next === original) return;
		this.mutate("Edit cell", () => setRaw(this.model, row, col, next), this.hasFormulas() || isFormulaCell(next) ? "all" : "cell");
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
	 * Formula cells are recalculated inside the same step, so undo restores values and inputs together.
	 */
	mutate(label: string, fn: () => void, repaint: "cell" | "all" = "all"): void {
		if (this.editing) this.commitEdit(0, 0, false);
		this.ctx.callbacks.onBeforeMutate?.();
		this.undo.push(label, this.model, this.layout);
		fn();
		let mode = repaint;
		if (this.hasFormulas()) {
			const result = recalculate(this.model, { numberOpts: this.numberOpts(), format: this.formatValue });
			if (result.changed.length > 0) mode = "all";
		}
		recomputeUsedRange(this.model);
		for (const el of this.changedEls) el.removeClass("is-changed");
		this.changedEls = [];
		if (mode === "all") this.repaintAll();
		this.applyGeometry(true);
		this.applyFilters();
		this.ctx.callbacks.onDirty(label);
		this.ctx.callbacks.onSelectionChange(this.selection);
	}

	undoLast(): boolean {
		this.commitEdit(0, 0, false);
		this.ctx.callbacks.onBeforeMutate?.();
		const snapshot = this.undo.undo({ model: this.model, layout: this.layout });
		if (!snapshot) return false;
		this.replaceData(snapshot.model, snapshot.layout);
		this.ctx.callbacks.onDirty(`Undo ${snapshot.label.toLowerCase()}`);
		this.ctx.callbacks.onLayoutChange();
		return true;
	}

	redoLast(): boolean {
		this.commitEdit(0, 0, false);
		this.ctx.callbacks.onBeforeMutate?.();
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
		this.mutate("Insert rows", () => {
			insertRows(this.model, this.layout, at, count);
			adjustFormulaRefs(this.model, { kind: "insertRows", at, count });
		});
		this.setSelection({ r1: at, c1: rect.c1, r2: at + count - 1, c2: rect.c2 }, { row: at, col: rect.c1 });
	}

	deleteSelectedRows(): void {
		const rows = rectRows(this.selection.rect).filter((r) => r > 0);
		if (rows.length === 0) {
			this.ctx.callbacks.onNotice("The header row cannot be deleted — GFM requires it.");
			return;
		}
		this.mutate("Delete rows", () => {
			deleteRows(this.model, this.layout, rows);
			adjustFormulaRefs(this.model, { kind: "deleteRows", at: rows[0], count: rows.length });
		});
		const row = Math.min(rows[0], Math.max(1, this.model.usedRange.rows - 1));
		this.setSelection({ r1: row, c1: 0, r2: row, c2: this.cols - 1 }, { row, col: 0 });
		this.ctx.callbacks.onLayoutChange();
	}

	insertColsAt(where: "left" | "right"): void {
		const rect = this.selection.rect;
		const count = rect.c2 - rect.c1 + 1;
		const at = where === "left" ? rect.c1 : rect.c2 + 1;
		this.ensureExtent(rect.r2, Math.min(this.cols - 1 + count, MAX_COLS - 1));
		this.mutate("Insert columns", () => {
			insertCols(this.model, this.layout, at, count);
			adjustFormulaRefs(this.model, { kind: "insertCols", at, count });
		});
		this.setSelection({ r1: rect.r1, c1: at, r2: rect.r2, c2: at + count - 1 }, { row: rect.r1, col: at });
		this.ctx.callbacks.onLayoutChange();
	}

	deleteSelectedCols(): void {
		const cols = rectCols(this.selection.rect);
		if (cols.length >= Math.max(this.model.usedRange.cols, 1)) {
			this.ctx.callbacks.onNotice("A table needs at least one column.");
			return;
		}
		this.mutate("Delete columns", () => {
			deleteCols(this.model, this.layout, cols);
			adjustFormulaRefs(this.model, { kind: "deleteCols", at: cols[0], count: cols.length });
		});
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

	/** Drag-and-drop on a header: puts row `from` where row `to` is. */
	moveRowTo(from: number, to: number): void {
		if (from <= 0 || to <= 0 || from === to) return;
		this.mutate("Move row", () => moveRow(this.model, this.layout, from, to > from ? to + 1 : to));
		this.selectRows(to);
		this.ctx.callbacks.onLayoutChange();
	}

	moveColTo(from: number, to: number): void {
		if (from === to || from < 0 || to < 0) return;
		this.mutate("Move column", () => moveCol(this.model, this.layout, from, to > from ? to + 1 : to));
		this.selectColumns(to);
		this.ctx.callbacks.onLayoutChange();
	}

	duplicateSelectedRows(): void {
		const rows = rectRows(this.effectiveRect()).filter((r) => r > 0);
		if (rows.length === 0) {
			this.ctx.callbacks.onNotice("The header row cannot be duplicated — a table has one header.");
			return;
		}
		this.ensureExtent(Math.min(this.rows - 1 + rows.length, MAX_ROWS - 1), 0);
		this.mutate("Duplicate rows", () => duplicateRows(this.model, this.layout, rows));
		const at = rows[rows.length - 1] + 1;
		this.selectRows(at, at + rows.length - 1);
		this.ctx.callbacks.onLayoutChange();
	}

	duplicateSelectedCols(): void {
		const cols = rectCols(this.effectiveRect());
		this.ensureExtent(0, Math.min(this.cols - 1 + cols.length, MAX_COLS - 1));
		this.mutate("Duplicate columns", () => duplicateCols(this.model, this.layout, cols));
		const at = cols[cols.length - 1] + 1;
		this.selectColumns(at, at + cols.length - 1);
		this.ctx.callbacks.onLayoutChange();
	}

	transformText(kind: TextTransform): number {
		let changed = 0;
		this.mutate("Change text", () => {
			changed = applyTextTransform(this.model, this.effectiveRect(), kind);
		});
		return changed;
	}

	/** Hidden in the grid only; the columns are still written to the note. */
	hideColumns(cols: number[]): void {
		const hidden = new Set(this.layout.hiddenCols ?? []);
		const visible = Math.max(this.model.usedRange.cols, 1) - cols.filter((c) => !hidden.has(c)).length - hidden.size;
		if (visible <= 0 && cols.every((c) => c < this.model.usedRange.cols)) {
			this.ctx.callbacks.onNotice("At least one column has to stay visible.");
			return;
		}
		for (const c of cols) hidden.add(c);
		this.setHiddenCols(Array.from(hidden));
	}

	showAllColumns(): void {
		this.setHiddenCols([]);
	}

	hiddenColumnCount(): number {
		return (this.layout.hiddenCols ?? []).length;
	}

	private setHiddenCols(cols: number[]): void {
		this.layout.hiddenCols = cols.sort((a, b) => a - b);
		const hidden = new Set(this.layout.hiddenCols);
		for (let r = 0; r < this.rows; r++) {
			for (let c = 0; c < this.cols; c++) this.cellEl(r, c)?.toggleClass("is-hidden-col", hidden.has(c));
		}
		this.paintColHeads();
		const { active } = this.selection;
		if (hidden.has(active.col)) {
			let c = active.col;
			while (hidden.has(c) && c < this.cols - 1) c++;
			this.goTo(active.row, c);
		}
		this.applyGeometry(true);
		this.ctx.callbacks.onLayoutChange();
	}

	/** Writes a block of values at the active cell, as a paste does — for paste variants and imports. */
	pasteValues(values: string[][], label = "Paste"): void {
		const { row, col } = this.selection.active;
		if (values.length === 0 || values[0].length === 0) return;
		const flat = values.map((line) => line.map((v) => v.replace(/\r?\n/g, " ")));
		const height = flat.length;
		const width = Math.max(...flat.map((l) => l.length));
		if (!this.ensureExtent(row + height - 1, col + width - 1)) return;
		this.mutate(label, () => writeRange(this.model, row, col, flat));
		this.setSelection({ r1: row, c1: col, r2: row + height - 1, c2: col + width - 1 }, { row, col });
	}

	/** The selection as a rectangle of raw values, trimmed of whole-line overhang. */
	selectionValues(): string[][] {
		return readRange(this.model, this.effectiveRect());
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
			// The column letter and header name have to fit as well, arrow included.
			const head = this.colHeadEls.get(c);
			if (head) widest = Math.max(widest, this.measureText(head.textContent ?? "", head) + 30);
			for (let r = 0; r < Math.min(used, this.rows); r++) {
				const raw = getRaw(this.model, r, c);
				if (raw === "") continue;
				const el = this.cellEl(r, c);
				if (!el) continue;
				// A cell not rendered yet still shows its source; measure what it will show instead.
				const shown =
					this.renderMode === "rendered" && !el.hasClass("is-rendered") ? plainText(stripFormula(raw)) : el.hasClass("is-rendered") ? (el.textContent ?? "") : raw;
				widest = Math.max(widest, this.measureText(shown, el) + 18);
			}
			while (widths.length <= c) widths.push(0);
			widths[c] = Math.min(Math.round(widest / this.getZoom()), AUTOFIT_MAX_WIDTH);
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
			const measured = this.naturalRowHeight(r);
			if (measured === null) continue;
			const natural = Math.ceil(measured / this.getZoom());
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
		this.filters = filters.filter((f) => f.kind !== "contains" || (f.query ?? "").trim() !== "");
		this.applyFilters();
		this.paintColHeads();
	}

	/** Display only — filtering never changes what gets written to the note (§11). */
	/** One column's filter from the header drop-down; null clears it. */
	setColumnFilter(col: number, filter: ColumnFilter | null): void {
		const rest = this.filters.filter((f) => f.col !== col);
		this.setFilters(filter ? [...rest, filter] : rest);
		this.paintColHeads();
		this.ctx.callbacks.onFiltersChange?.();
	}

	private applyFilters(): void {
		this.hiddenRows.clear();
		if (this.filters.length > 0) {
			const opts = this.numberOpts();
			for (let r = 1; r < this.rows; r++) {
				if (!rowMatches(this.model, r, this.filters, opts)) this.hiddenRows.add(r);
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
		const rect = this.effectiveRect();
		const text = toTsv(readRange(this.model, rect));
		this.copiedBlock = { r1: rect.r1, c1: rect.c1, text };
		return text;
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
		const pasted = values.map((line) => line.map((v) => v.replace(/\r?\n/g, " ")));
		// A block copied inside the grid moves its formulas with it; anything from outside keeps
		// its references, because there is no telling where it came from.
		const own = this.copiedBlock;
		const flat = own !== null && own.text === text ? shiftFormulas(pasted, row - own.r1, col - own.c1) : pasted;
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
		on(this.scrollEl, "wheel", (evt) => this.onWheel(evt), { passive: false });
		on(this.scrollEl, "dragover", (evt) => this.onDragOver(evt));
		on(this.scrollEl, "drop", (evt) => this.onDrop(evt));
		if (this.ctx.touch) {
			on(this.scrollEl, "pointerdown", (evt) => this.onPointerDown(evt));
			on(this.scrollEl, "pointermove", (evt) => this.onPointerMove(evt));
			on(this.scrollEl, "pointerup", (evt) => this.onPointerUp(evt));
			on(this.scrollEl, "pointercancel", (evt) => this.onPointerCancel(evt));
		}

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
			if (this.ctx.touch) {
				// The on-screen keyboard shrinks the window; keep the cell being typed into above it.
				const resized = () => {
					if (this.editing) this.scrollIntoView(this.editing.row, this.editing.col);
				};
				win.addEventListener("resize", resized);
				this.cleanup.push(() => win.removeEventListener("resize", resized));
			}
		}
	}

	/* ----------------------------------------------------------------- touch */

	private isTouchPointer(evt: PointerEvent): boolean {
		return evt.pointerType === "touch" || evt.pointerType === "pen";
	}

	/** True right after a finger touched the grid: a mouse event now is the browser's emulation. */
	private fromTouch(): boolean {
		return this.ctx.touch === true && Date.now() - this.lastTouchAt < 800;
	}

	private clearLongPress(): void {
		if (this.longPressTimer === null) return;
		window.clearTimeout(this.longPressTimer);
		this.longPressTimer = null;
	}

	private onPointerDown(evt: PointerEvent): void {
		if (!this.isTouchPointer(evt)) return;
		this.lastTouchAt = Date.now();
		const target = asElement(evt.target);
		// Inside the open editor the finger places the caret or selects text; that is the input's.
		if (this.editing !== null && target !== null && target.hasClass("mds-editor")) return;
		// No emulated mousedown: it would select a second time, and move focus before the tap decides.
		evt.preventDefault();
		this.gesture.down(evt.pointerId, evt.clientX, evt.clientY, Date.now());
		if (this.gesture.isPinching()) {
			this.clearLongPress();
			this.pinchZoom = this.getZoom();
			return;
		}
		this.clearLongPress();
		this.longPressTimer = window.setTimeout(() => {
			this.longPressTimer = null;
			const at = this.gesture.longPress(Date.now());
			if (at !== null) this.onLongPress(target, at);
		}, DEFAULT_GESTURE.longPressMs + 20);
	}

	private onPointerMove(evt: PointerEvent): void {
		if (!this.isTouchPointer(evt) || !this.gesture.isActive()) return;
		const result = this.gesture.move(evt.pointerId, evt.clientX, evt.clientY);
		if (result?.kind === "pinch") this.setZoom(this.pinchZoom * result.scale);
	}

	private onPointerUp(evt: PointerEvent): void {
		if (!this.isTouchPointer(evt)) return;
		this.lastTouchAt = Date.now();
		const result = this.gesture.up(evt.pointerId, evt.clientX, evt.clientY);
		if (!this.gesture.isActive()) this.clearLongPress();
		if (result?.kind === "tap") this.onTap(evt);
	}

	private onPointerCancel(evt: PointerEvent): void {
		if (!this.isTouchPointer(evt)) return;
		this.lastTouchAt = Date.now();
		this.gesture.cancel(evt.pointerId);
		if (!this.gesture.isActive()) this.clearLongPress();
	}

	/**
	 * A tap is a click without the drag: it selects. A tap on the cell that is already the whole
	 * selection edits it — the second tap is the double-click. A link in the cell is not followed
	 * on a tap, or a column of links could never be edited by touch; the long-press menu opens it.
	 * In range mode a tap extends the selection instead.
	 */
	private onTap(evt: PointerEvent): void {
		const target = asElement(evt.target);
		const hit = this.hit(evt);
		if (hit.kind === "none") return;
		if (hit.kind === "colhead" && hit.el && target?.closest(".mds-colhead-filter")) {
			if (this.editing) this.commitEdit(0, 0, false);
			this.openFilterPopover(hit.col, hit.el);
			return;
		}
		const wasEditing = this.editing !== null;
		const { rect, active } = this.selection;
		const alone = rect.r1 === rect.r2 && rect.c1 === rect.c2;
		if (this.editing) this.commitEdit(0, 0, false);
		// Focus first, as with a click: a field that commits on blur commits against its own cell.
		this.focus();

		switch (hit.kind) {
			case "cell": {
				if (this.pendingCalc) {
					this.placeCalc(hit.row, hit.col);
					return;
				}
				if (this.rangeMode) {
					this.extendTo(hit.row, hit.col);
					return;
				}
				const again = alone && active.row === hit.row && active.col === hit.col;
				if (again && !wasEditing) {
					this.beginEdit();
					return;
				}
				this.setSelection({ r1: hit.row, c1: hit.col, r2: hit.row, c2: hit.col }, { row: hit.row, col: hit.col });
				return;
			}
			case "colhead":
				this.selectColumns(this.rangeMode ? active.col : hit.col, hit.col);
				return;
			case "rowhead":
				this.selectRows(this.rangeMode ? active.row : hit.row, hit.row);
				return;
			case "corner":
				this.selectAll();
				return;
		}
	}

	/** A long press is the right click. */
	private onLongPress(target: HTMLElement | null, at: { x: number; y: number }): void {
		if (target === null || !this.scrollEl.contains(target)) return;
		const hit = this.hitTarget(target);
		if (hit.kind === "none") return;
		const link = hit.kind === "cell" ? target.closest("a") : null;
		this.openContextMenu(hit, (menu) => menu.showAtPosition(at), link !== null && link.instanceOf(HTMLElement) ? link : null);
	}

	isRangeMode(): boolean {
		return this.rangeMode;
	}

	setRangeMode(on: boolean): void {
		if (this.rangeMode === on) return;
		this.rangeMode = on;
		this.hostEl.toggleClass("is-range-mode", on);
		this.ctx.callbacks.onRangeModeChange?.(on);
	}

	/** The context menu of the selection, opened from a button rather than from a cell. */
	openSelectionMenu(at: { x: number; y: number }): void {
		const { row, col } = this.selection.active;
		this.openContextMenu({ kind: "cell", row, col, el: this.cellEl(row, col) }, (menu) => menu.showAtPosition(at));
	}

	/** Ctrl/Cmd+wheel zooms the grid instead of scrolling it. */
	private onWheel(evt: WheelEvent): void {
		if (!(evt.ctrlKey || evt.metaKey)) return;
		evt.preventDefault();
		this.setZoom(this.getZoom() + (evt.deltaY < 0 ? 0.1 : -0.1));
	}

	private onDragOver(evt: DragEvent): void {
		if (!evt.dataTransfer) return;
		const hit = this.hit(evt);
		if (hit.kind !== "cell") return;
		evt.preventDefault();
		evt.dataTransfer.dropEffect = "copy";
	}

	/** Files and notes dropped onto a cell become links in it; the view decides how. */
	private onDrop(evt: DragEvent): void {
		const hit = this.hit(evt);
		if (hit.kind !== "cell" || !evt.dataTransfer || evt.defaultPrevented) return;
		evt.preventDefault();
		if (this.editing) this.commitEdit(0, 0, false);
		this.goTo(hit.row, hit.col);
		const files = Array.from(evt.dataTransfer.files);
		if (files.length > 0) {
			this.ctx.callbacks.onFiles?.(files, hit.row, hit.col);
			return;
		}
		const text = evt.dataTransfer.getData("text/plain");
		if (text !== "") this.ctx.callbacks.onDropText?.(text, hit.row, hit.col);
	}

	/** Appends text to a cell (a space in between), as a drop or a pasted file does. */
	appendToCell(row: number, col: number, text: string): void {
		const current = getRaw(this.model, row, col);
		this.mutate("Insert link", () => setRaw(this.model, row, col, current.trim() === "" ? text : `${current} ${text}`));
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
		// A screenshot or an image copied from a browser: saved as an attachment and linked.
		const files = Array.from(evt.clipboardData?.files ?? []);
		if (files.length > 0 && this.ctx.callbacks.onFiles) {
			evt.preventDefault();
			const { row, col } = this.selection.active;
			this.ctx.callbacks.onFiles(files, row, col);
			return;
		}
		const text = evt.clipboardData?.getData("text/plain");
		if (text === undefined || text === "") return;
		evt.preventDefault();
		this.pasteText(text);
	}

	private hit(evt: MouseEvent): Hit {
		return this.hitTarget(asElement(evt.target));
	}

	private hitTarget(target: HTMLElement | null): Hit {
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
		if (evt.button !== 0 || this.fromTouch()) return;
		const target = asElement(evt.target);
		// A click inside the open editor belongs to the editor: it places the caret or starts a
		// text selection. Committing here would make it impossible to click into a word.
		if (this.editing !== null && target !== null && target.hasClass("mds-editor")) return;
		if (this.pointMode()) {
			const picked = this.hit(evt);
			if (picked.kind === "cell") {
				// The editor keeps focus: preventDefault on mousedown is what stops the blur, and
				// the blur is what would commit the half-typed formula.
				evt.preventDefault();
				this.pointDrag = true;
				this.pickReference(picked.row, picked.col);
				return;
			}
		}
		if (target !== null && target.hasClass("mds-fill-handle")) {
			evt.preventDefault();
			this.fillDrag = { source: this.selection.rect, last: this.selection.rect };
			return;
		}
		// Mod+click on a link in a rendered cell follows it; see `onClick`.
		if (target !== null && (evt.ctrlKey || evt.metaKey) && target.closest("a") !== null) return;

		const hit = this.hit(evt);
		// The arrow in a column header opens sort and filter; the rest of the header selects.
		if (hit.kind === "colhead" && hit.el && target?.closest(".mds-colhead-filter")) {
			evt.preventDefault();
			if (this.editing) this.commitEdit(0, 0, false);
			this.openFilterPopover(hit.col, hit.el);
			return;
		}
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
		// Focus is set by hand; the default would only start a text selection. It moves *before*
		// the selection does, so a field that commits on blur — the formula bar, a ribbon width —
		// commits against the selection it was typed for, not the one this click makes.
		evt.preventDefault();
		if (this.editing) this.commitEdit(0, 0, false);
		this.focus();

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
				// Pressing on a column that is already selected on its own picks it up to move it.
				if (!evt.shiftKey && this.isWholeColumn(hit.col)) {
					this.headerDrag = { kind: "col", from: hit.col, to: hit.col, moved: false };
					break;
				}
				this.dragging = "cols";
				const from = evt.shiftKey ? this.selection.active.col : hit.col;
				this.selectColumns(from, hit.col);
				break;
			}
			case "rowhead": {
				if (!evt.shiftKey && hit.row > 0 && this.isWholeRow(hit.row)) {
					this.headerDrag = { kind: "row", from: hit.row, to: hit.row, moved: false };
					break;
				}
				this.dragging = "rows";
				const from = evt.shiftKey ? this.selection.active.row : hit.row;
				this.selectRows(from, hit.row);
				break;
			}
			case "corner":
				this.selectAll();
				break;
		}
	}

	private isWholeColumn(col: number): boolean {
		const r = this.selection.rect;
		return r.c1 === col && r.c2 === col && r.r1 === 0 && r.r2 === this.rows - 1;
	}

	private isWholeRow(row: number): boolean {
		const r = this.selection.rect;
		return r.r1 === row && r.r2 === row && r.c1 === 0 && r.c2 === this.cols - 1;
	}

	private dropMarker: HTMLElement | null = null;

	private markDrop(el: HTMLElement | null): void {
		this.dropMarker?.removeClass("is-drop-target");
		this.dropMarker = el;
		el?.addClass("is-drop-target");
	}

	private openFilterPopover(col: number, anchor: HTMLElement): void {
		this.filterPopover?.close();
		const header = plainText(getRaw(this.model, 0, col));
		const values = distinctColumnValues(this.model, col);
		let hasEmpty = false;
		for (let r = 1; r < this.model.usedRange.rows; r++) if (getRaw(this.model, r, col) === "") hasEmpty = true;
		if (hasEmpty) values.push("");
		this.filterPopover = new FilterPopover(this.hostEl, anchor, {
			col,
			title: header === "" ? `Column ${colName(col)}` : `${colName(col)} · ${header}`,
			values,
			current: this.filters.find((f) => f.col === col) ?? null,
			onSort: (ascending) => this.sortByColumn(col, ascending),
			onApply: (filter) => this.setColumnFilter(col, filter),
			onClose: () => {
				this.filterPopover = null;
				this.focus();
			},
		});
	}

	private onMouseMove(evt: MouseEvent): void {
		if (this.pointDrag) {
			const hit = this.hit(evt);
			if (hit.kind === "cell") this.pickReference(hit.row, hit.col);
			return;
		}
		if (this.headerDrag) {
			const hit = this.hit(evt);
			const drag = this.headerDrag;
			const index = drag.kind === "col" ? hit.col : hit.row;
			if (index < 0 || (drag.kind === "row" && index === 0)) return;
			drag.to = index;
			if (index !== drag.from) drag.moved = true;
			this.hostEl.toggleClass("is-moving", drag.moved);
			const marker = drag.kind === "col" ? (this.colHeadEls.get(index) ?? null) : this.rowEls.get(index)?.firstElementChild ?? null;
			this.markDrop(drag.moved && marker !== null && marker.instanceOf(HTMLElement) ? marker : null);
			return;
		}
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
		const link = target?.closest("a.internal-link") ?? null;
		if (link !== null && link.instanceOf(HTMLElement)) {
			const linktext = link.getAttribute("data-href") ?? link.getAttribute("href");
			if (linktext) this.ctx.callbacks.onHoverLink?.(evt, link, linktext);
		}
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
		this.followLink(link);
	}

	/** Opens a link from a rendered cell in a new tab, never in this one. */
	private followLink(link: HTMLElement): void {
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
		// The drop ends the pick as well as the drag: the next click is a new reference, and the
		// one the drag wrote is replaced by the caret test in `pickReference`.
		this.pointDrag = false;
		this.pointing = null;
		this.dragging = null;
		const drag = this.headerDrag;
		if (drag) {
			this.headerDrag = null;
			this.markDrop(null);
			this.hostEl.removeClass("is-moving");
			if (drag.moved && drag.to !== drag.from) {
				if (drag.kind === "col") this.moveColTo(drag.from, drag.to);
				else this.moveRowTo(drag.from, drag.to);
			}
		}
		if (this.fillDrag) {
			const target = this.fillDrag.last;
			this.fillDrag = null;
			for (const el of this.previewEls) el.removeClass("is-fill-preview");
			this.previewEls = [];
			this.fillFromHandle(target);
		}
	}

	private onDoubleClick(evt: MouseEvent): void {
		if (this.fromTouch()) return;
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
		// Android reports a long press as a context menu too; the long-press timer already has it.
		if (this.fromTouch()) return;
		this.openContextMenu(hit, (menu) => menu.showAtMouseEvent(evt));
	}

	/** `link` is a link under the finger: touch has no Ctrl+click, so the menu offers to open it. */
	private openContextMenu(hit: Hit, show: (menu: Menu) => void, link: HTMLElement | null = null): void {
		if (this.editing) this.commitEdit(0, 0, false);
		const menu = new Menu();
		if (link !== null) {
			menu.addItem((i) => i.setTitle("Open link").setIcon(iconName("link")).onClick(() => this.followLink(link)));
			menu.addSeparator();
		}

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
			const callbacks = this.ctx.callbacks;
			const clipboard = (action: "copy" | "cut" | "paste") => callbacks.onClipboard?.(action);
			menu.addItem((i) => i.setTitle("Edit cell").setIcon(iconName("edit")).onClick(() => this.beginEdit()));
			if (callbacks.onClipboard) {
				menu.addItem((i) => i.setTitle("Cut").setIcon(iconName("cut")).onClick(() => clipboard("cut")));
				menu.addItem((i) => i.setTitle("Copy").setIcon(iconName("copy")).onClick(() => clipboard("copy")));
				menu.addItem((i) => i.setTitle("Paste").setIcon(iconName("paste")).onClick(() => clipboard("paste")));
			}
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
		show(menu);
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
		const z = this.getZoom();
		const startW = (this.cellEl(0, col)?.offsetWidth ?? this.ctx.settings.defaultColWidth * z) / z;
		this.hostEl.addClass("is-resizing");

		const move = (e: MouseEvent) => {
			const width = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, startW + (e.clientX - startX) / z));
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
		const z = this.getZoom();
		const startH = (this.rowEls.get(row)?.offsetHeight ?? this.ctx.settings.defaultRowHeight * z) / z;
		this.hostEl.addClass("is-resizing");

		const move = (e: MouseEvent) => {
			const height = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, startH + (e.clientY - startY) / z));
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
