import { describe, expect, it } from "vitest";
import { getRaw } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";
import type { TableLayout } from "../src/store/Sidecar";
import { applyMerge, MergeError, planMerge, type MergeOptions } from "../src/feature/merge";

const layout: TableLayout = { colWidths: [], rowHeights: {}, wrapCols: [], frozenRows: 0, frozenCols: 0, decimals: 2 };

const base = (): ReturnType<typeof parseTable> =>
	parseTable(
		[
			"| Code | Item | Qty | Note |",
			"| --- | --- | ---: | --- |",
			"| A-1 | Movers | 2 | keep me |",
			"| A-2 | Desks | 3 | keep me too |",
			"| A-9 | Gone | 1 | stale |",
			"",
		].join("\n"),
	);

const opts = (over: Partial<MergeOptions> = {}): MergeOptions => ({
	keyCols: [0],
	align: "header",
	addColumns: false,
	removeMissing: false,
	...over,
});

const file = (rows: string[]): string[][] => [["Code", "Qty"], ...rows.map((r) => r.split("|"))];

describe("planMerge", () => {
	it("matches rows by the key and maps columns by header", () => {
		const plan = planMerge(base(), file(["A-1|5", "A-3|7"]), opts());
		expect(plan.matches).toEqual([{ row: 1, from: 1 }]);
		expect(plan.newRows).toEqual([2]);
		// A-2 and A-9 are both absent from the file.
		expect(plan.missing).toEqual([2, 3]);
		expect(plan.pairs).toEqual([
			{ tableCol: 0, importCol: 0 },
			{ tableCol: 2, importCol: 1 },
		]);
	});

	it("refuses a file without the key column, and one without data", () => {
		expect(() => planMerge(base(), [["Name", "Qty"], ["x", "1"]], opts())).toThrow(MergeError);
		expect(() => planMerge(base(), [["Code", "Qty"]], opts())).toThrow(/at least one row/);
		expect(() => planMerge(base(), file(["A-1|5"]), opts({ keyCols: [] }))).toThrow(/identifies a row/);
	});

	it("reports repeated keys instead of merging into the wrong row", () => {
		const model = parseTable("| Code | Item |\n| --- | --- |\n| A-1 | first |\n| A-1 | second |\n");
		const plan = planMerge(model, file(["A-1|5"]), opts());
		expect(plan.duplicates).toBe(1);
		expect(plan.matches).toEqual([{ row: 1, from: 1 }]);
	});

	it("can follow the columns by position", () => {
		const plan = planMerge(base(), file(["A-1|5"]), opts({ align: "position" }));
		expect(plan.pairs).toEqual([
			{ tableCol: 0, importCol: 0 },
			{ tableCol: 1, importCol: 1 },
		]);
	});

	it("offers a new column when the file has one", () => {
		const values = [["Code", "Qty", "Supplier"], ["A-1", "5", "Acme"]];
		expect(planMerge(base(), values, opts()).newColumns).toEqual([]);
		expect(planMerge(base(), values, opts({ addColumns: true })).newColumns).toEqual([{ importCol: 2, header: "Supplier" }]);
	});
});

describe("applyMerge", () => {
	it("updates the matched row and adds the new one, leaving other cells alone", () => {
		const model = base();
		const values = file(["A-1|5", "A-3|7"]);
		const result = applyMerge(model, layout, values, planMerge(model, values, opts()));
		expect(result).toMatchObject({ updated: 1, added: 1, removed: 0 });
		expect(getRaw(model, 1, 2)).toBe("5");
		expect(getRaw(model, 1, 3)).toBe("keep me");
		expect(getRaw(model, 4, 0)).toBe("A-3");
		expect(getRaw(model, 4, 2)).toBe("7");
		// A-2 and A-9 are still there: removing is opt-in.
		expect(getRaw(model, 2, 0)).toBe("A-2");
		expect(getRaw(model, 3, 0)).toBe("A-9");
	});

	it("adds an imported column with its header", () => {
		const model = base();
		const values = [["Code", "Supplier"], ["A-2", "Acme"]];
		applyMerge(model, layout, values, planMerge(model, values, opts({ addColumns: true })));
		expect(getRaw(model, 0, 4)).toBe("Supplier");
		expect(getRaw(model, 2, 4)).toBe("Acme");
		expect(getRaw(model, 1, 4)).toBe("");
	});

	it("removes the rows the file no longer has, when asked", () => {
		const model = base();
		const values = file(["A-1|5"]);
		const result = applyMerge(model, layout, values, planMerge(model, values, opts({ removeMissing: true })));
		expect(result.removed).toBe(2);
		const text = serializeTable(model, { compact: true });
		expect(text).not.toContain("A-2");
		expect(text).not.toContain("A-9");
		expect(text).toContain("A-1");
	});

	it("keeps the table valid markdown through a merge with a new column", () => {
		const model = base();
		const values = [["Code", "Qty", "Supplier"], ["A-1", "5", "Acme"], ["A-3", "7", "Beta"]];
		applyMerge(model, layout, values, planMerge(model, values, opts({ addColumns: true })));
		const text = serializeTable(model, { compact: true });
		const rows = text.trim().split("\n");
		expect(new Set(rows.map((r) => r.split("|").length)).size).toBe(1);
	});
});
