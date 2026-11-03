import { describe, expect, it } from "vitest";
import { parseTable } from "../src/model/parse";
import { buildCsv, csvField, plainText } from "../src/feature/exportCsv";
import { fromMarkdownTable, fromTsv, toTsv } from "../src/feature/clipboard";
import { buildXlsx, sanitizeSheetName, styleIndex, xmlEscape } from "../src/feature/exportXlsx";
import { crc32 } from "../src/feature/zip";

const AT = new Date(Date.UTC(2026, 6, 28, 12, 0, 0));

describe("csvField", () => {
	it("quotes only when it has to (RFC 4180)", () => {
		expect(csvField("plain", ";")).toBe("plain");
		expect(csvField("a;b", ";")).toBe('"a;b"');
		expect(csvField('say "hi"', ";")).toBe('"say ""hi"""');
		expect(csvField("line\nbreak", ";")).toBe('"line\nbreak"');
		expect(csvField(" padded ", ";")).toBe('" padded "');
	});
});

describe("buildCsv", () => {
	const model = parseTable("| Name | Qty |\n| --- | --- |\n| Bolt; long | 10 |\n");

	it("writes a BOM when asked", () => {
		const csv = buildCsv(model, { delimiter: ";", bom: true, content: "raw", crlf: true });
		expect(csv.charCodeAt(0)).toBe(0xfeff);
	});

	it("omits the BOM when not", () => {
		const csv = buildCsv(model, { delimiter: ";", bom: false, content: "raw", crlf: true });
		expect(csv.startsWith("Name")).toBe(true);
	});

	it("uses the chosen delimiter and quotes around it", () => {
		const csv = buildCsv(model, { delimiter: ";", bom: false, content: "raw", crlf: false });
		expect(csv.split("\n")[1]).toBe('"Bolt; long";10');
	});

	it("writes CRLF for Excel", () => {
		const csv = buildCsv(model, { delimiter: ",", bom: false, content: "raw", crlf: true });
		expect(csv.includes("\r\n")).toBe(true);
	});

	it("exports every cell of the used range, empties included", () => {
		const sparse = parseTable("| A | B | C |\n| --- | --- | --- |\n|  | 2 |  |\n");
		const csv = buildCsv(sparse, { delimiter: ",", bom: false, content: "raw", crlf: false });
		expect(csv.split("\n")[1]).toBe(",2,");
	});
});

describe("plainText", () => {
	it("resolves wikilink aliases and drops emphasis", () => {
		expect(plainText("[[Note|Alias]]")).toBe("Alias");
		expect(plainText("[[Note]]")).toBe("Note");
		expect(plainText("[label](https://example.com)")).toBe("label");
		expect(plainText("**bold**")).toBe("bold");
		// The alias of an embedded image is its size, not a label.
		expect(plainText("![[img.png|300]]")).toBe("img.png");
		expect(plainText("![[img.png|Diagram]]")).toBe("Diagram");
	});

	it("drops emphasis inside the cell, not only around it", () => {
		expect(plainText("hello *world*")).toBe("hello world");
		expect(plainText("a **b** and _c_ and ~~d~~")).toBe("a b and c and d");
		expect(plainText("***both***")).toBe("both");
	});

	it("leaves intraword underscores and code content alone", () => {
		expect(plainText("snake_case_name")).toBe("snake_case_name");
		expect(plainText("run `a*b*c` now")).toBe("run a*b*c now");
		expect(plainText("2 * 3 * 4")).toBe("2 * 3 * 4");
		expect(plainText("\\*literal\\*")).toBe("*literal*");
	});
});

describe("fromMarkdownTable", () => {
	it("reads a pasted Markdown table into cells", () => {
		expect(fromMarkdownTable("| A | B |\n| --- | --- |\n| 1 | x \\| y |\n")).toEqual([
			["A", "B"],
			["1", "x | y"],
		]);
	});

	it("leaves TSV and plain text alone", () => {
		expect(fromMarkdownTable("a\tb\n1\t2")).toBeNull();
		expect(fromMarkdownTable("just | text")).toBeNull();
		expect(fromMarkdownTable("a | b\n---\n")).toBeNull();
	});
});

describe("TSV clipboard", () => {
	it("round-trips a plain rectangle", () => {
		const values = [
			["a", "b"],
			["c", "d"],
		];
		expect(fromTsv(toTsv(values))).toEqual(values);
	});

	it("quotes and recovers tabs and newlines", () => {
		const values = [["has\ttab", "has\nnewline"]];
		// A newline inside a cell cannot survive into markdown, so it flattens on the way out.
		const round = fromTsv(toTsv(values));
		expect(round[0][0]).toBe("has\ttab");
		expect(round[0][1]).toBe("has newline");
	});

	it("recovers doubled quotes", () => {
		expect(fromTsv(toTsv([['say "hi"']]))).toEqual([['say "hi"']]);
	});

	it("pads a ragged paste into a rectangle", () => {
		expect(fromTsv("a\tb\tc\nd\n")).toEqual([
			["a", "b", "c"],
			["d", "", ""],
		]);
	});

	it("drops the trailing empty line the clipboard adds", () => {
		expect(fromTsv("a\tb\n")).toEqual([["a", "b"]]);
	});

	it("normalises CRLF from Excel on Windows", () => {
		expect(fromTsv("a\tb\r\nc\td\r\n")).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	it("keeps an embedded newline inside a quoted field", () => {
		expect(fromTsv('"one\ntwo"\tx')).toEqual([["one\ntwo", "x"]]);
	});
});

describe("crc32", () => {
	it("matches the reference value", () => {
		expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
});

describe("xmlEscape", () => {
	it("escapes the five entities", () => {
		expect(xmlEscape("<a & \"b\" 'c'>")).toBe("&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
	});

	it("drops control characters that XML forbids", () => {
		expect(xmlEscape("a\u0000b\u0001c")).toBe("abc");
	});

	it("keeps tab, newline and carriage return", () => {
		expect(xmlEscape("a\tb\nc")).toBe("a\tb\nc");
	});
});

describe("sanitizeSheetName", () => {
	it("removes the characters Excel rejects", () => {
		expect(sanitizeSheetName("a/b:c*d?e[f]")).toBe("a b c d e f");
	});

	it("truncates at 31 characters", () => {
		expect(sanitizeSheetName("x".repeat(40))).toHaveLength(31);
	});

	it("falls back to a usable default", () => {
		expect(sanitizeSheetName("  ")).toBe("Sheet1");
	});
});

describe("styleIndex", () => {
	it("maps every combination to its own slot", () => {
		const seen = new Set<number>();
		for (const wrap of [false, true]) {
			for (const bold of [false, true]) {
				for (const align of [null, "center", "right"] as const) {
					seen.add(styleIndex(align, bold, wrap));
				}
			}
		}
		expect(seen.size).toBe(12);
		expect(Math.max(...seen)).toBe(11);
	});
});

describe("buildXlsx", () => {
	const model = parseTable("| Name | Qty |\n| --- | ---: |\n| Bolt & nut | 1 234,56 |\n| <tag> | text |\n");
	const bytes = buildXlsx(
		model,
		{ sheetName: "Table", content: "raw", detectNumbers: true, styleHeader: true, defaultColWidth: 120 },
		AT,
	);

	/** Walks the local file headers of a stored-only zip. */
	function entries(data: Uint8Array): Map<string, string> {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const decoder = new TextDecoder();
		const out = new Map<string, string>();
		let at = 0;
		while (at + 4 <= data.length && view.getUint32(at, true) === 0x04034b50) {
			const method = view.getUint16(at + 8, true);
			expect(method).toBe(0);
			const size = view.getUint32(at + 18, true);
			const nameLen = view.getUint16(at + 26, true);
			const extraLen = view.getUint16(at + 28, true);
			const name = decoder.decode(data.subarray(at + 30, at + 30 + nameLen));
			const body = data.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);
			expect(crc32(body)).toBe(view.getUint32(at + 14, true));
			out.set(name, decoder.decode(body));
			at += 30 + nameLen + extraLen + size;
		}
		return out;
	}

	it("is a zip with the parts a workbook needs", () => {
		const parts = entries(bytes);
		expect([...parts.keys()]).toEqual([
			"[Content_Types].xml",
			"_rels/.rels",
			"xl/workbook.xml",
			"xl/_rels/workbook.xml.rels",
			"xl/styles.xml",
			"xl/worksheets/sheet1.xml",
		]);
	});

	it("ends with a well-formed end-of-central-directory record", () => {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const eocd = bytes.length - 22;
		expect(view.getUint32(eocd, true)).toBe(0x06054b50);
		expect(view.getUint16(eocd + 10, true)).toBe(6);
		const cdOffset = view.getUint32(eocd + 16, true);
		expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
	});

	it("writes numeric cells as numbers and text as inline strings", () => {
		const sheet = entries(bytes).get("xl/worksheets/sheet1.xml") ?? "";
		expect(sheet).toContain('<c r="B2" s="2"><v>1234.56</v>');
		expect(sheet).toContain('<c r="B3" s="2" t="inlineStr">');
		expect(sheet).toContain("Bolt &amp; nut");
		expect(sheet).toContain("&lt;tag&gt;");
	});

	it("freezes the header row and sets the column widths", () => {
		const sheet = entries(bytes).get("xl/worksheets/sheet1.xml") ?? "";
		expect(sheet).toContain('state="frozen"');
		expect(sheet).toContain('ySplit="1"');
		expect(sheet).toContain('<col min="1" max="1"');
	});

	it("does not treat text as numeric when detection is off", () => {
		const plainBytes = buildXlsx(
			model,
			{ sheetName: "Table", content: "raw", detectNumbers: false, styleHeader: true, defaultColWidth: 120 },
			AT,
		);
		const sheet = entries(plainBytes).get("xl/worksheets/sheet1.xml") ?? "";
		expect(sheet).not.toContain("<v>1234.56</v>");
	});

	it("keeps a dotted date as text instead of stripping the dots", () => {
		const dated = parseTable("| When | Amount |\n| --- | ---: |\n| 07.07.2026 | 1 234,56 |\n");
		const sheet =
			entries(
				buildXlsx(
					dated,
					{ sheetName: "Table", content: "raw", detectNumbers: true, styleHeader: true, defaultColWidth: 120 },
					AT,
				),
			).get("xl/worksheets/sheet1.xml") ?? "";
		expect(sheet).toContain('<c r="A2" s="0" t="inlineStr"><is><t xml:space="preserve">07.07.2026</t>');
		expect(sheet).not.toContain("07072026");
		// The real number in the same row still converts.
		expect(sheet).toContain("<v>1234.56</v>");
	});

	it("is byte-for-byte reproducible for the same timestamp", () => {
		const again = buildXlsx(
			model,
			{ sheetName: "Table", content: "raw", detectNumbers: true, styleHeader: true, defaultColWidth: 120 },
			AT,
		);
		expect(Array.from(again)).toEqual(Array.from(bytes));
	});
});

describe("formula cells in exports", () => {
	const model = parseTable(
		"| Item | Qty |\n| --- | ---: |\n| a | 2 |\n| b | 3 |\n| **Total** | **5** %%=avg(B2:B3; 1)%% |\n| bad | 7 %%=1 +%% |\n| err | #DIV/0! %%=1/0%% |\n",
	);
	/** The archive is stored, not deflated, so its XML parts can be searched as text directly. */
	const unzip = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

	it("CSV writes the display value, with or without its Markdown", () => {
		const raw = buildCsv(model, { delimiter: ";", bom: false, content: "raw", crlf: false }).split("\n");
		expect(raw[3]).toBe("**Total**;**5**");
		expect(raw[4]).toBe("bad;7");
		const plain = buildCsv(model, { delimiter: ";", bom: false, content: "plain", crlf: false }).split("\n");
		expect(plain[3]).toBe("Total;5");
		expect(buildCsv(model, { delimiter: ";", bom: false, content: "raw", crlf: false })).not.toContain("%%");
	});

	it("XLSX writes the formula in Excel syntax with the cached value", () => {
		const bytes = buildXlsx(
			model,
			{ sheetName: "T", content: "raw", detectNumbers: true, styleHeader: true, defaultColWidth: 120 },
			AT,
		);
		const all = unzip(bytes);
		expect(all).toContain('<c r="B4" s="2"><f>AVERAGE(B2:B3,1)</f><v>5</v></c>');
		// A formula that does not parse goes out as its value only, never as a broken <f>.
		expect(all).toContain('<c r="B5" s="2"><v>7</v></c>');
		// An error display has no cached value; Excel computes it on load.
		expect(all).toContain('<c r="B6" s="2"><f>1/0</f></c>');
		expect(all).toContain('<calcPr fullCalcOnLoad="1"/>');
		expect(all).not.toContain("%%");
	});

	it("XLSX writes the formula even when number detection is off", () => {
		const bytes = buildXlsx(
			model,
			{ sheetName: "T", content: "plain", detectNumbers: false, styleHeader: true, defaultColWidth: 120 },
			AT,
		);
		expect(unzip(bytes)).toContain("<f>AVERAGE(B2:B3,1)</f><v>5</v>");
	});

	it("leaves a formula-free workbook without calcPr", () => {
		const bytes = buildXlsx(
			parseTable("| A |\n| --- |\n| 1 |\n"),
			{ sheetName: "T", content: "raw", detectNumbers: true, styleHeader: true, defaultColWidth: 120 },
			AT,
		);
		expect(unzip(bytes)).not.toContain("calcPr");
	});
});
