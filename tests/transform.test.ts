import { describe, expect, it } from "vitest";
import { getRaw, type GridModel } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";
import { colName } from "../src/model/address";
import {
	applyTextTransform,
	columnStats,
	distinctColumnValues,
	duplicateCols,
	duplicateHeaders,
	duplicateRows,
	formatNumbers,
	matchesFilter,
	mergeColumns,
	raggedRows,
	removeDuplicateRows,
	rowMatches,
	sortRowsMulti,
	textToColumns,
	transformText,
	transpose,
	type ColumnFilter,
} from "../src/feature/transform";
import { toHtmlTable, toJson } from "../src/feature/exportExtra";
import type { TableLayout } from "../src/store/Sidecar";

function layout(over: Partial<TableLayout> = {}): TableLayout {
	return Object.assign({ colWidths: [], rowHeights: {}, wrapCols: [], frozenRows: 1, frozenCols: 0, decimals: 2 }, over);
}

function grid(model: GridModel): string[][] {
	const out: string[][] = [];
	for (let r = 0; r < model.usedRange.rows; r++) {
		const row: string[] = [];
		for (let c = 0; c < model.usedRange.cols; c++) row.push(getRaw(model, r, c));
		out.push(row);
	}
	return out;
}

function expectSparse(model: GridModel): void {
	for (const cell of model.cells.values()) expect(cell.raw.trim()).not.toBe("");
}

describe("textToColumns", () => {
	it("splits the header and data into new columns and reindexes the layout", () => {
		const model = parseTable("| Name, Surname | Age |\n| --- | :-: |\n| Jan, Novák | 30 |\n| Eva | 25 |\n");
		const l = layout({ colWidths: [100, 60], wrapCols: [1] });
		expect(textToColumns(model, l, 0, ",")).toBe(1);
		expect(grid(model)).toEqual([
			["Name", "Surname", "Age"],
			["Jan", "Novák", "30"],
			["Eva", "", "25"],
		]);
		expect(model.colAlign).toEqual([null, null, "center"]);
		expect(l.colWidths).toEqual([100, 0, 60]);
		expect(l.wrapCols).toEqual([2]);
		expectSparse(model);
	});

	it("adds as many columns as the longest split needs", () => {
		const model = parseTable("| A |\n| --- |\n| a;b;c |\n| d;e |\n");
		expect(textToColumns(model, layout(), 0, ";")).toBe(2);
		expect(grid(model)[1]).toEqual(["a", "b", "c"]);
		expect(grid(model)[2]).toEqual(["d", "e", ""]);
	});

	it("is a no-op without the delimiter", () => {
		const model = parseTable("| A | B |\n| --- | --- |\n| a | b |\n");
		expect(textToColumns(model, layout(), 0, ";")).toBe(0);
		expect(model.usedRange.cols).toBe(2);
	});
});

describe("mergeColumns", () => {
	it("joins non-empty values into the first column and deletes the others", () => {
		const model = parseTable("| First | Mid | Last | X |\n| --- | --- | --- | --- |\n| Jan |  | Novák | 1 |\n|  |  |  | 2 |\n");
		const l = layout({ colWidths: [10, 20, 30, 40], wrapCols: [3] });
		mergeColumns(model, l, [2, 0, 1], " ");
		expect(grid(model)).toEqual([
			["First Mid Last", "X"],
			["Jan Novák", "1"],
			["", "2"],
		]);
		expect(l.colWidths).toEqual([10, 40]);
		expect(l.wrapCols).toEqual([1]);
		expectSparse(model);
	});
});

describe("removeDuplicateRows", () => {
	it("keeps the first occurrence across all columns", () => {
		const model = parseTable("| A | B |\n| --- | --- |\n| 1 | x |\n| 1 | y |\n| 1 | x |\n");
		const l = layout({ rowHeights: { "2": 40, "3": 50 } });
		expect(removeDuplicateRows(model, l)).toBe(1);
		expect(grid(model)).toEqual([
			["A", "B"],
			["1", "x"],
			["1", "y"],
		]);
		expect(l.rowHeights).toEqual({ "2": 40 });
	});

	it("keys on the given columns and never touches the header", () => {
		const model = parseTable("| A | B |\n| --- | --- |\n| A | x |\n| A | y |\n");
		expect(removeDuplicateRows(model, layout(), [0])).toBe(1);
		expect(grid(model)).toEqual([
			["A", "B"],
			["A", "x"],
		]);
	});
});

describe("sortRowsMulti", () => {
	const table = "| Dept | Name | Pay |\n| --- | --- | --- |\n| B | Eva | 10 |\n| A | Jan | 5 |\n| B | Adam | 20 |\n| A | Iva | 5 |\n";

	it("sorts by several keys, stably, with the header in place", () => {
		const model = parseTable(table);
		const l = layout({ rowHeights: { "1": 33 } });
		sortRowsMulti(model, l, [
			{ col: 0, ascending: true },
			{ col: 2, ascending: false },
		], undefined);
		expect(grid(model).map((r) => r[1])).toEqual(["Name", "Jan", "Iva", "Adam", "Eva"]);
		// Eva's row carried its height from row 1 to row 4.
		expect(l.rowHeights).toEqual({ "4": 33 });
	});

	it("restricts to the given rows and ignores row 0", () => {
		const model = parseTable(table);
		sortRowsMulti(model, layout(), [{ col: 1, ascending: true }], [0, 1, 2]);
		expect(grid(model).map((r) => r[1])).toEqual(["Name", "Eva", "Jan", "Adam", "Iva"]);
		sortRowsMulti(model, layout(), [{ col: 1, ascending: true }], [1, 3]);
		expect(grid(model).map((r) => r[1])).toEqual(["Name", "Adam", "Jan", "Eva", "Iva"]);
	});
});

describe("transpose", () => {
	it("swaps rows and columns, padding ragged input", () => {
		expect(transpose([["a", "b", "c"], ["d"]])).toEqual([
			["a", "d"],
			["b", ""],
			["c", ""],
		]);
		expect(transpose([])).toEqual([]);
	});
});

describe("transformText", () => {
	it("changes case without touching link targets, code or comments", () => {
		const raw = "see [[Target Note]] and `Code` %%Hidden%% [Text](https://Example.com/Path)";
		expect(transformText(raw, "upper")).toBe("SEE [[Target Note]] AND `Code` %%Hidden%% [TEXT](https://Example.com/Path)");
		expect(transformText(raw, "lower")).toBe("see [[Target Note]] and `Code` %%Hidden%% [text](https://Example.com/Path)");
	});

	it("transforms a wikilink alias but not its target", () => {
		expect(transformText("[[Some Page|my alias]]", "upper")).toBe("[[Some Page|MY ALIAS]]");
		expect(transformText("[[some page|my alias]] here", "sentence")).toBe("[[some page|My alias]] here");
	});

	it("leaves entities and bare URLs alone", () => {
		expect(transformText("a&nbsp;b https://x.org/Abc", "upper")).toBe("A&nbsp;B https://x.org/Abc");
	});

	it("title-cases words across emphasis", () => {
		expect(transformText("**hello wORLD** it's o'neil", "title")).toBe("**Hello World** It's O'neil");
	});

	it("sentence-cases each sentence", () => {
		expect(transformText("HELLO THERE. how ARE you? 3.5 KG", "sentence")).toBe("Hello there. How are you? 3.5 kg");
	});

	it("trims and collapses whitespace", () => {
		expect(transformText("  a   b \t c  ", "trim")).toBe("a b c");
	});

	it("replaces non-breaking spaces outside code", () => {
		expect(transformText("1&nbsp;000 Kč&#160;x `&nbsp;`", "nbsp")).toBe("1 000 Kč x `&nbsp;`");
	});
});

describe("applyTextTransform", () => {
	it("counts changed cells and keeps the map sparse", () => {
		const model = parseTable("| h |\n| --- |\n| abc |\n| ABC |\n| &nbsp; |\n");
		expect(applyTextTransform(model, { r1: 1, c1: 0, r2: 3, c2: 0 }, "upper")).toBe(1);
		expect(getRaw(model, 0, 0)).toBe("h");
		expect(applyTextTransform(model, { r1: 3, c1: 0, r2: 1, c2: 0 }, "nbsp")).toBe(1);
		expect(getRaw(model, 3, 0)).toBe("");
		expectSparse(model);
	});
});

describe("columnStats and distinctColumnValues", () => {
	const table = "| V |\n| --- |\n| 10 |\n| b |\n|  |\n| 10 |\n| 2,5 |\n| a |\n";

	it("profiles data rows only", () => {
		const stats = columnStats(parseTable(table), 0);
		expect(stats).toEqual({
			filled: 5,
			empty: 1,
			distinct: 4,
			numeric: 3,
			sum: 22.5,
			min: 2.5,
			max: 10,
			average: 7.5,
			mostCommon: { value: "10", count: 2 },
		});
	});

	it("handles an empty column", () => {
		const stats = columnStats(parseTable("| V | W |\n| --- | --- |\n|  | x |\n"), 0);
		expect(stats.average).toBeNull();
		expect(stats.min).toBeNull();
		expect(stats.mostCommon).toBeNull();
		expect(stats.empty).toBe(1);
	});

	it("orders distinct values by frequency, then alphabetically", () => {
		const model = parseTable(table);
		expect(distinctColumnValues(model, 0)).toEqual(["10", "2,5", "a", "b"]);
		// Without row 1 every value occurs once, so numeric-aware alphabetical order decides.
		expect(distinctColumnValues(model, 0, 1)).toEqual(["2,5", "10", "a", "b"]);
		expect(distinctColumnValues(parseTable("| V |\n| --- |\n| item 10 |\n| item 9 |\n"), 0)).toEqual(["item 9", "item 10"]);
	});
});

describe("formatNumbers", () => {
	it("formats numeric data cells, keeping emphasis and skipping the header, text and formulas", () => {
		const model = parseTable("| 1234 |\n| --- |\n| 1234.5 |\n| **42** |\n| text |\n| 5 %%=A1%% |\n| `7` |\n");
		const n = formatNumbers(model, { r1: 0, c1: 0, r2: 5, c2: 0 }, { style: "number", decimals: 2, locale: "en-US", grouping: true });
		expect(n).toBe(2);
		expect(grid(model).map((r) => r[0])).toEqual(["1234", "1,234.50", "**42.00**", "text", "5 %%=A1%%", "`7`"]);
	});

	it("formats percent and currency", () => {
		const model = parseTable("| P | C |\n| --- | --- |\n| 0.25 | 3 |\n| 25 % | 1000 |\n");
		formatNumbers(model, { r1: 1, c1: 0, r2: 2, c2: 0 }, { style: "percent", decimals: 0, locale: "en-US", grouping: false });
		formatNumbers(model, { r1: 1, c1: 1, r2: 2, c2: 1 }, { style: "currency", decimals: 2, locale: "en-US", currency: "USD", grouping: false });
		expect(grid(model).slice(1)).toEqual([
			["25%", "$3.00"],
			["25%", "$1000.00"],
		]);
	});

	it("returns 0 for an invalid currency code", () => {
		const model = parseTable("| C |\n| --- |\n| 3 |\n");
		expect(formatNumbers(model, { r1: 1, c1: 0, r2: 1, c2: 0 }, { style: "currency", decimals: 2, currency: "not a code", grouping: true })).toBe(0);
	});
});

describe("filters", () => {
	const f = (kind: ColumnFilter["kind"], query?: string, values?: string[]): ColumnFilter => ({ col: 0, kind, query, values });

	it("matches text case-insensitively", () => {
		expect(matchesFilter("Hello World", f("contains", "WORLD"))).toBe(true);
		expect(matchesFilter("Hello World", f("notContains", "world"))).toBe(false);
		expect(matchesFilter("Hello", f("equals", "hello"))).toBe(true);
		expect(matchesFilter("Hello", f("notEquals", "hello"))).toBe(false);
		expect(matchesFilter("Hello", f("startsWith", "he"))).toBe(true);
		expect(matchesFilter("Hello", f("endsWith", "LO"))).toBe(true);
		expect(matchesFilter("anything", f("contains", ""))).toBe(true);
		expect(matchesFilter("", f("equals", ""))).toBe(true);
	});

	it("compares numerically and rejects non-numeric cells", () => {
		expect(matchesFilter("10", f("gt", "9"))).toBe(true);
		expect(matchesFilter("1 000,5", f("gte", "1000"))).toBe(true);
		expect(matchesFilter("**5**", f("lt", "6"))).toBe(true);
		expect(matchesFilter("5", f("lte", "5"))).toBe(true);
		expect(matchesFilter("abc", f("gt", "0"))).toBe(false);
		expect(matchesFilter("5", f("gt", "abc"))).toBe(false);
	});

	it("handles empty and value-list filters", () => {
		expect(matchesFilter(" ", f("empty"))).toBe(true);
		expect(matchesFilter("x", f("notEmpty"))).toBe(true);
		expect(matchesFilter("x", f("values", undefined, ["x", "y"]))).toBe(true);
		expect(matchesFilter("X", f("values", undefined, ["x"]))).toBe(false);
		expect(matchesFilter("", f("values", undefined, [""]))).toBe(true);
		expect(matchesFilter("", f("values", undefined, ["x"]))).toBe(false);
	});

	it("requires every filter in rowMatches", () => {
		const model = parseTable("| N | Q |\n| --- | --- |\n| apple | 5 |\n| pear | 50 |\n");
		const filters: ColumnFilter[] = [
			{ col: 0, kind: "contains", query: "p" },
			{ col: 1, kind: "gt", query: "10" },
		];
		expect(rowMatches(model, 1, filters)).toBe(false);
		expect(rowMatches(model, 2, filters)).toBe(true);
		expect(rowMatches(model, 1, [])).toBe(true);
	});
});

describe("lint checks", () => {
	it("reports ragged body rows by line number", () => {
		const text = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 1 |\n| 1 | 2 | 3 |\n| x \\| y | z |\n";
		expect(raggedRows(text)).toEqual([4, 5]);
		expect(raggedRows("| a | b |\r\n| --- | --- |\r\n| 1 |\r\n")).toEqual([3]);
	});

	it("finds duplicate headers case-insensitively", () => {
		const model = parseTable("| Name | name | Age |  | NAME | Age |\n| --- | --- | --- | --- | --- | --- |\n");
		expect(duplicateHeaders(model)).toEqual(["Name", "Age"]);
		expect(duplicateHeaders(parseTable("| a | b |\n| --- | --- |\n"))).toEqual([]);
	});
});

describe("duplicateRows", () => {
	it("inserts copies as a block below the last selected row and reindexes heights", () => {
		const model = parseTable("| H |\n| --- |\n| a |\n| b |\n| c |\n");
		const l = layout({ rowHeights: { "1": 40, "3": 60 } });
		duplicateRows(model, l, [2, 1, 0]);
		expect(grid(model).map((r) => r[0])).toEqual(["H", "a", "b", "a", "b", "c"]);
		expect(l.rowHeights).toEqual({ "1": 40, "3": 40, "5": 60 });
		expectSparse(model);
	});

	it("never duplicates the header alone", () => {
		const model = parseTable("| H |\n| --- |\n| a |\n");
		duplicateRows(model, layout(), [0]);
		expect(grid(model).map((r) => r[0])).toEqual(["H", "a"]);
	});

	it("keeps empty cells absent in the copies", () => {
		const model = parseTable("| H | I |\n| --- | --- |\n| a |  |\n");
		duplicateRows(model, layout(), [1]);
		expect(model.cells.size).toBe(4);
		expectSparse(model);
	});
});

describe("duplicateCols", () => {
	it("copies values, alignment, width and wrap to the right of the last column", () => {
		const model = parseTable("| A | B | C |\n| :-- | --: | --- |\n| 1 |  | 3 |\n");
		const l = layout({ colWidths: [10, 20, 30], wrapCols: [1, 2] });
		duplicateCols(model, l, [0, 1]);
		expect(grid(model)).toEqual([
			["A", "B", "A", "B", "C"],
			["1", "", "1", "", "3"],
		]);
		expect(model.colAlign).toEqual(["left", "right", "left", "right", null]);
		expect(l.colWidths).toEqual([10, 20, 10, 20, 30]);
		expect(l.wrapCols).toEqual([1, 3, 4]);
		expectSparse(model);
		expect(serializeTable(model)).toContain("| A ");
	});
});

describe("toHtmlTable", () => {
	it("builds an escaped table with alignment", () => {
		const html = toHtmlTable(
			[
				["Name", "Qty"],
				["<b>a</b> & \"b\"", "**5**"],
			],
			[null, "right"],
			(raw) => raw.split("**").join(""),
		);
		expect(html).toBe(
			[
				"<table>",
				"<thead>",
				'<tr><th>Name</th><th style="text-align:right">Qty</th></tr>',
				"</thead>",
				"<tbody>",
				'<tr><td>&lt;b&gt;a&lt;/b&gt; &amp; &quot;b&quot;</td><td style="text-align:right">5</td></tr>',
				"</tbody>",
				"</table>",
			].join("\n"),
		);
	});

	it("omits the body for a header-only table", () => {
		expect(toHtmlTable([["a"]], [], (s) => s)).not.toContain("<tbody>");
		expect(toHtmlTable([], [], (s) => s)).toBe("");
	});
});

describe("toJson", () => {
	it("keys rows by header, filling empty and duplicate names", () => {
		const json = toJson([
			["Name", "", "Name", "Name"],
			["a", "b", "c", "d"],
			["e"],
		]);
		expect(JSON.parse(json)).toEqual([
			{ Name: "a", [colName(1)]: "b", "Name 2": "c", "Name 3": "d" },
			{ Name: "e", B: "", "Name 2": "", "Name 3": "" },
		]);
		expect(json).toContain("\n\t{");
	});

	it("returns an empty array for an empty table", () => {
		expect(toJson([])).toBe("[]");
		expect(toJson([["H"]])).toBe("[]");
	});
});
