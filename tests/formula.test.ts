import { describe, expect, it } from "vitest";
import { createModel, getRaw, recomputeUsedRange, setRaw, type GridModel } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";
import {
	FORMULA_FUNCTIONS,
	adjustFormulaRefs,
	buildFormulaCell,
	computeColumn,
	editTextOf,
	isFormulaCell,
	parseFormulaCell,
	rawFromEdit,
	recalculate,
	stripFormula,
	toExcelFormula,
	totalsRow,
	translateFormula,
	withLayersOf,
} from "../src/feature/formula";

function grid(rows: string[][]): GridModel {
	const model = createModel();
	rows.forEach((row, r) => row.forEach((v, c) => setRaw(model, r, c, v)));
	recomputeUsedRange(model);
	return model;
}

const plain = { format: (v: number) => String(v) };

/** Sets a formula at `label`-style coordinates and recalculates; returns the cell's display. */
function evalAt(model: GridModel, row: number, col: number, expr: string): string {
	setRaw(model, row, col, buildFormulaCell("0", expr));
	recalculate(model, plain);
	return stripFormula(getRaw(model, row, col));
}

describe("formula cell format", () => {
	it("parses the display and the expression", () => {
		expect(parseFormulaCell("1 250 %%=SUM(B2:B3)%%")).toEqual({ display: "1 250", expr: "SUM(B2:B3)" });
		expect(parseFormulaCell("**1 250** %%=SUM(B2:B3)%%")).toEqual({ display: "**1 250**", expr: "SUM(B2:B3)" });
		expect(parseFormulaCell("%%=A1%%")).toEqual({ display: "", expr: "A1" });
		expect(parseFormulaCell("5%%= A1 + 1 %%  ")).toEqual({ display: "5", expr: "A1 + 1" });
	});

	it("rejects what is not exactly one trailing formula comment", () => {
		expect(parseFormulaCell("plain")).toBeNull();
		expect(parseFormulaCell("5 %%note%%")).toBeNull();
		expect(parseFormulaCell("%%=%%")).toBeNull();
		expect(parseFormulaCell("%%=A1%% tail")).toBeNull();
		// Obsidian would pair the first two markers, so the tail is visible text.
		expect(parseFormulaCell("a %% b %%=x%%")).toBeNull();
		// A balanced comment before the formula is fine.
		expect(parseFormulaCell("a %%c%% %%=x%%")).toEqual({ display: "a %%c%%", expr: "x" });
	});

	it("builds, strips and detects", () => {
		expect(buildFormulaCell("3", "A1+A2")).toBe("3 %%=A1+A2%%");
		expect(buildFormulaCell("", "A1")).toBe("%%=A1%%");
		expect(isFormulaCell("3 %%=A1%%")).toBe(true);
		expect(isFormulaCell("3")).toBe(false);
		expect(stripFormula("**3** %%=A1%%")).toBe("**3**");
		expect(stripFormula("text")).toBe("text");
	});

	it("survives a serialize/parse round trip of the table", () => {
		const md = "| A | B |\n| --- | --- |\n| 1 | 3 %%=A2*3%% |\n";
		const once = serializeTable(parseTable(md));
		expect(serializeTable(parseTable(once))).toBe(once);
		expect(getRaw(parseTable(once), 1, 1)).toBe("3 %%=A2*3%%");
	});
});

describe("editing", () => {
	it("shows the formula in the editor", () => {
		expect(editTextOf("3 %%=A1+A2%%")).toBe("=A1+A2");
		expect(editTextOf("**x**")).toBe("**x**");
	});

	it("turns =text into a formula with a placeholder display", () => {
		expect(rawFromEdit("", "=SUM(B2:B3)")).toBe("0 %%=SUM(B2:B3)%%");
		expect(rawFromEdit("", "  = A1 + 1 ")).toBe("0 %%=A1 + 1%%");
	});

	it("keeps the emphasis of the previous value", () => {
		expect(rawFromEdit("**12**", "=A1")).toBe("**0** %%=A1%%");
		expect(rawFromEdit("_**7**_ %%=B1%%", "=A1")).toBe("_**0**_ %%=A1%%");
		expect(rawFromEdit("`7`", "=A1")).toBe("`0` %%=A1%%");
	});

	it("leaves an unchanged formula alone so its value does not flash", () => {
		expect(rawFromEdit("**42** %%=A1*2%%", "=A1*2")).toBe("**42** %%=A1*2%%");
	});

	it("does not treat highlight, escaped or plain text as a formula", () => {
		expect(rawFromEdit("", "==highlight==")).toBe("==highlight==");
		expect(rawFromEdit("", "'=literal")).toBe("=literal");
		expect(rawFromEdit("3 %%=A1%%", "plain")).toBe("plain");
		expect(rawFromEdit("", "=")).toBe("=");
		expect(rawFromEdit("", "=a%%b")).toBe("=a%%b");
	});

	it("wraps in layers, code spans included", () => {
		expect(withLayersOf("~~**x**~~", "5")).toBe("~~**5**~~");
		expect(withLayersOf("plain", "5")).toBe("5");
		expect(withLayersOf("`x`", "a`b")).toBe("``a`b``");
	});
});

describe("expression language", () => {
	const model = (): GridModel =>
		grid([
			["Item", "Qty", "Price", "Note"],
			["a", "2", "1,5", "x"],
			["b", "3", "**2**", ""],
			["c", "", "10 %", "y"],
		]);

	it("does arithmetic with Excel precedence", () => {
		const m = model();
		expect(evalAt(m, 5, 0, "1 + 2 * 3")).toBe("7");
		expect(evalAt(m, 5, 0, "(1 + 2) * 3")).toBe("9");
		expect(evalAt(m, 5, 0, "2 ^ 3 ^ 2")).toBe("64");
		expect(evalAt(m, 5, 0, "-2 ^ 2")).toBe("4");
		expect(evalAt(m, 5, 0, "2 ^ -1")).toBe("0.5");
		expect(evalAt(m, 5, 0, "--3 - +1")).toBe("2");
		expect(evalAt(m, 5, 0, ".5 + 1e1")).toBe("10.5");
		expect(evalAt(m, 5, 0, "0.1 + 0.2")).toBe("0.3");
	});

	it("reads references with the cell's number parsing", () => {
		const m = model();
		expect(evalAt(m, 5, 0, "B2 * C2")).toBe("3");
		expect(evalAt(m, 5, 0, "b3 * c3")).toBe("6");
		expect(evalAt(m, 5, 0, "C4")).toBe("0.1");
		expect(evalAt(m, 5, 0, "$B$2 + B$3")).toBe("5");
		// An empty cell is zero in arithmetic.
		expect(evalAt(m, 5, 0, "B4 + 1")).toBe("1");
	});

	it("honours the decimal separator preference", () => {
		const m = grid([["A"], ["1.234,5"]]);
		setRaw(m, 2, 0, buildFormulaCell("", "A2*1"));
		recalculate(m, { format: String, numberOpts: { decimalSeparator: "," } });
		expect(stripFormula(getRaw(m, 2, 0))).toBe("1234.5");
		// Under a dot preference the same text is not a number at all.
		recalculate(m, { format: String, numberOpts: { decimalSeparator: "." } });
		expect(stripFormula(getRaw(m, 2, 0))).toBe("#VALUE!");
	});

	it("aggregates skip text and empties", () => {
		const m = model();
		expect(evalAt(m, 5, 0, "SUM(B2:B4)")).toBe("5");
		expect(evalAt(m, 5, 0, "sum(B2:C4)")).toBe("8.6");
		expect(evalAt(m, 5, 0, "AVERAGE(B2:B4)")).toBe("2.5");
		expect(evalAt(m, 5, 0, "AVG(B2:B4)")).toBe("2.5");
		expect(evalAt(m, 5, 0, "MIN(B2:C4)")).toBe("0.1");
		expect(evalAt(m, 5, 0, "MAX(B2:C4; 7)")).toBe("7");
		expect(evalAt(m, 5, 0, "COUNT(A2:D4)")).toBe("5");
		expect(evalAt(m, 5, 0, "COUNTA(A2:D4)")).toBe("10");
		expect(evalAt(m, 5, 0, "MEDIAN(B2:C4)")).toBe("2");
		expect(evalAt(m, 5, 0, "PRODUCT(B2:B4)")).toBe("6");
		expect(evalAt(m, 5, 0, "ROUND(2/3, 2)")).toBe("0.67");
		expect(evalAt(m, 5, 0, "ROUND(1.005, 2)")).toBe("1.01");
		expect(evalAt(m, 5, 0, "ROUND(-1250, -2)")).toBe("-1300");
		expect(evalAt(m, 5, 0, "ABS(-B2)")).toBe("2");
		expect(evalAt(m, 5, 0, "SUM(B2, D2)")).toBe("2");
		expect(evalAt(m, 5, 0, "SUM(B2:B100)")).toBe("5");
	});

	it("reports errors as codes", () => {
		const m = model();
		expect(evalAt(m, 5, 0, "1/0")).toBe("#DIV/0!");
		expect(evalAt(m, 5, 0, "A2 + 1")).toBe("#VALUE!");
		expect(evalAt(m, 5, 0, "SUM(A2 + 1)")).toBe("#VALUE!");
		expect(evalAt(m, 5, 0, "B2:B3 + 1")).toBe("#VALUE!");
		expect(evalAt(m, 5, 0, "1 +")).toBe("#ERROR!");
		expect(evalAt(m, 5, 0, "(1")).toBe("#ERROR!");
		expect(evalAt(m, 5, 0, "1 ? 2")).toBe("#ERROR!");
		expect(evalAt(m, 5, 0, "ROUND(1)")).toBe("#ERROR!");
		expect(evalAt(m, 5, 0, "FOO(1)")).toBe("#NAME?");
		expect(evalAt(m, 5, 0, "Qty * 2")).toBe("#NAME?");
		expect(evalAt(m, 5, 0, "SUM(#REF!)")).toBe("#REF!");
		expect(evalAt(m, 5, 0, "B0")).toBe("#REF!");
		expect(evalAt(m, 5, 0, "AVERAGE(D2:D4)")).toBe("#DIV/0!");
		expect(evalAt(m, 5, 0, "10 ^ 400")).toBe("#NUM!");
	});
});

describe("recalculate", () => {
	it("evaluates in dependency order, through other formulas", () => {
		const m = grid([["A", "B"], ["1", ""], ["2", ""]]);
		// B4 reads B3 which reads B2: written bottom-up on purpose.
		setRaw(m, 3, 1, buildFormulaCell("", "B3 * 10"));
		setRaw(m, 2, 1, buildFormulaCell("", "B2 + A3"));
		setRaw(m, 1, 1, buildFormulaCell("", "A2"));
		const result = recalculate(m, plain);
		expect(getRaw(m, 1, 1)).toBe("1 %%=A2%%");
		expect(getRaw(m, 2, 1)).toBe("3 %%=B2 + A3%%");
		expect(getRaw(m, 3, 1)).toBe("30 %%=B3 * 10%%");
		expect(result.changed).toHaveLength(3);
		expect(result.errors).toEqual([]);
	});

	it("includes formula cells inside a range", () => {
		const m = grid([["A"], ["1"], ["2"], ["%%=A2+A3%%"], ["%%=SUM(A2:A4)%%"]]);
		recalculate(m, plain);
		expect(stripFormula(getRaw(m, 4, 0))).toBe("6");
	});

	it("keeps the emphasis of the display and uses the format callback", () => {
		const m = grid([["A"], ["1234.5"], ["**0** %%=A2*2%%"]]);
		recalculate(m, { format: (v) => v.toFixed(1) });
		expect(getRaw(m, 2, 0)).toBe("**2469.0** %%=A2*2%%");
	});

	it("only writes cells whose text changes", () => {
		const m = grid([["A"], ["1"], ["2 %%=A2*2%%"]]);
		const result = recalculate(m, plain);
		expect(result.changed).toEqual([]);
		setRaw(m, 1, 0, "5");
		expect(recalculate(m, plain).changed).toEqual([{ row: 2, col: 0 }]);
		expect(getRaw(m, 2, 0)).toBe("10 %%=A2*2%%");
	});

	it("detects cycles, self references included, and what depends on them", () => {
		const m = grid([["A", "B", "C"], ["%%=B2%%", "%%=A2%%", "%%=A2+1%%"], ["%%=SUM(A2:A3)%%", "%%=1%%", ""]]);
		const result = recalculate(m, plain);
		expect(stripFormula(getRaw(m, 1, 0))).toBe("#CYCLE!");
		expect(stripFormula(getRaw(m, 1, 1))).toBe("#CYCLE!");
		expect(stripFormula(getRaw(m, 1, 2))).toBe("#CYCLE!");
		expect(stripFormula(getRaw(m, 2, 0))).toBe("#CYCLE!");
		expect(stripFormula(getRaw(m, 2, 1))).toBe("1");
		expect(result.errors.map((e) => e.code)).toEqual(["#CYCLE!", "#CYCLE!", "#CYCLE!", "#CYCLE!"]);
	});

	it("propagates an error from a referenced formula", () => {
		const m = grid([["A"], ["%%=1/0%%"], ["**x** %%=A2+1%%"], ["%%=COUNT(A2:A3)%%"], ["%%=COUNTA(A2:A3)%%"]]);
		const result = recalculate(m, plain);
		expect(getRaw(m, 2, 0)).toBe("**#DIV/0!** %%=A2+1%%");
		// COUNT and COUNTA look past errors, as in Excel.
		expect(stripFormula(getRaw(m, 3, 0))).toBe("0");
		expect(stripFormula(getRaw(m, 4, 0))).toBe("2");
		expect(result.errors[0]).toMatchObject({ row: 1, col: 0, code: "#DIV/0!" });
	});

	it("keeps the map sparse and the shape unchanged", () => {
		const m = grid([["A", "B"], ["1", "%%=A2%%"]]);
		const before = { ...m.usedRange };
		recalculate(m, plain);
		expect(m.usedRange).toEqual(before);
		for (const cell of m.cells.values()) expect(cell.raw.trim()).not.toBe("");
	});

	it("evaluates a long chain without recursion", () => {
		const rows: string[][] = [["A"], ["1"]];
		for (let r = 2; r < 3000; r++) rows.push([`%%=A${r}+1%%`]);
		const m = grid(rows);
		recalculate(m, plain);
		expect(stripFormula(getRaw(m, 2999, 0))).toBe("2999");
	});
});

describe("adjustFormulaRefs", () => {
	function exprAfter(expr: string, change: Parameters<typeof adjustFormulaRefs>[1]): string {
		const m = grid([["H"], [buildFormulaCell("0", expr)]]);
		adjustFormulaRefs(m, change);
		return parseFormulaCell(getRaw(m, 1, 0))?.expr ?? "";
	}

	it("shifts references at or after an inserted row", () => {
		// Model row 2 is label 3.
		expect(exprAfter("A2 + A3 + A4", { kind: "insertRows", at: 2, count: 1 })).toBe("A2 + A4 + A5");
		expect(exprAfter("$A$3*2", { kind: "insertRows", at: 2, count: 2 })).toBe("$A$5*2");
		// The header never moves.
		expect(exprAfter("A1", { kind: "insertRows", at: 0, count: 1 })).toBe("A1");
	});

	it("grows a range only when the insertion is strictly inside it", () => {
		expect(exprAfter("SUM(B2:B5)", { kind: "insertRows", at: 4, count: 1 })).toBe("SUM(B2:B6)");
		expect(exprAfter("SUM(B2:B5)", { kind: "insertRows", at: 1, count: 1 })).toBe("SUM(B3:B6)");
		expect(exprAfter("SUM(B2:B5)", { kind: "insertRows", at: 5, count: 1 })).toBe("SUM(B2:B5)");
	});

	it("turns references to deleted rows into #REF!", () => {
		expect(exprAfter("A3 + A5", { kind: "deleteRows", at: 2, count: 1 })).toBe("#REF! + A4");
		expect(exprAfter("SUM(A3:A4)*2", { kind: "deleteRows", at: 2, count: 2 })).toBe("SUM(#REF!)*2");
	});

	it("shrinks a range that loses part of itself", () => {
		expect(exprAfter("SUM(B2:B8)", { kind: "deleteRows", at: 3, count: 2 })).toBe("SUM(B2:B6)");
		expect(exprAfter("SUM(B3:B8)", { kind: "deleteRows", at: 1, count: 3 })).toBe("SUM(B2:B5)");
		expect(exprAfter("SUM(B2:B5)", { kind: "deleteRows", at: 3, count: 5 })).toBe("SUM(B2:B3)");
		// Endpoints written backwards keep their order and their `$`.
		expect(exprAfter("SUM(B$8:$B2)", { kind: "deleteRows", at: 3, count: 2 })).toBe("SUM(B$6:$B2)");
	});

	it("handles columns the same way", () => {
		expect(exprAfter("A2 + B2 + C2", { kind: "insertCols", at: 1, count: 1 })).toBe("A2 + C2 + D2");
		expect(exprAfter("SUM(A2:C2)", { kind: "insertCols", at: 1, count: 2 })).toBe("SUM(A2:E2)");
		expect(exprAfter("A2 + B2 + C2", { kind: "deleteCols", at: 1, count: 1 })).toBe("A2 + #REF! + B2");
		expect(exprAfter("SUM(A2:C2)", { kind: "deleteCols", at: 0, count: 1 })).toBe("SUM(A2:B2)");
		expect(exprAfter("SUM(B2:C2)", { kind: "deleteCols", at: 1, count: 2 })).toBe("SUM(#REF!)");
	});

	it("leaves the display and other text untouched, then recalculates to #REF!", () => {
		const m = grid([["A", "B"], ["5", "**5** %%=sum( A2 )%%"]]);
		adjustFormulaRefs(m, { kind: "deleteCols", at: 0, count: 1 });
		expect(getRaw(m, 1, 1)).toBe("**5** %%=sum( #REF! )%%");
		recalculate(m, plain);
		expect(getRaw(m, 1, 1)).toBe("**#REF!** %%=sum( #REF! )%%");
	});
});

describe("toExcelFormula", () => {
	it("normalises to Excel syntax", () => {
		expect(toExcelFormula("avg(b2:b3; 1)")).toBe("AVERAGE(B2:B3,1)");
		expect(toExcelFormula("ROUND( $a$1 / 3 , 2 )")).toBe("ROUND($A$1/3,2)");
		expect(toExcelFormula("SUM(#REF!)")).toBe("SUM(#REF!)");
	});

	it("refuses what does not parse", () => {
		expect(toExcelFormula("1 +")).toBeNull();
		expect(toExcelFormula("[Qty] * 2")).toBeNull();
	});
});

describe("totalsRow", () => {
	it("labels the first text column and sums the numeric ones", () => {
		const m = grid([
			["Item", "Qty", "Price", "Note"],
			["a", "2", "1,5", "x"],
			["b", "3", "2", "7"],
			["c", "", "n/a", ""],
		]);
		const row = totalsRow(m, { fn: "SUM", label: "**Total**" });
		expect(row).toBe(4);
		expect(getRaw(m, 4, 0)).toBe("**Total**");
		expect(getRaw(m, 4, 1)).toBe("0 %%=SUM(B2:B4)%%");
		expect(getRaw(m, 4, 2)).toBe("0 %%=SUM(C2:C4)%%");
		// Half numeric is not a majority.
		expect(getRaw(m, 4, 3)).toBe("");
		recalculate(m, plain);
		expect(stripFormula(getRaw(m, 4, 1))).toBe("5");
		expect(stripFormula(getRaw(m, 4, 2))).toBe("3.5");
		expect(m.usedRange.rows).toBe(5);
	});

	it("puts a formula in column A too when everything is numeric", () => {
		const m = grid([["X", "Y"], ["1", "2"], ["3", "4"]]);
		const row = totalsRow(m, { fn: "AVERAGE", label: "Avg" });
		expect(getRaw(m, row, 0)).toBe("0 %%=AVERAGE(A2:A3)%%");
		expect(getRaw(m, row, 1)).toBe("0 %%=AVERAGE(B2:B3)%%");
	});
});

describe("computeColumn", () => {
	it("writes literal values row by row from letters or header names", () => {
		const m = grid([
			["Item", "**Qty**", "Price", "Total"],
			["a", "2", "1,5", ""],
			["b", "3", "x", "**old**"],
			["", "", "", ""],
			["c", "4", "2", ""],
		]);
		const result = computeColumn(m, 3, "[qty] * [ Price ]", plain);
		expect(getRaw(m, 1, 3)).toBe("3");
		expect(getRaw(m, 2, 3)).toBe("**#VALUE!**");
		expect(getRaw(m, 3, 3)).toBe("");
		expect(getRaw(m, 4, 3)).toBe("8");
		expect(result).toEqual({ written: 3, errors: 1 });
		expect(isFormulaCell(getRaw(m, 1, 3))).toBe(false);

		computeColumn(m, 3, "=B * 10 + ROUND(C / 3, 1)", plain);
		expect(getRaw(m, 1, 3)).toBe("20.5");
	});

	it("can create a new column and reads formula displays", () => {
		const m = grid([["A", "B"], ["1", "4 %%=A2*4%%"]]);
		computeColumn(m, 2, "A + B", plain);
		expect(getRaw(m, 1, 2)).toBe("5");
		expect(m.usedRange.cols).toBe(3);
	});

	it("writes nothing for an expression that cannot work", () => {
		const m = grid([["A", "B"], ["1", "keep"]]);
		const bad = computeColumn(m, 1, "[Nope] * 2", plain);
		expect(bad.written).toBe(0);
		expect(bad.problem).toBeTruthy();
		expect(computeColumn(m, 1, "A *", plain).written).toBe(0);
		// A bare word past the last column is not a column letter.
		expect(computeColumn(m, 1, "Qty * 2", plain).written).toBe(0);
		expect(getRaw(m, 1, 1)).toBe("keep");
	});
});

describe("recalculate keeps a display that already has the right value", () => {
	it("does not rewrite a number formatted for another locale", () => {
		const m = parseTable("| A |\n| --- |\n| 1200 |\n| 1 200 %%=SUM(A2:A2)%% |\n");
		const result = recalculate(m, { format: (n) => n.toLocaleString("en-US") });
		expect(result.changed).toHaveLength(0);
		expect(getRaw(m, 2, 0)).toBe("1 200 %%=SUM(A2:A2)%%");
	});
});

describe("conditions", () => {
	const table = (): GridModel =>
		grid([
			["Item", "Kind", "Qty", "Price"],
			["Movers", "Moving", "2", "1200"],
			["Desks", "Furniture", "3", "6980"],
			["Chairs", "Furniture", "5", "640"],
			["Lamps", "Light", "4", "890"],
		]);
	const at = (expr: string, row = 6, col = 0): string => evalAt(table(), row, col, expr);

	it("takes the branch it should, and only that one", () => {
		expect(at('IF(C2>2,"many","few")')).toBe("few");
		expect(at('IF(C3>=3,"many","few")')).toBe("many");
		expect(at("IF(TRUE,5,1/0)")).toBe("5");
		expect(at("IF(FALSE,1/0,5)")).toBe("5");
		// Excel shows FALSE for a missing third argument; an empty cell reads better in a note.
		expect(at("IF(FALSE,5)")).toBe("");
	});

	it("compares text without case and numbers by value", () => {
		expect(at('IF(B2="moving","same","other")')).toBe("same");
		expect(at('IF(B2<>"Moving","other","same")')).toBe("same");
		expect(at("IF(C2=2,10,20)")).toBe("10");
		expect(at('IF(D3>1000,"dear","cheap")')).toBe("dear");
		// Text sorts after numbers, as in Excel.
		expect(at('IF("abc">5,"text wins","number wins")')).toBe("text wins");
	});

	it("joins text with &", () => {
		expect(at('A2 & " (" & C2 & " pcs)"')).toBe("Movers (2 pcs)");
		expect(at('IF(C2>1,"qty " & C2,"none")')).toBe("qty 2");
	});

	it("catches an error with IFERROR", () => {
		expect(at('IFERROR(1/0,"n/a")')).toBe("n/a");
		expect(at("IFERROR(C2*2,0)")).toBe("4");
		expect(at('IFERROR(SUM(D2:D5),"n/a")')).toBe("9710");
	});

	it("combines conditions with AND, OR and NOT", () => {
		expect(at('IF(AND(C2>1,D2>1000),"both","no")')).toBe("both");
		expect(at('IF(OR(C2>9,D2>1000),"either","no")')).toBe("either");
		expect(at('IF(NOT(B2="Furniture"),"not furniture","furniture")')).toBe("not furniture");
		expect(at("AND(TRUE,TRUE)")).toBe("TRUE");
		expect(at("OR(FALSE,FALSE)")).toBe("FALSE");
	});

	it("writes a text result as a plain cell that still reads without the plugin", () => {
		const m = table();
		setRaw(m, 6, 0, buildFormulaCell("0", 'IF(C2>2,"many","few")'));
		recalculate(m, plain);
		expect(getRaw(m, 6, 0)).toBe('few %%=IF(C2>2,"many","few")%%');
		expect(stripFormula(getRaw(m, 6, 0))).toBe("few");
		// A line break inside a result would break the row.
		expect(at('"a\nb"')).toBe("a b");
	});
});

describe("conditional aggregates", () => {
	const table = (): GridModel =>
		grid([
			["Item", "Kind", "Qty", "Price"],
			["Movers", "Moving", "2", "1200"],
			["Desks", "Furniture", "3", "6980"],
			["Chairs", "Furniture", "5", "640"],
			["Lamps", "Light", "4", "890"],
		]);
	const at = (expr: string, row = 6, col = 0): string => evalAt(table(), row, col, expr);

	it("sums by a text criterion", () => {
		expect(at('SUMIF(B2:B5,"Furniture",C2:C5)')).toBe("8");
		expect(at('SUMIF(B2:B5,"furniture",C2:C5)')).toBe("8");
		expect(at('SUMIF(B2:B5,"Nope",C2:C5)')).toBe("0");
	});

	it("sums by a comparison in the criterion", () => {
		expect(at('SUMIF(C2:C5,">2")')).toBe("12");
		expect(at('SUMIF(C2:C5,"<=2",D2:D5)')).toBe("1200");
		expect(at('SUMIF(D2:D5,"<>640")')).toBe("9070");
	});

	it("counts, including wildcards and empty cells", () => {
		expect(at('COUNTIF(B2:B5,"Furniture")')).toBe("2");
		expect(at('COUNTIF(A2:A5,"*esk*")')).toBe("1");
		expect(at('COUNTIF(A2:A5,"*airs")')).toBe("1");
		expect(at('COUNTIF(B2:B5,"")')).toBe("0");
		expect(at('COUNTIF(B2:B5,"<>")')).toBe("4");
	});

	it("averages the matches", () => {
		expect(at('AVERAGEIF(B2:B5,"Furniture",C2:C5)')).toBe("4");
		expect(at('AVERAGEIF(B2:B5,"Nope",C2:C5)')).toBe("#DIV/0!");
	});

	it("handles several criteria", () => {
		expect(at('SUMIFS(C2:C5,B2:B5,"Furniture",C2:C5,">3")')).toBe("5");
		expect(at('COUNTIFS(B2:B5,"Furniture",D2:D5,"<1000")')).toBe("1");
		expect(at('AVERAGEIFS(D2:D5,B2:B5,"Furniture")')).toBe("3810");
		// Too few arguments for one value range plus one pair.
		expect(at('SUMIFS(C2:C5,B2:B5)')).toBe("#ERROR!");
	});
});

describe("new functions in the other paths", () => {
	it("exports to Excel syntax with its own separators", () => {
		expect(toExcelFormula('IF(A2>3,"yes","no")')).toBe('IF(A2>3,"yes","no")');
		expect(toExcelFormula("AVG(A2:A5)")).toBe("AVERAGE(A2:A5)");
		expect(toExcelFormula("SUM(A2:A3;B2:B3)")).toBe("SUM(A2:A3,B2:B3)");
	});

	it("leaves a reference inside a string alone when rows move", () => {
		const m = grid([["A", "B"], ["1", ""]]);
		setRaw(m, 1, 1, buildFormulaCell("", '"B2" & B2'));
		adjustFormulaRefs(m, { kind: "insertRows", at: 1, count: 2 });
		// The expression moves; the cell itself is moved by the row operation, not here.
		expect(parseFormulaCell(getRaw(m, 1, 1))?.expr).toBe('"B2" & B4');
	});

	it("computes a column that returns text", () => {
		const m = grid([
			["Item", "Qty"],
			["Movers", "2"],
			["Desks", "3"],
		]);
		const result = computeColumn(m, 2, 'A & " x" & B', plain);
		expect(result.written).toBe(2);
		expect(getRaw(m, 1, 2)).toBe("Movers x2");
	});

	it("reports the reason an error happened", () => {
		const m = grid([["A", "B"], ["text", ""], ["", ""]]);
		setRaw(m, 1, 1, buildFormulaCell("0", 'IF(A2="x",1,2)'));
		setRaw(m, 2, 1, buildFormulaCell("0", "A2+1"));
		const result = recalculate(m, plain);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({ row: 2, col: 1, code: "#VALUE!" });
		expect(result.errors[0].message).toContain("number");
	});
});

describe("translateFormula", () => {
	it("moves relative references and leaves anchored ones", () => {
		expect(translateFormula("A2+B2", 1, 0)).toBe("A3+B3");
		expect(translateFormula("$A$2+B2", 1, 1)).toBe("$A$2+C3");
		expect(translateFormula("$A2+A$2", 1, 1)).toBe("$A3+B$2");
		expect(translateFormula("SUM(B2:C2)", 2, 0)).toBe("SUM(B4:C4)");
	});

	it("keeps text, functions and separators exactly as written", () => {
		expect(translateFormula('IF(B2>1,"B2 is big",AVG(B2:C2))', 1, 0)).toBe('IF(B3>1,"B2 is big",AVG(B3:C3))');
	});

	it("turns a reference that would leave the sheet into #REF!", () => {
		expect(translateFormula("A2+B10", -5, 0)).toBe("#REF!+B5");
	});

	it("moves what it can and comes back null only when the text is not tokenizable", () => {
		// A half-typed formula has no meaning yet; its references still move.
		expect(translateFormula("A2+", 1, 0)).toBe("A3+");
		expect(translateFormula('A2+"x', 1, 0)).toBeNull();
	});
});

describe("function suggestions", () => {
	it("offers only names the parser knows", () => {
		const m = grid([["A"], ["1"]]);
		for (const doc of FORMULA_FUNCTIONS) {
			// Arity may be wrong for a bare call; an unknown name is the failure this guards.
			expect(evalAt(m, 3, 0, `${doc.name}()`), doc.name).not.toBe("#NAME?");
		}
	});

	it("has a signature and a description for every entry", () => {
		for (const doc of FORMULA_FUNCTIONS) {
			expect(doc.summary.trim(), doc.name).not.toBe("");
			// A constant takes no arguments; everything else has at least one.
			expect(doc.signature === "" || /^[a-zA-Z]/.test(doc.signature), doc.name).toBe(true);
		}
	});

	it("leads with the functions a table actually uses", () => {
		expect(FORMULA_FUNCTIONS.slice(0, 3).map((f) => f.name)).toEqual(["SUM", "IF", "AVERAGE"]);
	});
});
