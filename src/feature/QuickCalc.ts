import { getRaw, type GridModel } from "../model/GridModel";
import { formatCompact, formatNumber, parseNumber, type NumberParseOptions } from "../model/numbers";
import { normalizeRect, type Rect } from "./ops";

/** One-shot functions of §12. No live formulas (D2) — the result is written as literal text. */
export type CalcFunction = "SUM" | "AVERAGE" | "COUNT" | "COUNTA" | "MIN" | "MAX" | "MEDIAN" | "PRODUCT";

export const CALC_FUNCTIONS: CalcFunction[] = [
	"SUM",
	"AVERAGE",
	"COUNT",
	"COUNTA",
	"MIN",
	"MAX",
	"MEDIAN",
	"PRODUCT",
];

export interface Aggregate {
	/** Cells in the selection that hold a number. */
	numericCount: number;
	/** Non-empty cells that are not numeric — reported so a wrong answer is never silent. */
	ignoredCount: number;
	/** Non-empty cells, numeric or not. */
	filledCount: number;
	sum: number;
	average: number | null;
	min: number | null;
	max: number | null;
	median: number | null;
	product: number;
}

export function aggregate(model: GridModel, rect: Rect, opts?: NumberParseOptions): Aggregate {
	const r = normalizeRect(rect);
	const numbers: number[] = [];
	let ignored = 0;
	let filled = 0;

	for (let row = r.r1; row <= r.r2; row++) {
		for (let col = r.c1; col <= r.c2; col++) {
			const raw = getRaw(model, row, col);
			if (raw.trim() === "") continue;
			filled++;
			const n = parseNumber(raw, opts);
			if (n === null) ignored++;
			else numbers.push(n);
		}
	}

	numbers.sort((a, b) => a - b);
	const sum = numbers.reduce((acc, n) => acc + n, 0);
	const product = numbers.reduce((acc, n) => acc * n, 1);

	return {
		numericCount: numbers.length,
		ignoredCount: ignored,
		filledCount: filled,
		sum,
		average: numbers.length > 0 ? sum / numbers.length : null,
		min: numbers.length > 0 ? numbers[0] : null,
		max: numbers.length > 0 ? numbers[numbers.length - 1] : null,
		median: median(numbers),
		product: numbers.length > 0 ? product : 0,
	};
}

function median(sorted: number[]): number | null {
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function applyFunction(agg: Aggregate, fn: CalcFunction): number | null {
	switch (fn) {
		case "SUM":
			return agg.sum;
		case "AVERAGE":
			return agg.average;
		case "COUNT":
			return agg.numericCount;
		case "COUNTA":
			return agg.filledCount;
		case "MIN":
			return agg.min;
		case "MAX":
			return agg.max;
		case "MEDIAN":
			return agg.median;
		case "PRODUCT":
			return agg.numericCount > 0 ? agg.product : null;
	}
}

/** Counting functions are integers regardless of the configured decimal places. */
export function formatResult(fn: CalcFunction, value: number, decimals: number, locale?: string): string {
	if (fn === "COUNT" || fn === "COUNTA") return formatNumber(value, 0, locale);
	return formatNumber(value, decimals, locale);
}

/** `Sum · Avg · Count` line for the status bar (§12). */
export function summaryLine(agg: Aggregate, locale?: string): string {
	if (agg.numericCount === 0) {
		return agg.filledCount > 0 ? `Count ${agg.filledCount}` : "";
	}
	const parts = [
		`Sum ${formatCompact(agg.sum, locale)}`,
		agg.average === null ? null : `Avg ${formatCompact(agg.average, locale)}`,
		`Count ${agg.numericCount}`,
	].filter((p): p is string => p !== null);
	if (agg.ignoredCount > 0) parts.push(`ignored ${agg.ignoredCount} non-numeric ${agg.ignoredCount === 1 ? "cell" : "cells"}`);
	return parts.join(" · ");
}
