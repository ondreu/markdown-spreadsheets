import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { getRaw } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";
import { buildXlsx } from "../src/feature/exportXlsx";
import { detectDelimiter, parseCsv, readXlsx, readXlsxWorkbook, valuesToModel } from "../src/feature/importTable";
import { countFormulas, formulaTotal, importFormula, sheetToValues, shiftFormula, type FormulaContext } from "../src/feature/importFormula";
import { crc32 } from "../src/feature/zip";

describe("parseCsv", () => {
	it("reads quoted fields with doubled quotes and delimiters inside", () => {
		expect(parseCsv('a,"b,c","say ""hi"""\n1,2,3\n', ",")).toEqual([
			["a", "b,c", 'say "hi"'],
			["1", "2", "3"],
		]);
	});

	it("handles CRLF, LF and a missing final newline", () => {
		expect(parseCsv("a;b\r\nc;d", ";")).toEqual([
			["a", "b"],
			["c", "d"],
		]);
		expect(parseCsv("a;b\rc;d\r", ";")).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	it("collapses a line break inside quotes to a space", () => {
		expect(parseCsv('"one\r\ntwo",x\n"a\nb",y', ",")).toEqual([
			["one two", "x"],
			["a b", "y"],
		]);
	});

	it("strips the BOM and pads a ragged file", () => {
		expect(parseCsv("\uFEFFa,b,c\nd\n,x\n,\n", ",")).toEqual([
			["a", "b", "c"],
			["d", "", ""],
			["", "x", ""],
		]);
	});

	it("keeps empty fields, a trailing delimiter and blank middle lines", () => {
		expect(parseCsv('a,,""\n\nb,\n\n\n', ",")).toEqual([
			["a", "", ""],
			["", "", ""],
			["b", "", ""],
		]);
	});

	it("is lenient about stray quotes", () => {
		expect(parseCsv('5" pipe,x\n"a"b,c', ",")).toEqual([
			['5" pipe', "x"],
			["ab", "c"],
		]);
	});

	it("returns nothing for an empty file", () => {
		expect(parseCsv("")).toEqual([]);
		expect(parseCsv("\uFEFF\n\n")).toEqual([]);
	});
});

describe("detectDelimiter", () => {
	it("picks the consistent delimiter", () => {
		expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
		expect(detectDelimiter("Name;Price\nBolt;1,5\nNut;2,25\n")).toBe(";");
		expect(detectDelimiter("a\tb\n1,5\t2,5\n")).toBe("\t");
	});

	it("ignores delimiters inside quotes", () => {
		expect(detectDelimiter('"a;b",c\n"d;e",f\n"g",h\n')).toBe(",");
	});

	it("prefers the semicolon when a comma is just as consistent", () => {
		// Every line has one of each: decimal commas in a semicolon file.
		expect(detectDelimiter("1,5;2\n3,5;4\n")).toBe(";");
		expect(parseCsv("1,5;2\n3,5;4\n")).toEqual([
			["1,5", "2"],
			["3,5", "4"],
		]);
	});

	it("falls back to a comma", () => {
		expect(detectDelimiter("just one column\nanother\n")).toBe(",");
	});
});

describe("valuesToModel", () => {
	it("makes the first row the header and stays sparse", () => {
		const model = valuesToModel([
			["Name", "Qty", ""],
			["a | b", "", "x"],
			["", "", ""],
		]);
		expect(getRaw(model, 0, 0)).toBe("Name");
		expect(model.cells.size).toBe(4);
		expect(model.usedRange).toEqual({ rows: 2, cols: 3 });
		const md = serializeTable(model);
		expect(md.split("\n")[2]).toContain("a \\| b");
		expect(getRaw(parseTable(md), 1, 0)).toBe("a | b");
	});

	it("trims and flattens values", () => {
		const model = valuesToModel([["  A ", "x\ny"]]);
		expect(getRaw(model, 0, 0)).toBe("A");
		expect(getRaw(model, 0, 1)).toBe("x y");
	});
});

/* ------------------------------------------------------------------ XLSX */

const AT = new Date(Date.UTC(2026, 6, 28, 12, 0, 0));

/** A zip with deflated entries and streaming-style local headers (sizes in a data descriptor). */
function deflatedZip(files: Array<{ path: string; text: string }>): Uint8Array {
	const enc = new TextEncoder();
	const chunks: number[] = [];
	const u16 = (v: number): void => {
		chunks.push(v & 0xff, (v >>> 8) & 0xff);
	};
	const u32 = (v: number): void => {
		chunks.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
	};
	const bytes = (b: Uint8Array): void => {
		for (const x of b) chunks.push(x);
	};
	const meta: Array<{ name: Uint8Array; crc: number; csize: number; size: number; offset: number }> = [];
	for (const f of files) {
		const name = enc.encode(f.path);
		const data = enc.encode(f.text);
		const packed = new Uint8Array(deflateRawSync(data));
		const offset = chunks.length;
		u32(0x04034b50);
		u16(20);
		u16(0x0808); // UTF-8 names + data descriptor
		u16(8);
		u16(0);
		u16(0);
		u32(0);
		u32(0);
		u32(0);
		u16(name.length);
		u16(0);
		bytes(name);
		bytes(packed);
		u32(0x08074b50);
		u32(crc32(data));
		u32(packed.length);
		u32(data.length);
		meta.push({ name, crc: crc32(data), csize: packed.length, size: data.length, offset });
	}
	const dir = chunks.length;
	for (const m of meta) {
		u32(0x02014b50);
		u16(20);
		u16(20);
		u16(0x0808);
		u16(8);
		u16(0);
		u16(0);
		u32(m.crc);
		u32(m.csize);
		u32(m.size);
		u16(m.name.length);
		u16(0);
		u16(0);
		u16(0);
		u16(0);
		u32(0);
		u32(m.offset);
		bytes(m.name);
	}
	const dirSize = chunks.length - dir;
	u32(0x06054b50);
	u16(0);
	u16(0);
	u16(meta.length);
	u16(meta.length);
	u32(dirSize);
	u32(dir);
	const comment = enc.encode("archive comment");
	u16(comment.length);
	bytes(comment);
	return new Uint8Array(chunks);
}

describe("readXlsx", () => {
	it("round-trips the plugin's own (stored) export", async () => {
		const model = parseTable(
			"| Name | Qty | Total |\n| --- | ---: | ---: |\n| Bolt & <nut> | 1 234,56 | **2 469,12** %%=B2*2%% |\n|  | 3 |  |\n",
		);
		const bytes = buildXlsx(
			model,
			{ sheetName: "Table", content: "raw", detectNumbers: true, styleHeader: true, defaultColWidth: 120 },
			AT,
		);
		expect(await readXlsx(bytes)).toEqual([
			["Name", "Qty", "Total"],
			["Bolt & <nut>", "1234.56", "2469.12"],
			["", "3", ""],
		]);
	});

	it("reads a deflated workbook: shared strings, rich text, types, gaps and entities", async () => {
		const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
		const bytes = deflatedZip([
			{
				path: "xl/workbook.xml",
				text: `<?xml version="1.0"?><workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="7" r:id="rId9"/><sheet name="Other" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			},
			{
				path: "xl/_rels/workbook.xml.rels",
				text: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/data.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
			},
			{
				path: "xl/sharedStrings.xml",
				text: `<sst ${ns} count="3" uniqueCount="3"><si><t>Name</t></si><si><r><rPr><b/></rPr><t xml:space="preserve">Rich </t></r><r><t>text &amp; more</t></r><rPh sb="0" eb="1"><t>ルビ</t></rPh></si><si><t>Line_x000D_
break</t></si></sst>`,
			},
			{ path: "xl/worksheets/sheet1.xml", text: `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>` },
			{
				path: "xl/worksheets/data.xml",
				text: `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:cols><x:col min="1" max="3" width="9"/></x:cols><x:sheetData>
<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="s"><x:v>1</x:v></x:c></x:row>
<x:row r="3"><x:c r="A3" t="b"><x:v>1</x:v></x:c><x:c r="B3" t="e"><x:v>#DIV/0!</x:v></x:c><x:c r="C3"><x:v>0.30000000000000004</x:v></x:c><x:c r="D3" s="1"/></x:row>
<x:row><x:c t="str"><x:f>A1&amp;"!"</x:f><x:v>Name!</x:v></x:c><x:c t="inlineStr"><x:is><x:t>a &lt;b&gt; &#233;&#x20AC;</x:t></x:is></x:c><x:c t="s"><x:v>2</x:v></x:c></x:row>
<x:row r="6"><x:c r="A6" s="2"><x:v>45000</x:v></x:c><x:c r="B6"><x:v>1E3</x:v></x:c></x:row>
<x:row r="9"><x:c r="F9" s="3"/></x:row>
</x:sheetData></x:worksheet>`,
			},
		]);
		expect(await readXlsx(bytes)).toEqual([
			["Name", "", "Rich text & more"],
			["", "", ""],
			["TRUE", "#DIV/0!", "0.30000000000000004"],
			["Name!", "a <b> é€", "Line break"],
			["", "", ""],
			["45000", "1000", ""],
		]);
	});

	it("falls back to the first worksheet path when the workbook part is missing", async () => {
		const bytes = deflatedZip([
			{
				path: "xl/worksheets/sheet1.xml",
				text: '<worksheet><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>only</t></is></c></row></sheetData></worksheet>',
			},
		]);
		expect(await readXlsx(bytes)).toEqual([
			["", ""],
			["", "only"],
		]);
	});

	it("rejects something that is not a zip", async () => {
		await expect(readXlsx(new TextEncoder().encode("a,b,c\n1,2,3\n"))).rejects.toThrow();
	});

	it("feeds straight into a model", async () => {
		const model = parseTable("| A | B |\n| --- | --- |\n| x | 2 |\n");
		const bytes = buildXlsx(
			model,
			{ sheetName: "S", content: "raw", detectNumbers: true, styleHeader: true, defaultColWidth: 120 },
			AT,
		);
		const back = valuesToModel(await readXlsx(bytes));
		expect(serializeTable(back)).toBe(serializeTable(parseTable("| A | B |\n| --- | --- |\n| x | 2 |\n")));
	});
});

/* ------------------------------------------------- formulas out of Excel */

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Two worksheets, one hidden, one formula, one cell with a formula and no cached value. */
function workbookBytes(): Uint8Array {
	return deflatedZip([
		{
			path: "xl/workbook.xml",
			text: `<?xml version="1.0"?><workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
		},
		{
			path: "xl/_rels/workbook.xml.rels",
			text: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
		},
		{
			path: "xl/worksheets/sheet1.xml",
			text: `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c><c r="C1" t="inlineStr"><is><t>Total</t></is></c><c r="D1" t="inlineStr"><is><t>Next</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Bolt</t></is></c><c r="B2"><v>2</v></c><c r="C2"><f>B2*10</f><v>20</v></c><c r="D2"><f>1+1</f></c></row></sheetData></worksheet>`,
		},
		{
			path: "xl/worksheets/sheet2.xml",
			text: `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>note</t></is></c></row></sheetData></worksheet>`,
		},
	]);
}

describe("readXlsxWorkbook", () => {
	it("reads every worksheet, its name, its state and its formulas", async () => {
		const book = await readXlsxWorkbook(workbookBytes());
		expect(book.sheets.map((sheet) => sheet.name)).toEqual(["Data", "Notes"]);
		expect(book.sheets.map((sheet) => sheet.hidden)).toEqual([false, true]);
		expect(formulaTotal(book.sheets[0].rows)).toBe(2);
		expect(book.sheets[0].rows[1][2]).toEqual({ value: "20", formula: "B2*10" });
		// A formula Excel never calculated still travels: the grid recomputes it on open.
		expect(book.sheets[0].rows[1][3]).toEqual({ value: "", formula: "1+1" });
		expect(book.sheets[1].rows).toEqual([[{ value: "note" }]]);
	});

	it("expands a shared formula over the cells that copy it", async () => {
		const bytes = deflatedZip([
			{
				path: "xl/workbook.xml",
				text: `<?xml version="1.0"?><workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			},
			{
				path: "xl/_rels/workbook.xml.rels",
				text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
			},
			{
				path: "xl/worksheets/sheet1.xml",
				text: `<worksheet ${NS}><sheetData>
<row r="2"><c r="B2"><v>2</v></c><c r="C2"><v>3</v></c><c r="D2"><f t="shared" ref="D2:D4" si="0">B2*C2</f><v>6</v></c></row>
<row r="3"><c r="B3"><v>4</v></c><c r="C3"><v>5</v></c><c r="D3"><f t="shared" si="0"/><v>20</v></c></row>
<row r="4"><c r="B4"><v>6</v></c><c r="C4"><v>7</v></c><c r="D4"><f t="shared" si="0"/><v>42</v></c></row>
</sheetData></worksheet>`,
			},
		]);
		const sheet = (await readXlsxWorkbook(bytes)).sheets[0];
		expect(formulaTotal(sheet.rows)).toBe(3);
		// The first row of the file is row 2, so the rectangle starts with an empty row.
		expect(sheet.rows[2][3]).toEqual({ value: "20", formula: "B3*C3" });
		expect(sheet.rows[3][3]).toEqual({ value: "42", formula: "B4*C4" });
	});
});

describe("shiftFormula", () => {
	it("moves relative references and leaves anchored ones", () => {
		expect(shiftFormula("B2*C2", 1, 0)).toBe("B3*C3");
		expect(shiftFormula("$B$2+B2", 1, 1)).toBe("$B$2+C3");
		expect(shiftFormula("$B2+B$2", 2, 3)).toBe("$B4+E$2");
	});

	it("stays out of strings and quoted sheet names", () => {
		expect(shiftFormula('IF(A2="B2","A2","x")', 1, 0)).toBe('IF(A3="B2","A2","x")');
		expect(shiftFormula("'My B2'!B2", 1, 0)).toBe("'My B2'!B3");
	});

	it("does not mistake a function name for a reference", () => {
		expect(shiftFormula("LOG10(B2)", 1, 0)).toBe("LOG10(B3)");
	});
});

describe("importFormula", () => {
	const context = (over: Partial<FormulaContext> = {}): FormulaContext => ({
		sheet: { rows: 10, cols: 5 },
		sheets: new Map([
			["data", { ref: "Table1", rows: 10, cols: 5 }],
			["q1 data", { ref: "Table2", rows: 4, cols: 3 }],
		]),
		...over,
	});

	it("keeps what the grid can compute", () => {
		expect(importFormula("SUM(B2:B4)", context())).toBe("SUM(B2:B4)");
		expect(importFormula("=IF(B2>10,1,0)", context())).toBe("IF(B2>10,1,0)");
		expect(importFormula("SUMIF(A2:A9,\">10\",B2:B9)", context())).toBe('SUMIF(A2:A9,">10",B2:B9)');
		expect(importFormula("B2*$C$2&\" %\"", context())).toBe('B2*$C$2&" %"');
	});

	it("reads a comma-decimal writer's separators", () => {
		expect(importFormula("ROUND(B2;2)", context())).toBe("ROUND(B2,2)");
	});

	it("points a cross-sheet reference at the table its sheet becomes", () => {
		expect(importFormula("SUM('Q1 data'!B2:B4)", context())).toBe("SUM(Table2!B2:B4)");
		expect(importFormula("Data!A2*2", context())).toBe("Table1!A2*2");
	});

	it("rewrites a legacy lookup into XLOOKUP, where the block is known", () => {
		expect(importFormula("VLOOKUP(A2,B2:D9,3,FALSE)", context())).toBe("XLOOKUP(A2,B2:B9,D2:D9)");
		expect(importFormula("VLOOKUP(A2,$B$2:$D$9,3,0)", context())).toBe("XLOOKUP(A2,$B$2:$B$9,$D$2:$D$9)");
		expect(importFormula("HLOOKUP(A2,B2:D5,2,FALSE)", context())).toBe("XLOOKUP(A2,B2:D2,B3:D3)");
		expect(importFormula("VLOOKUP(A2,'Q1 data'!A2:C4,2,FALSE)", context())).toBe(
			"XLOOKUP(A2,Table2!A2:A4,Table2!B2:B4)",
		);
		// A column past the block, and a lookup that is not exact: neither can be carried over.
		expect(importFormula("VLOOKUP(A2,B2:D9,4,FALSE)", context())).toBeNull();
		expect(importFormula("VLOOKUP(A2,B2:D9,3,TRUE)", context())).toBeNull();
		expect(importFormula("VLOOKUP(A2,B2:D9,3)", context())).toBeNull();
	});

	it("refuses what it cannot carry, so the value stays", () => {
		expect(importFormula("LEN(A2)*1", context())).toBeNull();
		expect(importFormula("TODAY()", context())).toBe("TODAY()");
		expect(importFormula("LEN(A2)*1", context())).toBeNull();
		expect(importFormula("Table1[Qty]*2", context())).toBeNull();
		expect(importFormula("B2*10%", context())).toBeNull();
		expect(importFormula("#REF!+1", context())).toBeNull();
		// A reference outside the rectangle has no cell to read in the table.
		expect(importFormula("SUM(B2:B99)", context())).toBeNull();
		expect(importFormula("Q2!A1", context({ sheets: new Map() }))).toBeNull();
	});

	it("moves the references when the block is pasted lower or further right", () => {
		expect(importFormula("B2*C2", context({ offset: { row: 3, col: 1 } }))).toBe("C5*D5");
		// A reference into another sheet belongs to that sheet, which is not moving.
		expect(importFormula("'Q1 data'!B2", context({ offset: { row: 3, col: 1 } }))).toBe("Table2!B2");
	});

	it("is checked by the real parser, not by its own rules", () => {
		// IF takes two arguments at least; the importer must not accept it and let the grid fail.
		expect(importFormula("IF(B2>1)", context())).toBeNull();
	});
});

describe("sheetToValues", () => {
	const rows = [
		[{ value: "Name" }, { value: "Qty" }, { value: "Total" }],
		[{ value: "Bolt" }, { value: "2", formula: "B2*10" }, { value: "n/a", formula: "LEN(A2)*1" }],
	];
	const context: FormulaContext = { sheet: { rows: 2, cols: 3 }, sheets: new Map() };

	it("writes a convertible formula as its value plus the formula comment", () => {
		expect(sheetToValues(rows, { formulas: "convert", context })[1]).toEqual(["Bolt", "2 %%=B2*10%%", "n/a"]);
	});

	it("drops every formula when values are asked for", () => {
		expect(sheetToValues(rows, { formulas: "values", context })[1]).toEqual(["Bolt", "2", "n/a"]);
	});

	it("counts what could be carried over", () => {
		expect(countFormulas(rows, context)).toEqual({ total: 2, convertible: 1 });
	});
});

describe("dates in a workbook", () => {
	const bytesWithStyles = (): Uint8Array =>
		deflatedZip([
			{
				path: "xl/workbook.xml",
				text: `<?xml version="1.0"?><workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			},
			{
				path: "xl/_rels/workbook.xml.rels",
				text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
			},
			{
				path: "xl/styles.xml",
				text: `<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs></styleSheet>`,
			},
			{
				path: "xl/worksheets/sheet1.xml",
				text: `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>When</t></is></c><c r="B1" t="inlineStr"><is><t>Custom</t></is></c><c r="C1" t="inlineStr"><is><t>Plain</t></is></c><c r="D1" t="inlineStr"><is><t>Money</t></is></c></row><row r="2"><c r="A2" s="1"><v>46096</v></c><c r="B2" s="2"><v>46097</v></c><c r="C2" s="0"><v>46096</v></c><c r="D2" s="3"><v>46096</v></c></row></sheetData></worksheet>`,
			},
		]);

	it("writes a date-styled cell as a date, and leaves every other number alone", async () => {
		const sheet = (await readXlsxWorkbook(bytesWithStyles())).sheets[0];
		expect(sheet.rows[1][0]).toEqual({ value: "2026-03-15" });
		expect(sheet.rows[1][1]).toEqual({ value: "2026-03-16" });
		expect(sheet.rows[1][2]).toEqual({ value: "46096" });
		// `#,##0` is not a date: a serial there is a number, however odd it looks.
		expect(sheet.rows[1][3]).toEqual({ value: "46096" });
	});

	it("feeds the grid a cell a formula can subtract", async () => {
		const model = valuesToModel(await readXlsx(bytesWithStyles()));
		expect(getRaw(model, 1, 0)).toBe("2026-03-15");
	});
});
