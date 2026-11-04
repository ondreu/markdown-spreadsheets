import { describe, expect, it } from "vitest";
import { createModel, getRaw, recomputeUsedRange, setRaw, type GridModel } from "../src/model/GridModel";
import {
	adjustFormulaRefs,
	buildFormulaCell,
	recalculate,
	sourceOf,
	stripFormula,
	toExcelFormula,
} from "../src/feature/formula";
import { recalculateWorkbook, shiftTableRefs } from "../src/feature/workbook";

function grid(rows: string[][]): GridModel {
	const model = createModel();
	rows.forEach((row, r) => row.forEach((v, c) => setRaw(model, r, c, v)));
	recomputeUsedRange(model);
	return model;
}

const plain = { format: (v: number) => String(v) };

describe("Table2!B3", () => {
	const other = (): GridModel => grid([["Item", "Qty", "Price"], ["Movers", "2", "1200"], ["Desks", "3", "6980"]]);

	it("reads a cell of another table", () => {
		const here = grid([["Total"], [""]]);
		setRaw(here, 1, 0, buildFormulaCell("0", "Table2!B2"));
		recalculate(here, { ...plain, tables: [sourceOf(here), sourceOf(other())] });
		expect(stripFormula(getRaw(here, 1, 0))).toBe("2");
	});

	it("sums a range of another table", () => {
		const here = grid([["Total"], [""]]);
		setRaw(here, 1, 0, buildFormulaCell("0", "SUM(Table2!C2:C3)"));
		recalculate(here, { ...plain, tables: [sourceOf(here), sourceOf(other())] });
		expect(stripFormula(getRaw(here, 1, 0))).toBe("8180");
	});

	it("can count and filter in another table", () => {
		const here = grid([["N"], [""]]);
		setRaw(here, 1, 0, buildFormulaCell("0", 'COUNTIF(Table2!A2:A3,"Desks")'));
		recalculate(here, { ...plain, tables: [sourceOf(here), sourceOf(other())] });
		expect(stripFormula(getRaw(here, 1, 0))).toBe("1");
	});

	it("says which table is missing", () => {
		const here = grid([["Total"], [""]]);
		setRaw(here, 1, 0, buildFormulaCell("0", "Table5!B2"));
		const result = recalculate(here, { ...plain, tables: [sourceOf(here)] });
		expect(stripFormula(getRaw(here, 1, 0))).toBe("#REF!");
		expect(result.errors[0]?.message).toContain("Table 5");
	});

	it("refuses a name that is not a table number", () => {
		const here = grid([["Total"], [""]]);
		setRaw(here, 1, 0, buildFormulaCell("0", "Budget!B2"));
		recalculate(here, { ...plain, tables: [sourceOf(here)] });
		expect(stripFormula(getRaw(here, 1, 0))).toBe("#NAME?");
	});

	it("is not moved by rows shifting in its own table", () => {
		const model = grid([["A", "B"], ["1", "Table2!B2"]]);
		setRaw(model, 1, 1, buildFormulaCell("", "Table2!B2"));
		adjustFormulaRefs(model, { kind: "insertRows", at: 1, count: 2 });
		expect(stripFormula(getRaw(model, 1, 1))).toBe("");
		expect(getRaw(model, 1, 1)).toContain("Table2!B2");
	});

	it("has no Excel formula, so an export carries the value only", () => {
		expect(toExcelFormula("Table2!B2")).toBeNull();
		expect(toExcelFormula("SUM(Table2!B2:B9)")).toBeNull();
	});
});

describe("recalculateWorkbook", () => {
	it("settles a chain across three tables", () => {
		// Table 3 holds the raw numbers, table 2 doubles their total, table 1 adds a hundred.
		const three = grid([["Rate"], ["5"]]);
		const two = grid([["Double"], [""]]);
		setRaw(two, 1, 0, buildFormulaCell("0", "SUM(Table3!A2:A2)*2"));
		const one = grid([["Grand"], [""]]);
		setRaw(one, 1, 0, buildFormulaCell("0", "Table2!A2+100"));

		const result = recalculateWorkbook([one, two, three], plain);
		expect(stripFormula(getRaw(one, 1, 0))).toBe("110");
		expect(stripFormula(getRaw(two, 1, 0))).toBe("10");
		expect(result.changed).toBeGreaterThan(0);
		expect(result.passes).toBeGreaterThan(1);
	});

	it("stops when nothing changes any more", () => {
		const one = grid([["A"], ["1"]]);
		const two = grid([["B"], ["2"]]);
		const result = recalculateWorkbook([one, two], plain);
		expect(result.changed).toBe(0);
		expect(result.passes).toBe(1);
	});
});

describe("shiftTableRefs", () => {
	const note = [
		"| A | B |",
		"| --- | --- |",
		"| total | 3 %%=Table2!B2+Table3!C4%% |",
		"",
		"Some prose about Table2 and Table 3 that must not move.",
		"",
	].join("\n");

	it("renumbers the references inside formulas only", () => {
		const moved = shiftTableRefs(note, (n) => (n === 2 ? 3 : n === 3 ? 4 : n));
		expect(moved).toContain("%%=Table3!B2+Table4!C4%%");
		expect(moved).toContain("Some prose about Table2 and Table 3 that must not move.");
	});

	it("leaves a reference alone when the table is gone", () => {
		const moved = shiftTableRefs(note, (n) => (n === 2 ? null : n));
		expect(moved).toContain("Table2!B2");
		expect(moved).not.toContain("Table3!B2");
	});

	it("returns the note untouched when there is nothing to move", () => {
		expect(shiftTableRefs(note, (n) => n)).toBe(note);
		expect(shiftTableRefs("no formulas here", () => 9)).toBe("no formulas here");
	});
});
