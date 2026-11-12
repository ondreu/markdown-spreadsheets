import { describe, expect, it } from "vitest";
import { FORMULA_FUNCTIONS, formulaProblem } from "../src/feature/formula";
import { argumentSlots, formulaFromArgs, slotAt } from "../src/feature/formulaInsert";

const doc = (name: string) => {
	const found = FORMULA_FUNCTIONS.find((f) => f.name === name);
	if (found === undefined) throw new Error(`no such function: ${name}`);
	return found;
};

describe("argumentSlots", () => {
	it("reads a fixed signature into named arguments", () => {
		expect(argumentSlots(doc("ROUND"))).toEqual({
			slots: [
				{ label: "number", optional: false },
				{ label: "digits", optional: false },
			],
			variadic: false,
			unit: 0,
		});
	});

	it("marks the optional tail", () => {
		expect(argumentSlots(doc("SUMIF"))).toEqual({
			slots: [
				{ label: "range", optional: false },
				{ label: "condition", optional: false },
				{ label: "sumRange", optional: true },
			],
			variadic: false,
			unit: 0,
		});
	});

	it("sees the ellipsis as 'more arguments may follow'", () => {
		expect(argumentSlots(doc("SUM"))).toEqual({ slots: [{ label: "number", optional: false }], variadic: true, unit: 1 });
	});

	it("gives a constant no arguments at all", () => {
		expect(argumentSlots(doc("TRUE"))).toEqual({ slots: [], variadic: false, unit: 0 });
	});
});

describe("slotAt", () => {
	it("cycles the repeating group of the IFS family", () => {
		const layout = argumentSlots(doc("COUNTIFS"));
		expect(layout.unit).toBe(2);
		expect([0, 1, 2, 3, 4].map((index) => slotAt(layout, index).label)).toEqual([
			"range",
			"condition",
			"range",
			"condition",
			"range",
		]);
	});

	it("repeats a single argument", () => {
		const layout = argumentSlots(doc("SUM"));
		expect([0, 1, 2].map((index) => slotAt(layout, index).label)).toEqual(["number", "number", "number"]);
	});
});

describe("formulaFromArgs", () => {
	it("builds the call", () => {
		expect(formulaFromArgs("SUM", ["B2:B4"])).toBe("SUM(B2:B4)");
		expect(formulaFromArgs("SUM", ["B2", "C2", "D2"])).toBe("SUM(B2, C2, D2)");
		expect(formulaFromArgs("TRUE", [])).toBe("TRUE()");
	});

	it("drops an optional argument left empty", () => {
		expect(formulaFromArgs("IF", ["B2>10", "1", ""])).toBe("IF(B2>10, 1)");
		expect(formulaFromArgs("IF", ["B2>10", "1", "  "])).toBe("IF(B2>10, 1)");
	});

	it("leaves a hole in the middle for the parser to refuse", () => {
		expect(formulaProblem(formulaFromArgs("IF", ["", "1", "0"]))).not.toBeNull();
	});
});

describe("formulaProblem", () => {
	it("is quiet about a formula the grid can evaluate", () => {
		expect(formulaProblem("SUM(B2:B4)")).toBeNull();
		expect(formulaProblem("IF(A1>1,\"yes\",\"no\")")).toBeNull();
		expect(formulaProblem("Table2!B3*2")).toBeNull();
	});

	it("says why one it cannot", () => {
		expect(formulaProblem("SUM(")).not.toBeNull();
		expect(formulaProblem("VLOOKUP(A1,B1:C2,1)")).not.toBeNull();
		expect(formulaProblem("SUM()")).not.toBeNull();
	});
});

describe("FORMULA_FUNCTIONS", () => {
	it("only offers what the parser accepts, filled in as the form starts", () => {
		for (const entry of FORMULA_FUNCTIONS) {
			const layout = argumentSlots(entry);
			const count = layout.slots.length + (layout.variadic ? layout.unit : 0);
			const args = Array.from({ length: count }, (_, index) => `A${index + 1}`);
			const expr = formulaFromArgs(entry.name, args);
			expect(formulaProblem(expr), `${entry.name}: ${expr}`).toBeNull();
		}
	});
});
