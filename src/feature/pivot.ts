import { createModel, getRaw, recomputeUsedRange, setRaw, type GridModel } from "../model/GridModel";
import { formatNumber, parseNumber, type NumberParseOptions } from "../model/numbers";
import { plainText } from "./exportCsv";
import { stripFormula } from "./formula";
import { peelInline } from "./ops";

/**
 * Grouping rows by a column and aggregating another, shown as a preview and — only if asked — written
 * into the note as an ordinary GFM table.
 *
 * It is a **view**: nothing is stored, nothing regenerates later. A generated pivot table cannot be
 * refreshed without remembering which rows produced it, and remembering that would mean metadata in
 * the note, which this plugin does not do. So the preview always reads the table it is open on, and
 * the table you can insert is a snapshot, labelled as one.
 */

export type PivotAggregate = "sum" | "average" | "count" | "min" | "max";

export interface PivotOptions {
	/** Column whose values group the rows. */
	groupCol: number;
	/** Column whose numbers are aggregated; ignored by `count`. */
	valueCol: number;
	aggregate: PivotAggregate;
	/** Groups are shown largest first, or in label order. */
	sort: "value" | "label";
	/** How many groups to show; the rest are summed into the preview's footer only. */
	limit?: number;
}

export interface PivotGroup {
	label: string;
	value: number;
	/** Rows that landed in this group. */
	rows: number;
	/** Rows in this group whose value cell was not a number (only counted, never summed). */
	skipped: number;
}

export interface PivotResult {
	headers: { label: string; value: string };
	groups: PivotGroup[];
	total: number;
	/** Rows of the table that had an empty group cell and were left out. */
	empty: number;
	/** Groups beyond `limit`, if a limit was given. */
	hidden: number;
}

/**
 * How a group's label reads: the cell's text without its formula comment, emphasis or link syntax.
 * `[[Carla]]` is a name, not a group called "[[Carla]]".
 */
function labelOf(raw: string): string {
	return plainText(peelInline(stripFormula(raw)).inner)
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => (alias ?? target).trim())
		.trim();
}

export function pivot(model: GridModel, opts: PivotOptions, numberOpts?: NumberParseOptions): PivotResult {
	const rows = model.usedRange.rows;
	const groupHeader = labelOf(getRaw(model, 0, opts.groupCol)) || `Column ${opts.groupCol + 1}`;
	const valueHeader = labelOf(getRaw(model, 0, opts.valueCol)) || `Column ${opts.valueCol + 1}`;
	const buckets = new Map<string, { sum: number; count: number; nums: number; rows: number; min: number; max: number }>();
	let empty = 0;

	for (let r = 1; r < rows; r++) {
		const label = labelOf(getRaw(model, r, opts.groupCol));
		if (label === "") {
			empty++;
			continue;
		}
		const bucket = buckets.get(label) ?? { sum: 0, count: 0, nums: 0, rows: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
		bucket.rows++;
		const raw = getRaw(model, r, opts.valueCol);
		const value = opts.aggregate === "count" ? null : parseNumber(peelInline(stripFormula(raw)).inner, numberOpts);
		if (value !== null) {
			bucket.sum += value;
			bucket.nums++;
			bucket.min = Math.min(bucket.min, value);
			bucket.max = Math.max(bucket.max, value);
		}
		buckets.set(label, bucket);
	}

	const groups: PivotGroup[] = [];
	for (const [label, bucket] of buckets) {
		const value = aggregateOf(opts.aggregate, bucket);
		groups.push({ label, value, rows: bucket.rows, skipped: opts.aggregate === "count" ? 0 : bucket.rows - bucket.nums });
	}
	groups.sort((a, b) => (opts.sort === "value" ? b.value - a.value || a.label.localeCompare(b.label) : a.label.localeCompare(b.label, undefined, { numeric: true })));

	const total = aggregateTotal(opts.aggregate, groups);
	const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : groups.length;
	const shown = groups.slice(0, limit);
	return {
		headers: { label: groupHeader, value: opts.aggregate === "count" ? "Rows" : `${aggregateName(opts.aggregate)} of ${valueHeader}` },
		groups: shown,
		total,
		empty,
		hidden: groups.length - shown.length,
	};
}

interface Bucket {
	sum: number;
	nums: number;
	rows: number;
	min: number;
	max: number;
}

function aggregateOf(aggregate: PivotAggregate, bucket: Bucket): number {
	switch (aggregate) {
		case "sum":
			return bucket.sum;
		case "average":
			return bucket.nums === 0 ? 0 : bucket.sum / bucket.nums;
		case "min":
			return bucket.nums === 0 ? 0 : bucket.min;
		case "max":
			return bucket.nums === 0 ? 0 : bucket.max;
		case "count":
			return bucket.rows;
	}
}

/** The footer: a sum is the sum of the groups, an average is of all rows (not of the averages). */
function aggregateTotal(aggregate: PivotAggregate, groups: PivotGroup[]): number {
	switch (aggregate) {
		case "sum":
		case "count":
			return groups.reduce((sum, group) => sum + group.value, 0);
		case "min":
			return groups.length === 0 ? 0 : Math.min(...groups.map((group) => group.value));
		case "max":
			return groups.length === 0 ? 0 : Math.max(...groups.map((group) => group.value));
		case "average": {
			const rows = groups.reduce((sum, group) => sum + group.rows, 0);
			return rows === 0 ? 0 : groups.reduce((sum, group) => sum + group.value * group.rows, 0) / rows;
		}
	}
}

export function aggregateName(aggregate: PivotAggregate): string {
	switch (aggregate) {
		case "sum":
			return "Sum";
		case "average":
			return "Average";
		case "count":
			return "Count";
		case "min":
			return "Minimum";
		case "max":
			return "Maximum";
	}
}

/**
 * The preview as a rectangle of raw Markdown cells: header, one row per group, and a total row when
 * there is more than one group. This is what "Insert as a table" writes, and it is plain GFM.
 */
export function pivotValues(result: PivotResult, format: (value: number) => string): string[][] {
	const values: string[][] = [[result.headers.label, result.headers.value]];
	for (const group of result.groups) values.push([group.label, format(group.value)]);
	if (result.groups.length > 1) values.push(["**Total**", `**${format(result.total)}**`]);
	return values;
}

/** A default formatter for the preview: whole numbers plain, fractions at a sane precision. */
export function pivotFormat(value: number, locale?: string): string {
	const abs = Math.abs(value);
	const decimals = Number.isInteger(value) ? 0 : abs >= 100 ? 0 : abs >= 1 ? 2 : 3;
	return formatNumber(value, decimals, locale);
}

interface Profile {
	filled: number;
	distinct: number;
	numeric: number;
}

function profileOf(model: GridModel, col: number, numberOpts?: NumberParseOptions): Profile {
	const seen = new Set<string>();
	let filled = 0;
	let numeric = 0;
	for (let r = 1; r < model.usedRange.rows; r++) {
		const raw = peelInline(stripFormula(getRaw(model, r, col))).inner.trim();
		if (raw === "") continue;
		filled++;
		seen.add(raw);
		if (parseNumber(raw, numberOpts) !== null) numeric++;
	}
	return { filled, distinct: seen.size, numeric };
}

/**
 * The column a pivot most likely wants to group by: text with a handful of repeated values.
 *
 * A column that differs in every row (a name, an order number) groups into nothing useful, and a
 * numeric column is usually the thing being summed rather than the thing being grouped — picking one
 * made the panel open on "group by quantity, sum the task", which is nonsense with perfect layout.
 */
export function suggestGroupColumn(model: GridModel, maxGroups = 12): number {
	const cols = Math.max(model.usedRange.cols, 1);
	let best = -1;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let c = 0; c < cols; c++) {
		const { filled, distinct, numeric } = profileOf(model, c);
		if (filled < 2 || distinct < 2 || distinct > maxGroups) continue;
		const mostlyText = numeric * 2 <= filled;
		// Text first, then the lowest cardinality; a numeric column only when nothing else works.
		const score = distinct + (mostlyText ? 0 : 1000);
		if (score < bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best === -1 ? 0 : best;
}

/** The column to aggregate: the one with the most numbers in it, ignoring the group column. */
export function suggestValueColumn(model: GridModel, groupCol: number, numberOpts?: NumberParseOptions): number {
	const cols = Math.max(model.usedRange.cols, 1);
	let best = -1;
	let bestNumeric = 0;
	for (let c = 0; c < cols; c++) {
		if (c === groupCol) continue;
		const { numeric } = profileOf(model, c, numberOpts);
		if (numeric > bestNumeric) {
			bestNumeric = numeric;
			best = c;
		}
	}
	return best === -1 ? Math.min(groupCol === 0 ? 1 : 0, cols - 1) : best;
}

/**
 * Several tables as one, and what had to be left out.
 *
 * The classic case is a month per table — January, February, March — with the same columns. Rows are
 * appended and columns are matched **by header**, so a table that has them in a different order still
 * lines up; a column that only one of them has stays, and its other cells are empty. A header that
 * appears twice in one table is reported rather than silently taking the first.
 */
export interface ConsolidationReport {
	tables: number;
	rows: number;
	/** Headers that appear in more than one table with different spellings, kept as separate columns. */
	mismatched: string[];
	/** Columns that only some of the tables have. */
	partial: string[];
}

export interface Consolidated {
	model: GridModel;
	report: ConsolidationReport;
}

function headerOf(table: GridModel, col: number): string {
	return plainText(peelInline(stripFormula(getRaw(table, 0, col))).inner).trim();
}

export function consolidate(tables: GridModel[]): Consolidated {
	const kept = tables.filter((table) => table.usedRange.rows > 1);
	const model = createModel();
	const columns = new Map<string, { col: number; header: string; seen: number }>();
	let width = 0;

	for (const table of kept) {
		for (let c = 0; c < table.usedRange.cols; c++) {
			const header = headerOf(table, c);
			const key = header.toLowerCase();
			const known = columns.get(key);
			if (known === undefined) {
				columns.set(key, { col: width++, header, seen: 1 });
			} else {
				known.seen++;
			}
		}
	}

	const ordered = Array.from(columns.values()).sort((a, b) => a.col - b.col);
	ordered.forEach((entry, index) => setRaw(model, 0, index, entry.header));
	const indexOf = new Map<string, number>();
	ordered.forEach((entry, index) => indexOf.set(entry.header.toLowerCase(), index));

	let row = 1;
	for (const table of kept) {
		const mapping = new Map<number, number>();
		for (let c = 0; c < table.usedRange.cols; c++) {
			const target = indexOf.get(headerOf(table, c).toLowerCase());
			if (target !== undefined && !mapping.has(target)) mapping.set(target, c);
		}
		for (let r = 1; r < table.usedRange.rows; r++) {
			for (const [target, source] of mapping) {
				const raw = getRaw(table, r, source);
				if (raw.trim() !== "") setRaw(model, row, target, raw);
			}
			row++;
		}
	}
	recomputeUsedRange(model);
	const partial = ordered.filter((entry) => entry.seen < kept.length).map((entry) => entry.header);
	return { model, report: { tables: kept.length, rows: row - 1, mismatched: [], partial } };
}

/**
 * A column brought over from another table by a key — a lookup, in one direction.
 *
 * The case: the data has a code and the meaning lives elsewhere. `Table1` says `A-1`, and `Table2`
 * says that `A-1` is "Furniture"; a pivot by kind cannot work until the two are joined. The result is
 * a **copy of the data model with one more column**, made in memory for the view, never written.
 *
 * A key that appears twice in the lookup table keeps its first value and is counted, because silently
 * picking one of two suppliers is how a report becomes wrong without anybody noticing.
 */
export interface LookupSpec {
	/** Column of the data that is matched. */
	keyCol: number;
	/** The table the value comes from. */
	table: GridModel;
	/** Its key column. */
	tableKeyCol: number;
	/** The column to bring over. */
	tableValueCol: number;
	/** Header for the new column; defaults to the lookup table's own. */
	header?: string;
}

export interface LookupResult {
	model: GridModel;
	header: string;
	matched: number;
	/** Data rows whose key is not in the lookup table. */
	unmatched: number;
	/** Keys repeated in the lookup table; the first one wins. */
	duplicates: number;
}

/** Keys compare the way headers do: trimmed, no case, no emphasis. */
function keyOfCell(raw: string): string {
	return plainText(peelInline(stripFormula(raw)).inner).trim().toLowerCase();
}

export function withLookup(data: GridModel, spec: LookupSpec): LookupResult {
	const header = (spec.header ?? headerOf(spec.table, spec.tableValueCol)) || "Lookup";
	const values = new Map<string, string>();
	let duplicates = 0;
	for (let r = 1; r < spec.table.usedRange.rows; r++) {
		const key = keyOfCell(getRaw(spec.table, r, spec.tableKeyCol));
		if (key === "") continue;
		if (values.has(key)) {
			duplicates++;
			continue;
		}
		values.set(key, getRaw(spec.table, r, spec.tableValueCol));
	}

	const model = createModel();
	const width = Math.max(data.usedRange.cols, 1);
	for (let r = 0; r < data.usedRange.rows; r++) {
		for (let c = 0; c < width; c++) {
			const raw = getRaw(data, r, c);
			if (raw !== "") setRaw(model, r, c, raw);
		}
	}
	setRaw(model, 0, width, header);

	let matched = 0;
	let unmatched = 0;
	for (let r = 1; r < data.usedRange.rows; r++) {
		const key = keyOfCell(getRaw(data, r, spec.keyCol));
		const hit = values.get(key);
		if (hit === undefined) {
			unmatched++;
			continue;
		}
		if (hit.trim() !== "") setRaw(model, r, width, hit);
		matched++;
	}
	for (let c = 0; c <= width; c++) model.colAlign[c] = data.colAlign[c] ?? null;
	recomputeUsedRange(model);
	return { model, header, matched, unmatched, duplicates };
}
