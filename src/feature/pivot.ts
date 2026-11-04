import { getRaw, type GridModel } from "../model/GridModel";
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
