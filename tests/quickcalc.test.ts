import { describe, expect, it } from "vitest";
import { aggregate } from "../src/feature/QuickCalc";
import { parseTable } from "../src/model/parse";

const table = parseTable("| Item | Qty |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n| C | 3 |\n| D | 4 |\n");

describe("aggregate", () => {
	it("totals one range as before", () => {
		const agg = aggregate(table, { r1: 1, c1: 1, r2: 3, c2: 1 });
		expect(agg.numericCount).toBe(3);
		expect(agg.sum).toBe(6);
	});

	it("totals every range of a Ctrl+click selection", () => {
		const agg = aggregate(table, [
			{ r1: 1, c1: 1, r2: 1, c2: 1 },
			{ r1: 3, c1: 1, r2: 4, c2: 1 },
		]);
		expect(agg.numericCount).toBe(3);
		expect(agg.sum).toBe(8);
		expect(agg.filledCount).toBe(3);
	});

	it("counts a cell shared by overlapping ranges twice, as a copy would", () => {
		const agg = aggregate(table, [
			{ r1: 1, c1: 1, r2: 2, c2: 1 },
			{ r1: 2, c1: 1, r2: 3, c2: 1 },
		]);
		expect(agg.numericCount).toBe(4);
		expect(agg.sum).toBe(8);
	});
});
