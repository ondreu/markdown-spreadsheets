import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { getRaw } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";
import { buildXlsx } from "../src/feature/exportXlsx";
import { detectDelimiter, parseCsv, readXlsx, valuesToModel } from "../src/feature/importTable";
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
