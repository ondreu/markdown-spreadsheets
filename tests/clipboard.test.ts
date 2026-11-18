import { describe, expect, it } from "vitest";
import { selectionBlock, toTsv, visibleRows } from "../src/feature/clipboard";
import { parseTable } from "../src/model/parse";

const table = parseTable("| Item | Qty |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n| C | 3 |\n");

// Row 0 is the header; a filter on another column hides B, the third row of the note.
const HIDDEN = new Set([2]);

describe("visibleRows", () => {
	it("keeps every row when no filter hides one", () => {
		expect(visibleRows({ r1: 0, c1: 0, r2: 3, c2: 1 }, new Set())).toEqual([0, 1, 2, 3]);
	});

	it("drops the rows a filter hides", () => {
		expect(visibleRows({ r1: 0, c1: 0, r2: 3, c2: 1 }, HIDDEN)).toEqual([0, 1, 3]);
	});

	it("is not affected by hidden rows outside the selection", () => {
		expect(visibleRows({ r1: 1, c1: 0, r2: 2, c2: 1 }, HIDDEN)).toEqual([1]);
	});
});

describe("selectionBlock", () => {
	it("returns the whole rectangle when nothing is filtered", () => {
		expect(selectionBlock(table, { r1: 0, c1: 0, r2: 3, c2: 1 }, new Set())).toEqual([
			["Item", "Qty"],
			["A", "1"],
			["B", "2"],
			["C", "3"],
		]);
	});

	it("leaves out a row the filter hid, so a copy is what the eye sees", () => {
		expect(selectionBlock(table, { r1: 0, c1: 0, r2: 3, c2: 1 }, HIDDEN)).toEqual([
			["Item", "Qty"],
			["A", "1"],
			["C", "3"],
		]);
	});

	it("keeps only the selected columns", () => {
		expect(selectionBlock(table, { r1: 1, c1: 1, r2: 3, c2: 1 }, HIDDEN)).toEqual([["1"], ["3"]]);
	});

	it("gives a TSV block without the hidden row", () => {
		expect(toTsv(selectionBlock(table, { r1: 0, c1: 0, r2: 3, c2: 1 }, HIDDEN))).toBe("Item\tQty\nA\t1\nC\t3");
	});

	it("returns an empty block when the filter hides the whole selection", () => {
		expect(selectionBlock(table, { r1: 2, c1: 0, r2: 2, c2: 1 }, HIDDEN)).toEqual([]);
	});
});
