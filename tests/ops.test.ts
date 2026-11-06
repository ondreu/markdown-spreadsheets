import { parseFormulaCell } from "../src/feature/formula";
import { describe, expect, it } from "vitest";
import { getRaw, setRaw } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";
import {
	addInlineFormat,
	applyInlineFormat,
	clearRange,
	compareCells,
	deleteCols,
	deleteRows,
	fillRange,
	findAll,
	inlineFormatsOf,
	insertCols,
	insertRows,
	moveCol,
	moveRow,
	readRange,
	removeInlineFormat,
	replaceAll,
	setColAlign,
	sortRows,
	writeRange,
} from "../src/feature/ops";
import type { TableLayout } from "../src/store/Sidecar";

function layout(over: Partial<TableLayout> = {}): TableLayout {
	return Object.assign(
		{ colWidths: [], rowHeights: {}, wrapCols: [], frozenRows: 1, frozenCols: 0, decimals: 2 },
		over,
	);
}

const TABLE = "| A | B | C |\n| --- | :--- | ---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |\n";

describe("insertRows", () => {
	it("shifts the cells below the insertion point", () => {
		const model = parseTable(TABLE);
		const l = layout();
		insertRows(model, l, 2, 1);
		expect(getRaw(model, 1, 0)).toBe("1");
		expect(getRaw(model, 2, 0)).toBe("");
		expect(getRaw(model, 3, 0)).toBe("4");
		expect(model.usedRange.rows).toBe(5);
	});

	it("reindexes the sparse row heights (§8.4)", () => {
		const model = parseTable(TABLE);
		const l = layout({ rowHeights: { "1": 40, "3": 60 } });
		insertRows(model, l, 2, 2);
		expect(l.rowHeights).toEqual({ "1": 40, "5": 60 });
	});

	it("never pushes the header row down", () => {
		const model = parseTable(TABLE);
		const l = layout();
		insertRows(model, l, 0, 1);
		expect(getRaw(model, 0, 0)).toBe("A");
	});
});

describe("hidden columns follow structural changes (§8.4)", () => {
	it("shift on insert, drop and close up on delete, travel with a move", () => {
		const model = parseTable(TABLE);
		const l = layout({ hiddenCols: [1, 2] });
		insertCols(model, l, 1, 1);
		expect(l.hiddenCols).toEqual([2, 3]);
		deleteCols(model, l, [2]);
		expect(l.hiddenCols).toEqual([2]);
		moveCol(model, l, 2, 0);
		expect(l.hiddenCols).toEqual([0]);
	});
});

describe("deleteRows", () => {
	it("closes the gap", () => {
		const model = parseTable(TABLE);
		const l = layout();
		deleteRows(model, l, [2]);
		expect(getRaw(model, 1, 0)).toBe("1");
		expect(getRaw(model, 2, 0)).toBe("7");
		expect(model.usedRange.rows).toBe(3);
	});

	it("reindexes the row heights", () => {
		const model = parseTable(TABLE);
		const l = layout({ rowHeights: { "1": 40, "2": 50, "3": 60 } });
		deleteRows(model, l, [2]);
		expect(l.rowHeights).toEqual({ "1": 40, "2": 60 });
	});

	it("refuses to delete the header row", () => {
		const model = parseTable(TABLE);
		const l = layout();
		expect(deleteRows(model, l, [0])).toBe(0);
		expect(getRaw(model, 0, 0)).toBe("A");
	});

	it("handles a non-contiguous set", () => {
		const model = parseTable(TABLE);
		const l = layout({ rowHeights: { "1": 10, "2": 20, "3": 30 } });
		deleteRows(model, l, [1, 3]);
		expect(getRaw(model, 1, 0)).toBe("4");
		expect(l.rowHeights).toEqual({ "1": 20 });
	});
});

describe("insertCols", () => {
	it("shifts cells, alignment, widths and wrap flags together", () => {
		const model = parseTable(TABLE);
		const l = layout({ colWidths: [100, 200, 300], wrapCols: [1, 2] });
		insertCols(model, l, 1, 1);
		expect(getRaw(model, 0, 0)).toBe("A");
		expect(getRaw(model, 0, 1)).toBe("");
		expect(getRaw(model, 0, 2)).toBe("B");
		expect(model.colAlign).toEqual([null, null, "left", "right"]);
		expect(l.colWidths).toEqual([100, 0, 200, 300]);
		expect(l.wrapCols).toEqual([2, 3]);
	});
});

describe("deleteCols", () => {
	it("removes the column from every parallel array (§8.4)", () => {
		const model = parseTable(TABLE);
		const l = layout({ colWidths: [100, 200, 300], wrapCols: [0, 2] });
		deleteCols(model, l, [1]);
		expect(getRaw(model, 0, 1)).toBe("C");
		expect(model.colAlign).toEqual([null, "right"]);
		expect(l.colWidths).toEqual([100, 300]);
		expect(l.wrapCols).toEqual([0, 1]);
		expect(model.usedRange.cols).toBe(2);
	});

	it("clamps the frozen column count", () => {
		const model = parseTable(TABLE);
		const l = layout({ frozenCols: 2 });
		deleteCols(model, l, [0]);
		expect(l.frozenCols).toBe(1);
	});

	it("keeps sizes aligned across a delete then insert", () => {
		const model = parseTable(TABLE);
		const l = layout({ colWidths: [111, 222, 333] });
		deleteCols(model, l, [0]);
		insertCols(model, l, 0, 1);
		// The surviving widths must still sit under their own columns.
		expect(l.colWidths[1]).toBe(222);
		expect(l.colWidths[2]).toBe(333);
	});
});

describe("moveRow / moveCol", () => {
	it("moves a row down and carries its height", () => {
		const model = parseTable(TABLE);
		const l = layout({ rowHeights: { "1": 44 } });
		moveRow(model, l, 1, 3);
		expect(getRaw(model, 1, 0)).toBe("4");
		expect(getRaw(model, 2, 0)).toBe("1");
		expect(l.rowHeights["2"]).toBe(44);
	});

	it("moves a column and carries its alignment and width", () => {
		const model = parseTable(TABLE);
		const l = layout({ colWidths: [100, 200, 300] });
		moveCol(model, l, 2, 0);
		expect(getRaw(model, 0, 0)).toBe("C");
		expect(model.colAlign[0]).toBe("right");
		expect(l.colWidths[0]).toBe(300);
	});
});

describe("readRange / writeRange / clearRange", () => {
	it("reads a rectangle in order", () => {
		const model = parseTable(TABLE);
		expect(readRange(model, { r1: 1, c1: 0, r2: 2, c2: 1 })).toEqual([
			["1", "2"],
			["4", "5"],
		]);
	});

	it("writes a rectangle and grows the used range", () => {
		const model = parseTable(TABLE);
		writeRange(model, 4, 3, [["x", "y"]]);
		expect(getRaw(model, 4, 4)).toBe("y");
		expect(model.usedRange).toEqual({ rows: 5, cols: 5 });
	});

	it("clears a rectangle back to sparse", () => {
		const model = parseTable(TABLE);
		clearRange(model, { r1: 1, c1: 0, r2: 3, c2: 2 });
		expect(model.cells.size).toBe(3);
		expect(model.usedRange.rows).toBe(1);
	});
});

describe("applyInlineFormat", () => {
	it("wraps and then unwraps", () => {
		const model = parseTable(TABLE);
		const rect = { r1: 1, c1: 0, r2: 1, c2: 0 };
		applyInlineFormat(model, rect, "bold");
		expect(getRaw(model, 1, 0)).toBe("**1**");
		applyInlineFormat(model, rect, "bold");
		expect(getRaw(model, 1, 0)).toBe("1");
	});

	it("skips empty cells", () => {
		const model = parseTable("| A |\n| --- |\n|  |\n");
		applyInlineFormat(model, { r1: 1, c1: 0, r2: 1, c2: 0 }, "bold");
		expect(getRaw(model, 1, 0)).toBe("");
	});

	it("recognises underscore italic, so the toggle removes it instead of nesting", () => {
		const model = parseTable("| A |\n| --- |\n| _kurzíva_ |\n");
		applyInlineFormat(model, { r1: 1, c1: 0, r2: 1, c2: 0 }, "italic");
		expect(getRaw(model, 1, 0)).toBe("kurzíva");
	});

	it("does not turn bold into italic", () => {
		const model = parseTable("| A |\n| --- |\n| **x** |\n");
		applyInlineFormat(model, { r1: 1, c1: 0, r2: 1, c2: 0 }, "italic");
		expect(getRaw(model, 1, 0)).toBe("***x***");
		applyInlineFormat(model, { r1: 1, c1: 0, r2: 1, c2: 0 }, "italic");
		expect(getRaw(model, 1, 0)).toBe("**x**");
	});

	it("removes only the layer asked for", () => {
		expect(removeInlineFormat("***x***", "bold")).toBe("*x*");
		expect(removeInlineFormat("_**x**_", "italic")).toBe("**x**");
		expect(removeInlineFormat("__x__", "bold")).toBe("x");
		expect(removeInlineFormat("~~**x**~~", "strikethrough")).toBe("**x**");
		expect(removeInlineFormat("**`x`**", "code")).toBe("**x**");
	});

	it("does not mistake two spans for one", () => {
		expect(inlineFormatsOf("*a* and *b*").size).toBe(0);
		expect(inlineFormatsOf("**a** and **b**").size).toBe(0);
		// Toggling must not delete characters from the middle of the cell.
		expect(addInlineFormat("*a* and *b*", "italic")).toBe("_*a* and *b*_");
	});

	it("reads nested and intraword forms", () => {
		expect([...inlineFormatsOf("***x***")].sort()).toEqual(["bold", "italic"]);
		expect([...inlineFormatsOf("_snake_case_")]).toEqual(["italic"]);
		expect([...inlineFormatsOf("*a **b** c*")]).toEqual(["italic"]);
		expect([...inlineFormatsOf("`a*b*`")]).toEqual(["code"]);
		expect([...inlineFormatsOf("``a`b``")]).toEqual(["code"]);
		expect(inlineFormatsOf("snake_case").size).toBe(0);
	});

	it("puts code innermost and fences around backticks", () => {
		expect(addInlineFormat("**x**", "code")).toBe("**`x`**");
		expect(addInlineFormat("a`b", "code")).toBe("``a`b``");
		expect(addInlineFormat("`x", "code")).toBe("`` `x ``");
	});

	it("round-trips every format on a plain cell", () => {
		for (const format of ["bold", "italic", "code", "strikethrough"] as const) {
			expect(removeInlineFormat(addInlineFormat("hello world", format), format)).toBe("hello world");
		}
	});
});

describe("fillRange", () => {
	it("continues a numeric series downwards", () => {
		const model = parseTable("| A |\n| --- |\n| 1 |\n| 2 |\n");
		fillRange(model, { r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 5, c2: 0 }, "down");
		expect(getRaw(model, 3, 0)).toBe("3");
		expect(getRaw(model, 5, 0)).toBe("5");
	});

	it("respects a step other than one", () => {
		const model = parseTable("| A |\n| --- |\n| 10 |\n| 20 |\n");
		fillRange(model, { r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 4, c2: 0 }, "down");
		expect(getRaw(model, 3, 0)).toBe("30");
		expect(getRaw(model, 4, 0)).toBe("40");
	});

	it("copies a single cell rather than counting", () => {
		const model = parseTable("| A |\n| --- |\n| 7 |\n");
		fillRange(model, { r1: 1, c1: 0, r2: 1, c2: 0 }, { r1: 1, c1: 0, r2: 3, c2: 0 }, "down");
		expect(getRaw(model, 2, 0)).toBe("7");
		expect(getRaw(model, 3, 0)).toBe("7");
	});

	it("moves a formula's relative references, keeping anchored ones", () => {
		const model = parseTable("| A | B | C |\n| --- | --- | --- |\n| 1 | 10 | %%=$B$1+A2%% |\n| 2 | 20 | |\n| 3 | 30 | |\n");
		fillRange(model, { r1: 1, c1: 2, r2: 1, c2: 2 }, { r1: 1, c1: 2, r2: 3, c2: 2 }, "down");
		expect(parseFormulaCell(getRaw(model, 2, 2))?.expr).toBe("$B$1+A3");
		expect(parseFormulaCell(getRaw(model, 3, 2))?.expr).toBe("$B$1+A4");
	});

	it("repeats a text pattern", () => {
		const model = parseTable("| A |\n| --- |\n| x |\n| y |\n");
		fillRange(model, { r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 5, c2: 0 }, "down");
		expect(getRaw(model, 3, 0)).toBe("x");
		expect(getRaw(model, 4, 0)).toBe("y");
		expect(getRaw(model, 5, 0)).toBe("x");
	});

	it("fills to the right", () => {
		const model = parseTable("| 1 | 2 |\n| --- | --- |\n");
		fillRange(model, { r1: 0, c1: 0, r2: 0, c2: 1 }, { r1: 0, c1: 0, r2: 0, c2: 3 }, "right");
		expect(getRaw(model, 0, 2)).toBe("3");
		expect(getRaw(model, 0, 3)).toBe("4");
	});
});

describe("sortRows", () => {
	it("leaves the header in place", () => {
		const model = parseTable("| Name | Qty |\n| --- | --- |\n| b | 2 |\n| a | 1 |\n");
		const l = layout();
		sortRows(model, l, { col: 0, ascending: true });
		expect(getRaw(model, 0, 0)).toBe("Name");
		expect(getRaw(model, 1, 0)).toBe("a");
		expect(getRaw(model, 2, 0)).toBe("b");
	});

	it("sorts numerically, not lexicographically", () => {
		const model = parseTable("| N |\n| --- |\n| 10 |\n| 9 |\n| 100 |\n");
		sortRows(model, layout(), { col: 0, ascending: true });
		expect([getRaw(model, 1, 0), getRaw(model, 2, 0), getRaw(model, 3, 0)]).toEqual(["9", "10", "100"]);
	});

	it("moves the whole row, not just the sort column", () => {
		const model = parseTable("| N | Tag |\n| --- | --- |\n| 2 | two |\n| 1 | one |\n");
		sortRows(model, layout(), { col: 0, ascending: true });
		expect(getRaw(model, 1, 1)).toBe("one");
	});

	it("carries the row heights along", () => {
		const model = parseTable("| N |\n| --- |\n| 2 |\n| 1 |\n");
		const l = layout({ rowHeights: { "1": 50 } });
		sortRows(model, l, { col: 0, ascending: true });
		expect(l.rowHeights).toEqual({ "2": 50 });
	});

	it("restricts itself to the given rows", () => {
		const model = parseTable("| N |\n| --- |\n| 3 |\n| 2 |\n| 1 |\n");
		sortRows(model, layout(), { col: 0, ascending: true, rows: [1, 2] });
		expect([getRaw(model, 1, 0), getRaw(model, 2, 0), getRaw(model, 3, 0)]).toEqual(["2", "3", "1"]);
	});
});

describe("compareCells", () => {
	it("sorts numbers before text and empties last", () => {
		const values = ["b", "", "10", "a", "2"];
		expect(values.slice().sort((x, y) => compareCells(x, y))).toEqual(["2", "10", "a", "b", ""]);
	});
});

describe("find and replace", () => {
	const table = "| Name |\n| --- |\n| Alpha |\n| alpha |\n| Beta |\n";

	it("finds case-insensitively by default", () => {
		expect(findAll(parseTable(table), { query: "alpha", matchCase: false, wholeCell: false, regex: false })).toHaveLength(2);
	});

	it("honours match case", () => {
		expect(findAll(parseTable(table), { query: "alpha", matchCase: true, wholeCell: false, regex: false })).toHaveLength(1);
	});

	it("replaces only the matching part", () => {
		const model = parseTable(table);
		replaceAll(model, { query: "al", matchCase: false, wholeCell: false, regex: false }, "AL");
		expect(getRaw(model, 2, 0)).toBe("ALpha");
	});

	it("replaces the whole cell when asked", () => {
		const model = parseTable(table);
		replaceAll(model, { query: "alpha", matchCase: false, wholeCell: true, regex: false }, "X");
		expect(getRaw(model, 1, 0)).toBe("X");
		expect(getRaw(model, 2, 0)).toBe("X");
	});

	it("supports regular expressions", () => {
		const model = parseTable("| A |\n| --- |\n| a1b2 |\n");
		replaceAll(model, { query: "\\d", matchCase: false, wholeCell: false, regex: true }, "#");
		expect(getRaw(model, 1, 0)).toBe("a#b#");
	});

	it("treats a literal query as literal, brackets included", () => {
		const model = parseTable("| A |\n| --- |\n| a[b] |\n");
		replaceAll(model, { query: "[b]", matchCase: false, wholeCell: false, regex: false }, "X");
		expect(getRaw(model, 1, 0)).toBe("aX");
	});

	it("ignores an invalid regex instead of throwing", () => {
		expect(findAll(parseTable(table), { query: "(", matchCase: false, wholeCell: false, regex: true })).toHaveLength(0);
	});
});

describe("setColAlign", () => {
	it("survives a serialize round trip", () => {
		const model = parseTable(TABLE);
		setColAlign(model, [0], "center");
		expect(serializeTable(model).split("\n")[1]).toContain(":-");
		expect(parseTable(serializeTable(model)).colAlign[0]).toBe("center");
	});
});

describe("empty writes stay sparse", () => {
	it("clears the map entry instead of storing whitespace", () => {
		const model = parseTable(TABLE);
		setRaw(model, 1, 0, "   ");
		expect(model.cells.has("1:0")).toBe(false);
	});
});

describe("formatting a cell that carries a conditional rule", () => {
	const raw = "1 200 %%cf B2:B9 > 1000 bold%% %%=SUM(B2:B4)%%";

	it("keeps the rule when the display is emphasised", () => {
		// The rule is written into the first cell of its range, which is often the cell holding the
		// formula the rule tests: pressing Ctrl+I there must not take the rule out of the note.
		expect(addInlineFormat(raw, "italic")).toBe("*1 200* %%cf B2:B9 > 1000 bold%% %%=SUM(B2:B4)%%");
	});

	it("keeps the rule when the emphasis comes off again", () => {
		expect(removeInlineFormat(addInlineFormat(raw, "italic"), "italic")).toBe(raw);
	});

	it("still puts the formula last, so the cell is still a formula", () => {
		expect(parseFormulaCell(addInlineFormat(raw, "bold"))?.expr).toBe("SUM(B2:B4)");
	});
});
