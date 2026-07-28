import { addrKey, parseAddrKey } from "../model/address";
import { getRaw, recomputeUsedRange, setRaw, type Align, type GridModel } from "../model/GridModel";
import { parseNumber, type NumberParseOptions } from "../model/numbers";
import type { TableLayout } from "../store/Sidecar";

export interface Rect {
	r1: number;
	c1: number;
	r2: number;
	c2: number;
}

export function normalizeRect(rect: Rect): Rect {
	return {
		r1: Math.min(rect.r1, rect.r2),
		c1: Math.min(rect.c1, rect.c2),
		r2: Math.max(rect.r1, rect.r2),
		c2: Math.max(rect.c1, rect.c2),
	};
}

export function rectRows(rect: Rect): number[] {
	const r = normalizeRect(rect);
	const out: number[] = [];
	for (let i = r.r1; i <= r.r2; i++) out.push(i);
	return out;
}

export function rectCols(rect: Rect): number[] {
	const r = normalizeRect(rect);
	const out: number[] = [];
	for (let i = r.c1; i <= r.c2; i++) out.push(i);
	return out;
}

export function readRange(model: GridModel, rect: Rect): string[][] {
	const r = normalizeRect(rect);
	const out: string[][] = [];
	for (let row = r.r1; row <= r.r2; row++) {
		const line: string[] = [];
		for (let col = r.c1; col <= r.c2; col++) line.push(getRaw(model, row, col));
		out.push(line);
	}
	return out;
}

export function writeRange(model: GridModel, top: number, left: number, values: string[][]): void {
	for (let i = 0; i < values.length; i++) {
		for (let j = 0; j < values[i].length; j++) {
			setRaw(model, top + i, left + j, values[i][j]);
		}
	}
	recomputeUsedRange(model);
}

export function clearRange(model: GridModel, rect: Rect): void {
	const r = normalizeRect(rect);
	for (let row = r.r1; row <= r.r2; row++) {
		for (let col = r.c1; col <= r.c2; col++) model.cells.delete(addrKey(row, col));
	}
	recomputeUsedRange(model);
}

/* ---------------------------------------------------------------------- rows */

/**
 * Shifts every cell at or below `at` down by `count`, then reindexes the cosmetic state.
 *
 * The reindexing is the part that is easy to forget and miserable to debug (§8.4): without
 * it every row height and wrap flag below the insertion point is off by one.
 */
export function insertRows(model: GridModel, layout: TableLayout, at: number, count: number): void {
	if (count <= 0) return;
	// Row 0 is the markdown header and cannot be pushed down.
	const target = Math.max(1, at);
	const moved = new Map<string, string>();
	for (const [key, cell] of model.cells) {
		const { row } = parseAddrKey(key);
		if (row >= target) moved.set(key, cell.raw);
	}
	for (const key of moved.keys()) model.cells.delete(key);
	for (const [key, raw] of moved) {
		const { row, col } = parseAddrKey(key);
		model.cells.set(addrKey(row + count, col), { raw });
	}
	layout.rowHeights = shiftSparse(layout.rowHeights, target, count);
	recomputeUsedRange(model);
}

export function deleteRows(model: GridModel, layout: TableLayout, rows: number[]): number {
	// The header row is structural in GFM; removing it would turn the table into a paragraph.
	const doomed = new Set(rows.filter((r) => r > 0));
	if (doomed.size === 0) return 0;

	const kept: Array<{ row: number; col: number; raw: string }> = [];
	for (const [key, cell] of model.cells) {
		const { row, col } = parseAddrKey(key);
		if (doomed.has(row)) continue;
		kept.push({ row: row - countBelow(doomed, row), col, raw: cell.raw });
	}
	model.cells.clear();
	for (const item of kept) model.cells.set(addrKey(item.row, item.col), { raw: item.raw });

	const heights: Record<string, number> = {};
	for (const [key, value] of Object.entries(layout.rowHeights)) {
		const row = Number.parseInt(key, 10);
		if (doomed.has(row)) continue;
		heights[String(row - countBelow(doomed, row))] = value;
	}
	layout.rowHeights = heights;
	recomputeUsedRange(model);
	return doomed.size;
}

export function moveRow(model: GridModel, layout: TableLayout, from: number, to: number): void {
	if (from === to || from <= 0 || to <= 0) return;
	const cols = Math.max(model.usedRange.cols, 1);
	const values: string[] = [];
	for (let c = 0; c < cols; c++) values.push(getRaw(model, from, c));
	const height = layout.rowHeights[String(from)];

	deleteRows(model, layout, [from]);
	const target = from < to ? to - 1 : to;
	insertRows(model, layout, target, 1);
	for (let c = 0; c < cols; c++) setRaw(model, target, c, values[c]);
	if (height !== undefined) layout.rowHeights[String(target)] = height;
	recomputeUsedRange(model);
}

/* ------------------------------------------------------------------- columns */

export function insertCols(model: GridModel, layout: TableLayout, at: number, count: number): void {
	if (count <= 0) return;
	const moved = new Map<string, string>();
	for (const [key, cell] of model.cells) {
		const { col } = parseAddrKey(key);
		if (col >= at) moved.set(key, cell.raw);
	}
	for (const key of moved.keys()) model.cells.delete(key);
	for (const [key, raw] of moved) {
		const { row, col } = parseAddrKey(key);
		model.cells.set(addrKey(row, col + count), { raw });
	}

	const align: Align[] = model.colAlign.slice();
	align.splice(at, 0, ...new Array<Align>(count).fill(null));
	model.colAlign = align;

	const widths = layout.colWidths.slice();
	if (widths.length > 0) {
		while (widths.length < at) widths.push(0);
		widths.splice(at, 0, ...new Array<number>(count).fill(0));
		layout.colWidths = widths;
	}
	layout.wrapCols = layout.wrapCols.map((c) => (c >= at ? c + count : c));
	recomputeUsedRange(model);
}

export function deleteCols(model: GridModel, layout: TableLayout, cols: number[]): number {
	const doomed = new Set(cols.filter((c) => c >= 0));
	if (doomed.size === 0) return 0;

	const kept: Array<{ row: number; col: number; raw: string }> = [];
	for (const [key, cell] of model.cells) {
		const { row, col } = parseAddrKey(key);
		if (doomed.has(col)) continue;
		kept.push({ row, col: col - countBelow(doomed, col), raw: cell.raw });
	}
	model.cells.clear();
	for (const item of kept) model.cells.set(addrKey(item.row, item.col), { raw: item.raw });

	model.colAlign = model.colAlign.filter((_, i) => !doomed.has(i));
	layout.colWidths = layout.colWidths.filter((_, i) => !doomed.has(i));
	layout.wrapCols = layout.wrapCols
		.filter((c) => !doomed.has(c))
		.map((c) => c - countBelow(doomed, c))
		.sort((a, b) => a - b);
	if (layout.frozenCols > 0) {
		layout.frozenCols = Math.max(0, layout.frozenCols - countBelow(doomed, layout.frozenCols));
	}
	recomputeUsedRange(model);
	return doomed.size;
}

export function moveCol(model: GridModel, layout: TableLayout, from: number, to: number): void {
	if (from === to) return;
	const rows = Math.max(model.usedRange.rows, 1);
	const values: string[] = [];
	for (let r = 0; r < rows; r++) values.push(getRaw(model, r, from));
	const align = model.colAlign[from] ?? null;
	const width = layout.colWidths[from];
	const wrapped = layout.wrapCols.includes(from);

	deleteCols(model, layout, [from]);
	const target = from < to ? to - 1 : to;
	insertCols(model, layout, target, 1);
	for (let r = 0; r < rows; r++) setRaw(model, r, target, values[r]);
	model.colAlign[target] = align;
	if (width !== undefined && layout.colWidths.length > 0) layout.colWidths[target] = width;
	if (wrapped && !layout.wrapCols.includes(target)) layout.wrapCols.push(target);
	layout.wrapCols.sort((a, b) => a - b);
	recomputeUsedRange(model);
}

/* -------------------------------------------------------------------- format */

export type InlineFormat = "bold" | "italic" | "code" | "strikethrough";

const WRAPPERS: Record<InlineFormat, string> = {
	bold: "**",
	italic: "*",
	code: "`",
	strikethrough: "~~",
};

/** Toggles an inline wrapper across a range, mirroring how Excel's bold button behaves. */
export function applyInlineFormat(model: GridModel, rect: Rect, format: InlineFormat): void {
	const w = WRAPPERS[format];
	const r = normalizeRect(rect);
	const cells: Array<{ row: number; col: number; raw: string }> = [];
	for (let row = r.r1; row <= r.r2; row++) {
		for (let col = r.c1; col <= r.c2; col++) {
			const raw = getRaw(model, row, col);
			if (raw.trim() !== "") cells.push({ row, col, raw });
		}
	}
	if (cells.length === 0) return;
	const allWrapped = cells.every((c) => isWrapped(c.raw, w));
	for (const cell of cells) {
		const next = allWrapped ? cell.raw.slice(w.length, cell.raw.length - w.length) : `${w}${cell.raw}${w}`;
		setRaw(model, cell.row, cell.col, next);
	}
	recomputeUsedRange(model);
}

function isWrapped(raw: string, w: string): boolean {
	return raw.length > w.length * 2 && raw.startsWith(w) && raw.endsWith(w);
}

/* ---------------------------------------------------------------------- fill */

export type FillDirection = "down" | "up" | "right" | "left";

/**
 * Extends the source selection over the target area.
 *
 * A source of two or more numeric cells with a constant step continues the series, which is
 * what a spreadsheet user expects from the fill handle; anything else is copied verbatim.
 */
export function fillRange(
	model: GridModel,
	source: Rect,
	target: Rect,
	direction: FillDirection,
	numberOpts?: NumberParseOptions,
): void {
	const src = normalizeRect(source);
	const tgt = normalizeRect(target);
	const vertical = direction === "down" || direction === "up";

	if (vertical) {
		for (let col = src.c1; col <= src.c2; col++) {
			const series = seriesFor(model, src, col, true, numberOpts);
			const rows = direction === "down" ? range(src.r2 + 1, tgt.r2) : range(tgt.r1, src.r1 - 1).reverse();
			applySeries(model, rows, col, true, series, direction === "down", src);
		}
	} else {
		for (let row = src.r1; row <= src.r2; row++) {
			const series = seriesFor(model, src, row, false, numberOpts);
			const cols = direction === "right" ? range(src.c2 + 1, tgt.c2) : range(tgt.c1, src.c1 - 1).reverse();
			applySeries(model, cols, row, false, series, direction === "right", src);
		}
	}
	recomputeUsedRange(model);
}

interface Series {
	values: string[];
	numeric: { start: number; step: number } | null;
}

function seriesFor(
	model: GridModel,
	src: Rect,
	fixed: number,
	vertical: boolean,
	numberOpts?: NumberParseOptions,
): Series {
	const values: string[] = [];
	const from = vertical ? src.r1 : src.c1;
	const to = vertical ? src.r2 : src.c2;
	for (let i = from; i <= to; i++) {
		values.push(vertical ? getRaw(model, i, fixed) : getRaw(model, fixed, i));
	}
	const nums = values.map((v) => parseNumber(v, numberOpts));
	if (values.length >= 2 && nums.every((n): n is number => n !== null)) {
		const step = nums[1] - nums[0];
		const constant = nums.every((n, i) => i === 0 || Math.abs(n - (nums[0] + step * i)) < 1e-9);
		if (constant) return { values, numeric: { start: nums[0], step } };
	}
	if (values.length === 1 && nums[0] !== null) {
		// A single numeric cell copies rather than counts, same as Excel without Ctrl.
		return { values, numeric: null };
	}
	return { values, numeric: null };
}

function applySeries(
	model: GridModel,
	indices: number[],
	fixed: number,
	vertical: boolean,
	series: Series,
	forward: boolean,
	src: Rect,
): void {
	const len = series.values.length;
	if (len === 0) return;
	const srcStart = vertical ? src.r1 : src.c1;
	const srcEnd = vertical ? src.r2 : src.c2;

	for (let n = 0; n < indices.length; n++) {
		const i = indices[n];
		const offset = forward ? i - srcEnd : srcStart - i;
		let value: string;
		if (series.numeric) {
			const stepsFromStart = forward ? len - 1 + offset : -offset;
			value = trimFloat(series.numeric.start + series.numeric.step * stepsFromStart);
		} else {
			const idx = forward ? (offset - 1) % len : (len - (offset % len)) % len;
			value = series.values[((idx % len) + len) % len];
		}
		if (vertical) setRaw(model, i, fixed, value);
		else setRaw(model, fixed, i, value);
	}
}

function trimFloat(n: number): string {
	const rounded = Math.round(n * 1e9) / 1e9;
	return String(rounded);
}

function range(from: number, to: number): number[] {
	const out: number[] = [];
	for (let i = from; i <= to; i++) out.push(i);
	return out;
}

/* ---------------------------------------------------------------------- sort */

export interface SortSpec {
	col: number;
	ascending: boolean;
	/** `undefined` sorts every data row; a rect restricts it to the selected rows. */
	rows?: number[];
}

/**
 * Sorts data rows in place. Row 0 never moves — it is the markdown header.
 *
 * Row heights follow their row, because a tall row that stays behind while its content moves
 * looks like a rendering bug.
 */
export function sortRows(model: GridModel, layout: TableLayout, spec: SortSpec, numberOpts?: NumberParseOptions): void {
	const cols = Math.max(model.usedRange.cols, 1);
	const rows = spec.rows && spec.rows.length > 1 ? spec.rows.filter((r) => r > 0).sort((a, b) => a - b) : dataRows(model);
	if (rows.length < 2) return;

	const snapshot = rows.map((row) => ({
		row,
		height: layout.rowHeights[String(row)],
		values: Array.from({ length: cols }, (_, c) => getRaw(model, row, c)),
	}));

	const dir = spec.ascending ? 1 : -1;
	snapshot.sort((a, b) => dir * compareCells(a.values[spec.col] ?? "", b.values[spec.col] ?? "", numberOpts));

	for (let i = 0; i < rows.length; i++) {
		const target = rows[i];
		const item = snapshot[i];
		for (let c = 0; c < cols; c++) setRaw(model, target, c, item.values[c]);
		if (item.height === undefined) delete layout.rowHeights[String(target)];
		else layout.rowHeights[String(target)] = item.height;
	}
	recomputeUsedRange(model);
}

/** Numbers before text, empties last — the ordering a spreadsheet user reads as "sorted". */
export function compareCells(a: string, b: string, numberOpts?: NumberParseOptions): number {
	const emptyA = a.trim() === "";
	const emptyB = b.trim() === "";
	if (emptyA && emptyB) return 0;
	if (emptyA) return 1;
	if (emptyB) return -1;
	const na = parseNumber(a, numberOpts);
	const nb = parseNumber(b, numberOpts);
	if (na !== null && nb !== null) return na - nb;
	if (na !== null) return -1;
	if (nb !== null) return 1;
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function dataRows(model: GridModel): number[] {
	const out: number[] = [];
	for (let r = 1; r < model.usedRange.rows; r++) out.push(r);
	return out;
}

/* ------------------------------------------------------------ find & replace */

export interface FindOptions {
	query: string;
	matchCase: boolean;
	wholeCell: boolean;
	regex: boolean;
}

export interface Match {
	row: number;
	col: number;
}

export function findAll(model: GridModel, opts: FindOptions, within?: Rect): Match[] {
	const matcher = buildMatcher(opts);
	if (!matcher) return [];
	const out: Match[] = [];
	const rect = within ? normalizeRect(within) : { r1: 0, c1: 0, r2: model.usedRange.rows - 1, c2: model.usedRange.cols - 1 };
	for (let row = rect.r1; row <= rect.r2; row++) {
		for (let col = rect.c1; col <= rect.c2; col++) {
			const raw = getRaw(model, row, col);
			if (raw !== "" && matcher(raw)) out.push({ row, col });
		}
	}
	return out;
}

export function replaceAll(model: GridModel, opts: FindOptions, replacement: string, within?: Rect): number {
	const matches = findAll(model, opts, within);
	if (matches.length === 0) return 0;
	for (const m of matches) {
		const raw = getRaw(model, m.row, m.col);
		setRaw(model, m.row, m.col, replaceIn(raw, opts, replacement));
	}
	recomputeUsedRange(model);
	return matches.length;
}

function buildMatcher(opts: FindOptions): ((raw: string) => boolean) | null {
	if (opts.query === "") return null;
	if (opts.regex) {
		try {
			const re = new RegExp(opts.query, opts.matchCase ? "" : "i");
			return (raw) => (opts.wholeCell ? new RegExp(`^(?:${opts.query})$`, opts.matchCase ? "" : "i").test(raw) : re.test(raw));
		} catch {
			return null;
		}
	}
	const needle = opts.matchCase ? opts.query : opts.query.toLowerCase();
	return (raw) => {
		const hay = opts.matchCase ? raw : raw.toLowerCase();
		return opts.wholeCell ? hay === needle : hay.includes(needle);
	};
}

function replaceIn(raw: string, opts: FindOptions, replacement: string): string {
	if (opts.wholeCell) return replacement;
	if (opts.regex) {
		try {
			return raw.replace(new RegExp(opts.query, opts.matchCase ? "g" : "gi"), replacement);
		} catch {
			return raw;
		}
	}
	if (opts.matchCase) return raw.split(opts.query).join(replacement);
	// Case-insensitive literal replace without a regex, so the query needs no escaping.
	let out = "";
	const hay = raw.toLowerCase();
	const needle = opts.query.toLowerCase();
	let i = 0;
	while (i < raw.length) {
		if (hay.startsWith(needle, i)) {
			out += replacement;
			i += needle.length;
		} else {
			out += raw[i];
			i++;
		}
	}
	return out;
}

/* ------------------------------------------------------------------- helpers */

function countBelow(set: Set<number>, value: number): number {
	let n = 0;
	for (const item of set) if (item < value) n++;
	return n;
}

function shiftSparse(map: Record<string, number>, from: number, delta: number): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(map)) {
		const index = Number.parseInt(key, 10);
		out[String(index >= from ? index + delta : index)] = value;
	}
	return out;
}

export function setColAlign(model: GridModel, cols: number[], align: Align): void {
	const width = Math.max(model.usedRange.cols, ...cols.map((c) => c + 1));
	while (model.colAlign.length < width) model.colAlign.push(null);
	for (const col of cols) model.colAlign[col] = align;
	recomputeUsedRange(model);
}
