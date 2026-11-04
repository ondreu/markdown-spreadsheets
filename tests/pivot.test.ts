import { describe, expect, it } from "vitest";
import { getRaw, recomputeUsedRange, setRaw } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { pivot, pivotFormat, pivotValues, type PivotOptions } from "../src/feature/pivot";

const model = (): ReturnType<typeof parseTable> =>
	parseTable(
		[
			"| Kind | Item | Qty | Note |",
			"| --- | --- | ---: | --- |",
			"| Furniture | Desks | 3 | shipped |",
			"| Moving | Movers | 2 | |",
			"| Furniture | Chairs | 5 | |",
			"| Light | Lamps | 4 | broken |",
			"| Furniture | Tables | n/a | |",
			"| | Unassigned | 9 | |",
			"",
		].join("\n"),
	);

const opts = (over: Partial<PivotOptions> = {}): PivotOptions => ({ groupCol: 0, valueCol: 2, aggregate: "sum", sort: "value", ...over });

describe("pivot", () => {
	it("sums a column by group, largest first", () => {
		const result = pivot(model(), opts());
		expect(result.headers).toEqual({ label: "Kind", value: "Sum of Qty" });
		expect(result.groups.map((g) => [g.label, g.value])).toEqual([
			["Furniture", 8],
			["Light", 4],
			["Moving", 2],
		]);
		expect(result.total).toBe(14);
	});

	it("counts the rows in a group and ignores what is not a number", () => {
		const furniture = pivot(model(), opts()).groups[0];
		expect(furniture.rows).toBe(3);
		expect(furniture.skipped).toBe(1);
		expect(pivot(model(), opts({ aggregate: "count" })).groups[0].value).toBe(3);
	});

	it("averages over the numbers it has, not over the rows", () => {
		const byLabel = (aggregate: PivotOptions["aggregate"]): number =>
			pivot(model(), opts({ aggregate })).groups.find((group) => group.label === "Furniture")?.value ?? Number.NaN;
		expect(byLabel("average")).toBe(4);
		expect(byLabel("min")).toBe(3);
		expect(byLabel("max")).toBe(5);
	});

	it("reports the rows with no group", () => {
		expect(pivot(model(), opts()).empty).toBe(1);
	});

	it("sorts by label with numbers read as numbers", () => {
		const m = parseTable("| G | V |\n| --- | --- |\n| Item 10 | 1 |\n| Item 9 | 1 |\n| Item 100 | 1 |\n");
		const labels = pivot(m, opts({ groupCol: 0, valueCol: 1, sort: "label" })).groups.map((g) => g.label);
		expect(labels).toEqual(["Item 9", "Item 10", "Item 100"]);
	});

	it("keeps the top groups and says how many were hidden", () => {
		const result = pivot(model(), opts({ limit: 2 }));
		expect(result.groups).toHaveLength(2);
		expect(result.hidden).toBe(1);
	});

	it("writes a plain table, with a total row for more than one group", () => {
		const result = pivot(model(), opts());
		const values = pivotValues(result, (v) => String(v));
		expect(values[0]).toEqual(["Kind", "Sum of Qty"]);
		expect(values[1]).toEqual(["Furniture", "8"]);
		expect(values[values.length - 1]).toEqual(["**Total**", "**14**"]);
	});

	it("formats whole numbers plainly and fractions at a readable size", () => {
		expect(pivotFormat(8)).toBe("8");
		expect(pivotFormat(2.5)).toBe("2.50");
		// Czech grouping is a non-breaking space, which is why the check is explicit.
		expect(pivotFormat(1200.4, "cs-CZ")).toBe("1\u00a0200");
	});

	it("falls back to the column letter when the value column has no header", () => {
		const m = parseTable("| Kind | Qty |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n");
		setRaw(m, 0, 1, "");
		recomputeUsedRange(m);
		expect(pivot(m, opts({ groupCol: 0, valueCol: 1 })).headers.value).toContain("Sum of");
		expect(getRaw(m, 0, 0)).toBe("Kind");
	});
});
