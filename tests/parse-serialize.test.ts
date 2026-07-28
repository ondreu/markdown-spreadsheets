import { describe, expect, it } from "vitest";
import { getRaw } from "../src/model/GridModel";
import { isDelimiterRow, parseTable, splitCells, splitRow, unescapePipes } from "../src/model/parse";
import { displayWidth, escapeCell, serializeTable } from "../src/model/serialize";

/** §6: the round trip has to be stable, not merely lossless. */
function stable(input: string): void {
	const once = serializeTable(parseTable(input));
	const twice = serializeTable(parseTable(once));
	expect(twice).toBe(once);
}

describe("splitRow", () => {
	it("splits on bare pipes", () => {
		expect(splitRow("| a | b |")).toEqual(["", " a ", " b ", ""]);
	});

	it("keeps an escaped pipe inside the cell", () => {
		expect(splitRow("| a \\| b |")).toEqual(["", " a \\| b ", ""]);
	});

	it("does not let a doubled backslash escape the pipe", () => {
		// `\\` is a literal backslash, so the following pipe is still a separator.
		expect(splitRow("| a \\\\| b |")).toEqual(["", " a \\\\", " b ", ""]);
	});

	it("tolerates a pipe inside a code span", () => {
		expect(splitRow("| `a|b` | c |")).toEqual(["", " `a|b` ", " c ", ""]);
	});

	it("does not treat an escaped backtick as opening a code span", () => {
		expect(splitRow("| \\` | x |")).toEqual(["", " \\` ", " x ", ""]);
	});
});

describe("splitCells", () => {
	it("drops the leading and trailing pipe artefacts", () => {
		expect(splitCells("| a | b |")).toEqual(["a", "b"]);
	});

	it("keeps a genuinely empty trailing cell", () => {
		expect(splitCells("| a | b | |")).toEqual(["a", "b", ""]);
	});

	it("keeps an empty leading cell", () => {
		expect(splitCells("|| a |")).toEqual(["", "a"]);
	});

	it("handles rows without surrounding pipes", () => {
		expect(splitCells("a | b")).toEqual(["a", "b"]);
	});

	it("unescapes pipes", () => {
		expect(splitCells("| a \\| b |")).toEqual(["a | b"]);
	});
});

describe("unescapePipes", () => {
	it("only touches the pipe escape", () => {
		expect(unescapePipes("\\|")).toBe("|");
		expect(unescapePipes("\\d")).toBe("\\d");
		expect(unescapePipes("\\\\")).toBe("\\\\");
		expect(unescapePipes("C:\\path")).toBe("C:\\path");
	});
});

describe("isDelimiterRow", () => {
	it("recognises every alignment form", () => {
		expect(isDelimiterRow("| --- | :--- | ---: | :---: |")).toBe(true);
		expect(isDelimiterRow("|-|-|")).toBe(true);
	});

	it("rejects data rows", () => {
		expect(isDelimiterRow("| a | b |")).toBe(false);
		expect(isDelimiterRow("| -a- |")).toBe(false);
		expect(isDelimiterRow("| a |")).toBe(false);
	});
});

describe("parseTable", () => {
	it("keeps the header on row 0 and data from row 1", () => {
		const model = parseTable("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
		expect(getRaw(model, 0, 0)).toBe("A");
		expect(getRaw(model, 1, 0)).toBe("1");
		expect(model.usedRange).toEqual({ rows: 2, cols: 2 });
	});

	it("stays sparse — an empty cell is not in the map", () => {
		const model = parseTable("| A | B |\n| --- | --- |\n|  | 2 |\n");
		expect(model.cells.has("1:0")).toBe(false);
		expect(model.cells.size).toBe(3);
	});

	it("reads the alignment row", () => {
		const model = parseTable("| A | B | C | D |\n| --- | :--- | ---: | :---: |\n");
		expect(model.colAlign).toEqual([null, "left", "right", "center"]);
	});

	it("keeps cells past the header width instead of dropping them", () => {
		const model = parseTable("| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n");
		expect(getRaw(model, 1, 2)).toBe("3");
		expect(model.usedRange.cols).toBe(3);
	});

	it("keeps the column count pinned by the alignment row", () => {
		const model = parseTable("| A | B | C |\n| --- | --- | --- |\n| 1 |  |  |\n");
		expect(model.usedRange.cols).toBe(3);
	});

	it("survives a block with no alignment row", () => {
		const model = parseTable("| A | B |\n| 1 | 2 |\n");
		expect(getRaw(model, 0, 0)).toBe("A");
		expect(getRaw(model, 1, 1)).toBe("2");
	});

	it("normalises CRLF", () => {
		const model = parseTable("| A |\r\n| --- |\r\n| 1 |\r\n");
		expect(getRaw(model, 1, 0)).toBe("1");
	});
});

describe("serializeTable", () => {
	it("emits a header, an alignment row and the body", () => {
		const out = serializeTable(parseTable("| A | B |\n| --- | --- |\n| 1 | 2 |\n"));
		expect(out).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |\n");
	});

	it("re-escapes pipes", () => {
		const out = serializeTable(parseTable("| a \\| b |\n| --- |\n"));
		expect(out.split("\n")[0]).toContain("a \\| b");
	});

	it("writes the alignment markers", () => {
		const out = serializeTable(parseTable("| A | B | C |\n| :--- | ---: | :---: |\n"));
		expect(out.split("\n")[1]).toBe("| :-- | --: | :-: |");
	});

	it("pads according to the column alignment", () => {
		const out = serializeTable(parseTable("| Long header | x |\n| ---: | --- |\n| 1 | 2 |\n"));
		expect(out.split("\n")[2]).toBe("|           1 | 2   |");
	});

	it("leaves no trailing whitespace and ends with a newline", () => {
		const out = serializeTable(parseTable("| A | B |\n| --- | --- |\n| 1 |  |\n"));
		for (const line of out.split("\n")) expect(line).toBe(line.replace(/[ \t]+$/, ""));
		expect(out.endsWith("\n")).toBe(true);
	});

	it("never produces an alignment cell narrower than three dashes", () => {
		const out = serializeTable(parseTable("| a |\n| - |\n"));
		expect(out.split("\n")[1]).toBe("| --- |");
	});

	it("caps the padding width", () => {
		const long = "x".repeat(120);
		const out = serializeTable(parseTable(`| ${long} | b |\n| --- | --- |\n| 1 | 2 |\n`));
		const delim = out.split("\n")[1];
		expect(delim.split("|")[1].trim().length).toBe(60);
	});

	it("emits a valid table for an empty model", () => {
		const out = serializeTable(parseTable(""));
		expect(out).toBe("|     |\n| --- |\n");
	});
});

describe("escapeCell", () => {
	it("escapes every pipe, including inside code spans", () => {
		expect(escapeCell("`a|b`")).toBe("`a\\|b`");
	});

	it("leaves other backslashes untouched", () => {
		expect(escapeCell("\\d+")).toBe("\\d+");
	});

	it("flattens newlines, which a GFM cell cannot contain", () => {
		expect(escapeCell("a\nb")).toBe("a b");
	});
});

describe("displayWidth", () => {
	it("counts wide characters as two columns", () => {
		expect(displayWidth("ab")).toBe(2);
		expect(displayWidth("日本")).toBe(4);
	});
});

describe("round trip on pathological tables (§16 step 2)", () => {
	const cases: Array<[string, string]> = [
		["simple", "| A | B |\n| --- | --- |\n| 1 | 2 |\n"],
		["escaped pipe", "| a \\| b | c |\n| --- | --- |\n| 1 | 2 |\n"],
		["code span with an escaped pipe", "| `a \\| b` | c |\n| --- | --- |\n"],
		["code span with a bare pipe", "| `a|b` | c |\n| --- | --- |\n"],
		["wikilink alias", "| [[Note\\|Alias]] | x |\n| --- | --- |\n"],
		["embedded image with a size", "| ![[img.png\\|300]] |\n| --- |\n"],
		["ragged rows", "| A | B |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |\n"],
		["empty cells everywhere", "|  |  |\n| --- | --- |\n|  | 2 |\n|  |  |\n"],
		["all alignments", "| A | B | C | D |\n| --- | :--- | ---: | :---: |\n| 1 | 2 | 3 | 4 |\n"],
		["cjk", "| 名前 | 値 |\n| --- | --- |\n| 日本語 | 42 |\n"],
		["trailing backslash", "| \\ | b |\n| --- | --- |\n"],
		["backslash sequences", "| \\d+ | C:\\temp | \\\\ |\n| --- | --- | --- |\n"],
		["no outer pipes", "A | B\n--- | ---\n1 | 2\n"],
		["header only", "| A | B |\n| --- | --- |\n"],
		["single column", "| A |\n| --- |\n| 1 |\n"],
		["inline markdown", "| **bold** | *it* | `code` | ~~x~~ |\n| --- | --- | --- | --- |\n"],
		["numbers with separators", "| 1 234,56 | 1.234,56 | 1,234.56 |\n| --- | --- | --- |\n"],
		["unicode punctuation", "| — | … | „quoted” |\n| --- | --- | --- |\n"],
		["crlf", "| A |\r\n| --- |\r\n| 1 |\r\n"],
	];

	for (const [name, input] of cases) {
		it(`is stable: ${name}`, () => stable(input));
	}

	it("preserves cell content through a full cycle", () => {
		const input = "| a \\| b | `c|d` | [[N\\|A]] | \\d+ |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n";
		const first = parseTable(input);
		const second = parseTable(serializeTable(first));
		for (const [key, cell] of first.cells) {
			expect(second.cells.get(key)?.raw).toBe(cell.raw);
		}
	});

	it("keeps a cell that ends with a backslash intact", () => {
		const model = parseTable("| x\\ | b |\n| --- | --- |\n");
		const round = parseTable(serializeTable(model));
		expect(getRaw(round, 0, 0)).toBe("x\\");
	});
});
