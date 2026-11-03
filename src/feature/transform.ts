import { getRaw, recomputeUsedRange, setRaw, type GridModel } from "../model/GridModel";
import { parseNumber, type NumberParseOptions } from "../model/numbers";
import { isDelimiterRow, splitCells } from "../model/parse";
import type { TableLayout } from "../store/Sidecar";
import { compareCells, deleteCols, deleteRows, insertCols, insertRows, normalizeRect, peelInline, type Rect } from "./ops";

/**
 * Data-shaping operations: split and merge columns, de-duplicate, multi-key sort, text and number
 * transforms, filters and lint-style checks.
 *
 * Everything here works on the raw markdown of the cells and leaves the cosmetic layout consistent
 * by going through the structural helpers of `ops.ts`, which reindex widths, heights and wrap
 * flags (§8.4). Row 0 is the markdown header: it is never moved or deleted.
 */

function dataRowList(model: GridModel): number[] {
	const out: number[] = [];
	for (let r = 1; r < model.usedRange.rows; r++) out.push(r);
	return out;
}

function uniqueSorted(list: number[], min: number): number[] {
	return Array.from(new Set(list.filter((n) => Number.isInteger(n) && n >= min))).sort((a, b) => a - b);
}

/* ------------------------------------------------------------- split & merge */

/**
 * Splits every cell of `col`, the header included, on `delimiter` into that column and new columns
 * inserted to its right. Returns the number of columns added.
 *
 * The new columns are inserted through `insertCols` so the widths and wrap flags of everything to
 * the right move with their columns instead of landing on the new ones.
 */
export function textToColumns(model: GridModel, layout: TableLayout, col: number, delimiter: string): number {
	if (delimiter === "" || col < 0) return 0;
	const rows = model.usedRange.rows;
	const split: string[][] = [];
	let maxParts = 1;
	for (let r = 0; r < rows; r++) {
		const raw = getRaw(model, r, col);
		const parts = raw.includes(delimiter) ? raw.split(delimiter).map((p) => p.trim()) : [raw];
		split.push(parts);
		if (parts.length > maxParts) maxParts = parts.length;
	}
	const added = maxParts - 1;
	if (added === 0) return 0;

	insertCols(model, layout, col + 1, added);
	for (let r = 0; r < rows; r++) {
		for (let j = 0; j < maxParts; j++) setRaw(model, r, col + j, split[r][j] ?? "");
	}
	recomputeUsedRange(model);
	return added;
}

/** Joins the non-empty values of `cols`, left to right, into the first of them and deletes the rest. */
export function mergeColumns(model: GridModel, layout: TableLayout, cols: number[], separator: string): void {
	const list = uniqueSorted(cols, 0);
	if (list.length < 2) return;
	const [first, ...rest] = list;
	for (let r = 0; r < model.usedRange.rows; r++) {
		const parts = list.map((c) => getRaw(model, r, c)).filter((v) => v.trim() !== "");
		setRaw(model, r, first, parts.join(separator));
	}
	deleteCols(model, layout, rest);
}

/* ------------------------------------------------------------ rows & columns */

/**
 * Deletes data rows whose key repeats an earlier row, keeping the first occurrence. The key is the
 * exact raw text of `cols`, or of every column when omitted. Returns how many rows were removed.
 */
export function removeDuplicateRows(model: GridModel, layout: TableLayout, cols?: number[]): number {
	const width = model.usedRange.cols;
	const keyCols = cols && cols.length > 0 ? uniqueSorted(cols, 0) : Array.from({ length: width }, (_, c) => c);
	const seen = new Set<string>();
	const doomed: number[] = [];
	for (const r of dataRowList(model)) {
		const key = JSON.stringify(keyCols.map((c) => getRaw(model, r, c)));
		if (seen.has(key)) doomed.push(r);
		else seen.add(key);
	}
	if (doomed.length === 0) return 0;
	return deleteRows(model, layout, doomed);
}

/**
 * Stable multi-key sort of the data rows, or of `rows` when more than one is given. The first key
 * decides, later keys break ties, and rows equal on every key keep their order.
 *
 * Row heights follow their row, as in `sortRows`.
 */
export function sortRowsMulti(
	model: GridModel,
	layout: TableLayout,
	keys: Array<{ col: number; ascending: boolean }>,
	rows: number[] | undefined,
	numberOpts?: NumberParseOptions,
): void {
	if (keys.length === 0) return;
	const cols = Math.max(model.usedRange.cols, 1);
	const targets = rows && rows.length > 1 ? uniqueSorted(rows, 1) : dataRowList(model);
	if (targets.length < 2) return;

	const snapshot = targets.map((row) => ({
		height: layout.rowHeights[String(row)],
		values: Array.from({ length: cols }, (_, c) => getRaw(model, row, c)),
	}));
	snapshot.sort((a, b) => {
		for (const key of keys) {
			const cmp = compareCells(a.values[key.col] ?? "", b.values[key.col] ?? "", numberOpts);
			if (cmp !== 0) return key.ascending ? cmp : -cmp;
		}
		return 0;
	});

	for (let i = 0; i < targets.length; i++) {
		const target = targets[i];
		const item = snapshot[i];
		for (let c = 0; c < cols; c++) setRaw(model, target, c, item.values[c]);
		if (item.height === undefined) delete layout.rowHeights[String(target)];
		else layout.rowHeights[String(target)] = item.height;
	}
	recomputeUsedRange(model);
}

/** Inserts a copy of the given data rows, as one block in their order, below the last of them. */
export function duplicateRows(model: GridModel, layout: TableLayout, rows: number[]): void {
	const list = uniqueSorted(rows, 1);
	if (list.length === 0) return;
	const cols = Math.max(model.usedRange.cols, 1);
	const copies = list.map((row) => ({
		height: layout.rowHeights[String(row)],
		values: Array.from({ length: cols }, (_, c) => getRaw(model, row, c)),
	}));
	const at = list[list.length - 1] + 1;
	insertRows(model, layout, at, copies.length);
	copies.forEach((copy, i) => {
		for (let c = 0; c < cols; c++) setRaw(model, at + i, c, copy.values[c]);
		if (copy.height !== undefined) layout.rowHeights[String(at + i)] = copy.height;
	});
	recomputeUsedRange(model);
}

/** Inserts a copy of the given columns — alignment, width and wrap included — right of the last one. */
export function duplicateCols(model: GridModel, layout: TableLayout, cols: number[]): void {
	const list = uniqueSorted(cols, 0);
	if (list.length === 0) return;
	const rows = Math.max(model.usedRange.rows, 1);
	const copies = list.map((col) => ({
		align: model.colAlign[col] ?? null,
		width: layout.colWidths[col],
		wrapped: layout.wrapCols.includes(col),
		values: Array.from({ length: rows }, (_, r) => getRaw(model, r, col)),
	}));
	const at = list[list.length - 1] + 1;
	// `insertCols` splices the alignment array at `at`; a shorter array would put the new entries
	// at its end instead and leave holes.
	while (model.colAlign.length < at) model.colAlign.push(null);
	insertCols(model, layout, at, copies.length);
	copies.forEach((copy, i) => {
		const target = at + i;
		for (let r = 0; r < rows; r++) setRaw(model, r, target, copy.values[r]);
		model.colAlign[target] = copy.align;
		if (copy.width !== undefined && layout.colWidths.length > 0) layout.colWidths[target] = copy.width;
		if (copy.wrapped) layout.wrapCols.push(target);
	});
	layout.wrapCols.sort((a, b) => a - b);
	recomputeUsedRange(model);
}

export function transpose(values: string[][]): string[][] {
	const width = values.reduce((w, row) => Math.max(w, row.length), 0);
	const out: string[][] = [];
	for (let c = 0; c < width; c++) out.push(values.map((row) => row[c] ?? ""));
	return out;
}

/* ---------------------------------------------------------------------- text */

export type TextTransform = "upper" | "lower" | "title" | "sentence" | "trim" | "nbsp";

interface Segment {
	text: string;
	/** False for markdown syntax whose meaning depends on its exact characters. */
	visible: boolean;
	/**
	 * A wikilink target followed by an alias: hidden in reading view, so it does not count as the
	 * first word of a sentence — the alias after it does.
	 */
	silent?: boolean;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\/[^\s<>]*/i;
const AUTOLINK = /^<[a-z][a-z0-9+.-]*:[^\s<>]*>/i;
const ENTITY = /^&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

/**
 * Splits a cell into visible text and syntax that a case change would break.
 *
 * Protected: code spans, `%%comments%%`, wikilink targets (the alias after `|` is visible text),
 * link destinations in `](...)`, autolinks, bare URLs and HTML entities — `&NBSP;` is not an
 * entity, and a wikilink to `[[TARGET]]` is a different note on a case-sensitive file system.
 */
function segments(raw: string): Segment[] {
	const out: Segment[] = [];
	let buf = "";
	const flush = (): void => {
		if (buf !== "") out.push({ text: buf, visible: true });
		buf = "";
	};
	const protect = (text: string, silent = false): void => {
		flush();
		out.push({ text, visible: false, silent });
	};

	let i = 0;
	while (i < raw.length) {
		const ch = raw[i];
		const rest = raw.slice(i);
		if (ch === "\\" && i + 1 < raw.length) {
			buf += raw.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "`") {
			let run = 1;
			while (raw[i + run] === "`") run++;
			const close = closingBackticks(raw, i + run, run);
			const end = close === -1 ? i + run : close + run;
			protect(raw.slice(i, end));
			i = end;
			continue;
		}
		if (rest.startsWith("%%")) {
			const close = raw.indexOf("%%", i + 2);
			const end = close === -1 ? raw.length : close + 2;
			protect(raw.slice(i, end));
			i = end;
			continue;
		}
		if (rest.startsWith("[[")) {
			const close = raw.indexOf("]]", i + 2);
			if (close !== -1) {
				const inner = raw.slice(i + 2, close);
				const bar = inner.indexOf("|");
				if (bar === -1) {
					protect(raw.slice(i, close + 2));
				} else {
					protect(raw.slice(i, i + 2 + bar + 1), true);
					buf += inner.slice(bar + 1);
					protect("]]");
				}
				i = close + 2;
				continue;
			}
		}
		if (rest.startsWith("](")) {
			const end = closingParen(raw, i + 1);
			if (end !== -1) {
				protect(raw.slice(i, end + 1));
				i = end + 1;
				continue;
			}
		}
		const special = AUTOLINK.exec(rest) ?? (ch === "&" ? ENTITY.exec(rest) : null) ?? (/[a-z]/i.test(ch) && !isWordChar(raw[i - 1]) ? URL_SCHEME.exec(rest) : null);
		if (special) {
			protect(special[0]);
			i += special[0].length;
			continue;
		}
		buf += ch;
		i++;
	}
	flush();
	return out;
}

function closingBackticks(s: string, from: number, length: number): number {
	let j = from;
	while (j < s.length) {
		if (s[j] !== "`") {
			j++;
			continue;
		}
		let run = 1;
		while (s[j + run] === "`") run++;
		if (run === length) return j;
		j += run;
	}
	return -1;
}

/** Index of the `)` closing the `(` at `open`, counting nested parentheses, or -1. */
function closingParen(s: string, open: number): number {
	let depth = 0;
	for (let j = open; j < s.length; j++) {
		const ch = s[j];
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return j;
		}
	}
	return -1;
}

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function isLetter(ch: string): boolean {
	return /\p{L}/u.test(ch);
}

/**
 * Applies a text transform to a cell's raw markdown without touching its syntax: only visible
 * text changes case, so link targets, URLs, code and comments come out byte for byte.
 */
export function transformText(raw: string, kind: TextTransform): string {
	if (kind === "trim") return raw.replace(/[ \t\n\r\f\v]+/g, " ").trim();
	const segs = segments(raw);
	if (kind === "nbsp") {
		return segs.map((s) => (s.visible ? s.text.split(" ").join(" ") : s.text.replace(/^&(?:nbsp|#160|#x0*a0);$/i, " "))).join("");
	}
	if (kind === "upper" || kind === "lower") {
		return segs.map((s) => (s.visible ? (kind === "upper" ? s.text.toUpperCase() : s.text.toLowerCase()) : s.text)).join("");
	}

	// Title and sentence case need context across segments: the previous character decides
	// whether a letter starts a word, and protected text can sit between two words.
	let out = "";
	let prev = "";
	let capNext = true;
	let sentenceEnd = false;
	for (const seg of segs) {
		if (!seg.visible) {
			out += seg.text;
			if (!seg.silent && /\p{L}/u.test(seg.text)) {
				capNext = false;
				sentenceEnd = false;
			}
			prev = seg.text[seg.text.length - 1] ?? prev;
			continue;
		}
		for (const ch of seg.text) {
			if (kind === "title") {
				if (isLetter(ch)) out += isWordChar(prev) || prev === "'" || prev === "’" ? ch.toLowerCase() : ch.toUpperCase();
				else out += ch;
			} else if (isLetter(ch)) {
				out += capNext ? ch.toUpperCase() : ch.toLowerCase();
				capNext = false;
				sentenceEnd = false;
			} else {
				out += ch;
				if (ch === "." || ch === "!" || ch === "?") sentenceEnd = true;
				else if (/\s/.test(ch)) {
					if (sentenceEnd) capNext = true;
				} else if (/\p{N}/u.test(ch)) {
					capNext = false;
					sentenceEnd = false;
				}
			}
			prev = ch;
		}
	}
	return out;
}

/** Applies `kind` to every non-empty cell of `rect`. Returns the number of cells changed. */
export function applyTextTransform(model: GridModel, rect: Rect, kind: TextTransform): number {
	const r = normalizeRect(rect);
	let changed = 0;
	for (let row = r.r1; row <= r.r2; row++) {
		for (let col = r.c1; col <= r.c2; col++) {
			const raw = getRaw(model, row, col);
			if (raw === "") continue;
			const next = transformText(raw, kind);
			if (next === raw) continue;
			setRaw(model, row, col, next);
			changed++;
		}
	}
	if (changed > 0) recomputeUsedRange(model);
	return changed;
}

/* --------------------------------------------------------------------- stats */

export interface ColumnStats {
	filled: number;
	empty: number;
	distinct: number;
	numeric: number;
	sum: number;
	min: number | null;
	max: number | null;
	average: number | null;
	mostCommon: { value: string; count: number } | null;
}

/** Profile of one column over the data rows; the header is a label, not a value. */
export function columnStats(model: GridModel, col: number, numberOpts?: NumberParseOptions): ColumnStats {
	const rows = dataRowList(model);
	const counts = valueCounts(model, col);
	let filled = 0;
	let numeric = 0;
	let sum = 0;
	let min: number | null = null;
	let max: number | null = null;
	for (const r of rows) {
		const raw = getRaw(model, r, col);
		if (raw.trim() === "") continue;
		filled++;
		const n = parseNumber(raw, numberOpts);
		if (n === null) continue;
		numeric++;
		sum += n;
		if (min === null || n < min) min = n;
		if (max === null || n > max) max = n;
	}
	const ranked = rankValues(counts);
	return {
		filled,
		empty: rows.length - filled,
		distinct: counts.size,
		numeric,
		sum,
		min,
		max,
		average: numeric > 0 ? sum / numeric : null,
		mostCommon: ranked.length > 0 ? { value: ranked[0], count: counts.get(ranked[0]) ?? 0 } : null,
	};
}

function valueCounts(model: GridModel, col: number, exceptRow?: number): Map<string, number> {
	const counts = new Map<string, number>();
	for (const r of dataRowList(model)) {
		if (r === exceptRow) continue;
		const raw = getRaw(model, r, col);
		if (raw.trim() === "") continue;
		counts.set(raw, (counts.get(raw) ?? 0) + 1);
	}
	return counts;
}

function rankValues(counts: Map<string, number>): string[] {
	return Array.from(counts.keys()).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Distinct non-empty values of a column's data rows, most frequent first, ties alphabetical.
 * `exceptRow` leaves out the row being edited, so its own half-typed value is not suggested back.
 */
export function distinctColumnValues(model: GridModel, col: number, exceptRow?: number): string[] {
	return rankValues(valueCounts(model, col, exceptRow));
}

/* ------------------------------------------------------------------- numbers */

export type NumberStyle = "number" | "percent" | "currency";

export interface NumberFormatOptions {
	style: NumberStyle;
	decimals: number;
	locale?: string;
	/** ISO 4217 code for the currency style; EUR when omitted. */
	currency?: string;
	grouping: boolean;
}

/**
 * Rewrites the numeric cells of `rect` as formatted text. The header row is a label and is
 * skipped, as are formula cells (`%%`) and code spans, whose text is literal on purpose.
 *
 * The result is plain text in the note — GFM has no number formats (D1) — so emphasis around the
 * number is kept: `**42**` stays bold. Returns the number of cells changed.
 */
export function formatNumbers(model: GridModel, rect: Rect, opts: NumberFormatOptions, numberOpts?: NumberParseOptions): number {
	const r = normalizeRect(rect);
	const d = Math.max(0, Math.min(10, Math.round(opts.decimals)));
	let formatter: Intl.NumberFormat;
	try {
		formatter = new Intl.NumberFormat(opts.locale && opts.locale.length > 0 ? opts.locale : undefined, {
			style: opts.style === "number" ? "decimal" : opts.style,
			currency: opts.style === "currency" ? (opts.currency && opts.currency.length > 0 ? opts.currency : "EUR") : undefined,
			minimumFractionDigits: d,
			maximumFractionDigits: d,
			useGrouping: opts.grouping,
		});
	} catch {
		// An unknown locale or currency code; nothing sensible to write.
		return 0;
	}

	let changed = 0;
	for (let row = Math.max(1, r.r1); row <= r.r2; row++) {
		for (let col = r.c1; col <= r.c2; col++) {
			const raw = getRaw(model, row, col);
			if (raw === "" || raw.includes("%%")) continue;
			const peeled = peelInline(raw);
			if (peeled.layers.includes("`")) continue;
			const n = parseNumber(peeled.inner, numberOpts);
			if (n === null) continue;
			let next = formatter.format(n);
			for (let i = peeled.layers.length - 1; i >= 0; i--) next = `${peeled.layers[i]}${next}${peeled.layers[i]}`;
			if (next === raw) continue;
			setRaw(model, row, col, next);
			changed++;
		}
	}
	if (changed > 0) recomputeUsedRange(model);
	return changed;
}

/* ------------------------------------------------------------------- filters */

export type FilterKind =
	| "contains"
	| "notContains"
	| "equals"
	| "notEquals"
	| "startsWith"
	| "endsWith"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "empty"
	| "notEmpty"
	| "values";

export interface ColumnFilter {
	col: number;
	kind: FilterKind;
	query?: string;
	/** For `values`: the raw values to keep; `""` stands for the empty cell. */
	values?: string[];
}

/**
 * True when `raw` passes `filter`. Text kinds compare case-insensitively on the raw markdown and
 * an empty query passes everything (the filter is not set yet); `equals ""` matches the empty
 * cell. Numeric kinds need both the cell and the query to parse as numbers.
 */
export function matchesFilter(raw: string, filter: ColumnFilter, numberOpts?: NumberParseOptions): boolean {
	const text = raw.trim();
	const hay = text.toLowerCase();
	const query = (filter.query ?? "").trim();
	const needle = query.toLowerCase();
	switch (filter.kind) {
		case "contains":
			return hay.includes(needle);
		case "notContains":
			return needle === "" || !hay.includes(needle);
		case "equals":
			return hay === needle;
		case "notEquals":
			return hay !== needle;
		case "startsWith":
			return hay.startsWith(needle);
		case "endsWith":
			return hay.endsWith(needle);
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const n = parseNumber(text, numberOpts);
			const q = parseNumber(query, numberOpts);
			if (n === null || q === null) return false;
			if (filter.kind === "gt") return n > q;
			if (filter.kind === "gte") return n >= q;
			if (filter.kind === "lt") return n < q;
			return n <= q;
		}
		case "empty":
			return text === "";
		case "notEmpty":
			return text !== "";
		case "values":
			return (filter.values ?? []).includes(text);
	}
}

/** True when the row passes every filter. */
export function rowMatches(model: GridModel, row: number, filters: ColumnFilter[], numberOpts?: NumberParseOptions): boolean {
	return filters.every((f) => matchesFilter(getRaw(model, row, f.col), f, numberOpts));
}

/* ---------------------------------------------------------------------- lint */

/**
 * Line numbers (1-based; the header is line 1, the alignment row line 2) of body rows whose cell
 * count differs from the header's. GFM pads a short row and drops the overflow of a long one when
 * rendering, so either can hide content from a reader of the note.
 */
export function raggedRows(tableText: string): number[] {
	const lines = tableText.replace(/\r\n/g, "\n").split("\n");
	if (lines.length === 0 || lines[0].trim() === "") return [];
	const width = splitCells(lines[0]).length;
	const bodyStart = lines.length > 1 && isDelimiterRow(lines[1]) ? 2 : 1;
	const out: number[] = [];
	for (let i = bodyStart; i < lines.length; i++) {
		if (lines[i].trim() === "") continue;
		if (splitCells(lines[i]).length !== width) out.push(i + 1);
	}
	return out;
}

/** Header texts that occur more than once (trimmed, case-insensitive), in their first-seen form. */
export function duplicateHeaders(model: GridModel): string[] {
	const first = new Map<string, string>();
	const counts = new Map<string, number>();
	for (let c = 0; c < model.usedRange.cols; c++) {
		const text = getRaw(model, 0, c).trim();
		if (text === "") continue;
		const key = text.toLowerCase();
		if (!first.has(key)) first.set(key, text);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const out: string[] = [];
	for (const [key, text] of first) if ((counts.get(key) ?? 0) > 1) out.push(text);
	return out;
}
