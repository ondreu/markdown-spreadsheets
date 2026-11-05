import { describe, expect, it } from "vitest";
import {
	allRules,
	applyConditionalFormats,
	buildRuleComment,
	joinComments,
	parseRuleBody,
	ruleMatches,
	rulesInCell,
	splitComments,
	type ConditionalRule,
} from "../src/feature/conditional";
import { plainText } from "../src/feature/exportCsv";
import { buildWorkbookXlsx, DEFAULT_XLSX_OPTIONS, ruleFormula } from "../src/feature/exportXlsx";
import { buildFormulaCell } from "../src/feature/formula";
import { recalculateWorkbook } from "../src/feature/workbook";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";
import { getRaw, setRaw } from "../src/model/GridModel";
import { addInlineFormat, peelInline, removeInlineFormat } from "../src/feature/ops";

const AT = new Date(Date.UTC(2026, 6, 28, 12, 0, 0));

/** Reads the stored zip parts back as text — the archive is stored, not deflated. */
function zipParts(data: Uint8Array): Map<string, string> {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const decoder = new TextDecoder();
	const out = new Map<string, string>();
	let at = 0;
	while (at + 4 <= data.length && view.getUint32(at, true) === 0x04034b50) {
		const size = view.getUint32(at + 18, true);
		const nameLen = view.getUint16(at + 26, true);
		const extraLen = view.getUint16(at + 28, true);
		const name = decoder.decode(data.subarray(at + 30, at + 30 + nameLen));
		out.set(name, decoder.decode(data.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size)));
		at += 30 + nameLen + extraLen + size;
	}
	return out;
}

describe("the comment a cell carries", () => {
	it("splits the value from the comments without touching the emphasis", () => {
		expect(splitComments("**1 200** %%=D2*E2%% %%cf F2:F9 > 1000 bold%%")).toEqual({
			display: "**1 200**",
			comments: ["=D2*E2", "cf F2:F9 > 1000 bold"],
		});
	});

	it("keeps a %% pair in the middle of a value as text", () => {
		expect(splitComments("50%% off")).toEqual({ display: "50%% off", comments: [] });
	});

	it("round-trips through joinComments", () => {
		const raw = joinComments("1 200", ["=D2*E2", "cf >1000 bold"]);
		expect(raw).toBe("1 200 %%=D2*E2%% %%cf >1000 bold%%");
		expect(splitComments(raw).display).toBe("1 200");
	});
});

describe("the rule syntax", () => {
	it("reads a range, an operator, a value and a format", () => {
		expect(parseRuleBody("cf F2:F9 > 1000 bold")).toEqual({
			range: { r1: 1, c1: 5, r2: 8, c2: 5 },
			op: ">",
			value: "1000",
			format: "bold",
		});
	});

	it("reads a quoted value with a space in it", () => {
		expect(parseRuleBody('cf B2 contains "in progress" highlight')).toMatchObject({
			op: "contains",
			value: "in progress",
			format: "highlight",
		});
	});

	it("returns null for anything that is not a rule", () => {
		expect(parseRuleBody("cf blah")).toBeNull();
		expect(parseRuleBody("cf F2:F9 ~ 3 bold")).toBeNull();
		expect(parseRuleBody("cf F2:F9 > 3 wavy")).toBeNull();
		expect(parseRuleBody("cf F2:F9 > bold")).toBeNull();
	});

	it("writes the range only when the rule covers more than its own cell", () => {
		expect(buildRuleComment({ r1: 4, c1: 2, r2: 4, c2: 2, op: ">", value: "0", format: "bold" })).toBe("%%cf > 0 bold%%");
		expect(buildRuleComment({ r1: 4, c1: 2, r2: 6, c2: 2, op: ">", value: "0", format: "bold" })).toBe(
			"%%cf C5:C7 > 0 bold%%",
		);
		expect(buildRuleComment({ r1: 1, c1: 1, r2: 1, c2: 1, op: "contains", value: "in progress", format: "highlight" })).toBe(
			'%%cf contains "in progress" highlight%%',
		);
	});

	it("falls back to the cell the rule is written in", () => {
		const rules = rulesInCell("1 200 %%cf > 1000 bold%%", 3, 2);
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({ r1: 3, c1: 2, r2: 3, c2: 2, op: ">", value: "1000", format: "bold", row: 3, col: 2 });
	});

	it("ignores a malformed rule instead of rewriting it", () => {
		expect(rulesInCell("x %%cf > 1000 wavy%%", 0, 0)).toEqual([]);
	});
});

describe("matching", () => {
	const rule = (op: ConditionalRule["op"], value: string): ConditionalRule => ({
		r1: 1,
		c1: 1,
		r2: 1,
		c2: 1,
		op,
		value,
		format: "bold",
		row: 0,
		col: 0,
	});

	it("compares numbers in either direction", () => {
		expect(ruleMatches(rule(">", "1000"), "1200")).toBe(true);
		expect(ruleMatches(rule(">", "1000"), "999")).toBe(false);
		expect(ruleMatches(rule(">=", "1000"), "1000")).toBe(true);
		expect(ruleMatches(rule("<", "0"), "-5")).toBe(true);
		expect(ruleMatches(rule("<=", "0"), "1")).toBe(false);
		// The locale decides what a decimal mark is, exactly as it does for a formula.
		expect(ruleMatches(rule(">", "12,4"), "12,50", { decimalSeparator: "," })).toBe(true);
	});

	it("never matches a number against a cell that is not one", () => {
		expect(ruleMatches(rule(">", "0"), "")).toBe(false);
		expect(ruleMatches(rule(">", "0"), "n/a")).toBe(false);
		expect(ruleMatches(rule(">", "abc"), "5")).toBe(false);
	});

	it("compares text case-insensitively and only on equality or contains", () => {
		expect(ruleMatches(rule("=", "done"), "Done")).toBe(true);
		expect(ruleMatches(rule("<>", "done"), "Planned")).toBe(true);
		expect(ruleMatches(rule("contains", "progress"), "In progress")).toBe(true);
		expect(ruleMatches(rule("contains", "progress"), "Planned")).toBe(false);
	});
});

describe("applying the rules", () => {
	/** F2:F4 amounts, a bold rule above 1000, and the total row carrying the rule comment. */
	const table = (): ReturnType<typeof parseTable> =>
		parseTable(
			"| Item | Amount |\n| --- | ---: |\n| a | 1 200 |\n| b | 20 |\n| c | 3 500 |\n| Total | 4 720 %%=SUM(B2:B4)%% %%cf B2:B5 > 1000 bold%% |\n",
		);

	it("writes the format into the cells that match", () => {
		const model = table();
		const changed = applyConditionalFormats(model, {});
		expect(changed).toHaveLength(3);
		expect(getRaw(model, 1, 1)).toBe("**1 200**");
		expect(getRaw(model, 2, 1)).toBe("20");
		expect(getRaw(model, 3, 1)).toBe("**3 500**");
	});

	it("keeps the rule and the formula in the cell that carries them", () => {
		const model = table();
		applyConditionalFormats(model, {});
		const raw = getRaw(model, 4, 1);
		expect(raw).toContain("%%=SUM(B2:B4)%%");
		expect(raw).toContain("%%cf B2:B5 > 1000 bold%%");
		// The rule's own cell is inside its range, so it is formatted too — the total is 4 720.
		expect(raw.startsWith("**4 720**")).toBe(true);
	});

	it("is idempotent: a second pass changes nothing", () => {
		const model = table();
		applyConditionalFormats(model, {});
		const snapshot = serializeTable(model, { compact: false });
		expect(applyConditionalFormats(model, {})).toEqual([]);
		expect(serializeTable(model, { compact: false })).toBe(snapshot);
	});

	it("takes the format off when the value stops matching", () => {
		const model = table();
		applyConditionalFormats(model, {});
		setRaw(model, 1, 1, "800");
		expect(applyConditionalFormats(model, {})).toEqual([]);
		expect(getRaw(model, 1, 1)).toBe("800");
		// And a bold cell that no longer matches loses the mark, keeping its value.
		setRaw(model, 3, 1, "**100**");
		expect(applyConditionalFormats(model, {})).toEqual([{ row: 3, col: 1 }]);
		expect(getRaw(model, 3, 1)).toBe("100");
	});

	it("leaves a format the rule does not write alone", () => {
		const model = table();
		setRaw(model, 2, 1, "*20*");
		applyConditionalFormats(model, {});
		expect(getRaw(model, 2, 1)).toBe("*20*");
	});

	it("does not strip a manual mark from a cell a numeric rule cannot judge", () => {
		// A rule over F2:K9 reaches the Status column too; `**Done**` is text, so `> 1000` is not a
		// "no" — the mark has to survive.
		const model = parseTable("| Item | Cost | Status |\n| --- | ---: | --- |\n| a | 1 200 | **Done** |\n| b | 20 | In progress |\n");
		setRaw(model, 0, 1, "Cost %%cf B2:C3 > 1000 bold%%");
		applyConditionalFormats(model, {});
		expect(getRaw(model, 1, 2)).toBe("**Done**");
		expect(getRaw(model, 1, 1)).toBe("**1 200**");
	});

	it("writes a highlight as ==…==, which plainText already strips", () => {
		const model = parseTable("| Amount |\n| --- |\n| 1 200 %%cf > 1000 highlight%% |\n");
		applyConditionalFormats(model, {});
		expect(getRaw(model, 1, 0).startsWith("==1 200==")).toBe(true);
		expect(plainText(splitComments(getRaw(model, 1, 0)).display)).toBe("1 200");
	});

	it("survives being read back out of the note", () => {
		const model = table();
		applyConditionalFormats(model, {});
		const reparsed = parseTable(serializeTable(model, { compact: false }));
		expect(allRules(reparsed)).toHaveLength(1);
		expect(applyConditionalFormats(reparsed, {})).toEqual([]);
	});
});

describe("highlight as an inline format", () => {
	it("adds and removes == like the other wrappers", () => {
		expect(addInlineFormat("37 140", "highlight")).toBe("==37 140==");
		expect(removeInlineFormat("==37 140==", "highlight")).toBe("37 140");
		expect(peelInline("**==x==**").layers).toEqual(["**", "=="]);
	});
});

describe("conditional formatting in the workbook export", () => {
	const model = parseTable("| Item | Amount |\n| --- | ---: |\n| a | 1 200 |\n| b | 20 |\n| Total | 1 220 %%cf B2:B3 > 1000 bold%% |\n");

	it("carries the rule as Excel's own conditional formatting", () => {
		const parts = zipParts(
			buildWorkbookXlsx([{ name: "Budget", model }], { ...DEFAULT_XLSX_OPTIONS, content: "plain" }, AT),
		);
		const sheet = parts.get("xl/worksheets/sheet1.xml") ?? "";
		expect(sheet).toContain('<conditionalFormatting sqref="B2:B3">');
		expect(sheet).toContain("<formula>B2&gt;1000</formula>");
		expect(parts.get("xl/styles.xml") ?? "").toContain('<dxfs count="1"><dxf><font><b/></font></dxf></dxfs>');
	});

	it("writes nothing when the feature switch is off", () => {
		const parts = zipParts(
			buildWorkbookXlsx([{ name: "Budget", model }], { ...DEFAULT_XLSX_OPTIONS, content: "plain", conditional: false }, AT),
		);
		expect(parts.get("xl/worksheets/sheet1.xml") ?? "").not.toContain("conditionalFormatting");
		expect(parts.get("xl/styles.xml") ?? "").not.toContain("dxfs");
	});

	it("turns each operator into an expression Excel understands", () => {
		const base = { r1: 1, c1: 1 };
		expect(ruleFormula({ ...base, op: ">=", value: "10" })).toBe("B2>=10");
		expect(ruleFormula({ ...base, op: "=", value: "Done" })).toBe('B2="Done"');
		expect(ruleFormula({ ...base, op: "<>", value: "Done" })).toBe('B2<>"Done"');
		expect(ruleFormula({ ...base, op: "contains", value: "prog" })).toBe('ISNUMBER(SEARCH("prog",B2))');
	});

	it("leaves the formula comment out of the exported cell", () => {
		const parts = zipParts(
			buildWorkbookXlsx(
				[{ name: "Budget", model: parseTable("| A |\n| --- |\n| 5 %%cf > 1 bold%% %%=1+4%% |\n") }],
				{ ...DEFAULT_XLSX_OPTIONS, content: "plain" },
				AT,
			),
		);
		const sheet = parts.get("xl/worksheets/sheet1.xml") ?? "";
		expect(sheet).not.toContain("cf &");
		// The value is still a formula cell with its cached number.
		expect(sheet).toContain("<f>1+4</f><v>5</v>");
		expect(buildFormulaCell("5", "1+4")).toContain("%%=1+4%%");
	});
});

describe("a rule whose condition is a formula", () => {
	const table = () => parseTable("| Item | Amount |\n| --- | ---: |\n| a | 800 |\n| b | 1 200 |\n| c | 300 |\n");

	it("reads a composed expression after `if`, quotes and all", () => {
		expect(parseRuleBody('cf B2:B4 if AND(B2>1000;C2<>"x y") bold')).toMatchObject({
			op: "if",
			value: 'AND(B2>1000;C2<>"x y")',
			format: "bold",
		});
	});

	it("round-trips through the comment, and needs no range for one cell", () => {
		expect(buildRuleComment({ r1: 1, c1: 1, r2: 3, c2: 1, op: "if", value: "SUM($B$2:B2)>1500", format: "highlight" })).toBe(
			"%%cf B2:B4 if SUM($B$2:B2)>1500 highlight%%",
		);
		expect(buildRuleComment({ r1: 1, c1: 1, r2: 1, c2: 1, op: "if", value: "B2>10", format: "bold" })).toBe("%%cf if B2>10 bold%%");
	});

	it("is evaluated per cell, with the references shifted like Excel does", () => {
		const model = table();
		setRaw(model, 0, 1, "Amount %%cf B2:B4 if B2>1000 bold%%");
		applyConditionalFormats(model, {});
		expect(getRaw(model, 1, 1)).toBe("800");
		expect(getRaw(model, 2, 1)).toBe("**1 200**");
		expect(getRaw(model, 3, 1)).toBe("300");
	});

	it("keeps an absolute reference fixed across the range", () => {
		const model = table();
		// Running total: 800, 2 000, 2 300 — everything after the second row is above 1 500.
		setRaw(model, 0, 1, "Amount %%cf B2:B4 if SUM($B$2:B2)>1500 bold%%");
		applyConditionalFormats(model, {});
		expect(getRaw(model, 1, 1)).toBe("800");
		expect(getRaw(model, 2, 1)).toBe("**1 200**");
		expect(getRaw(model, 3, 1)).toBe("**300**");
	});

	it("takes any function, including IF and a comparison against another column", () => {
		const model = parseTable("| Item | Done | Amount |\n| --- | --- | ---: |\n| a | yes | 900 |\n| b | no | 1 200 |\n");
		setRaw(model, 0, 2, "Amount %%cf C2:C3 if IF(B2=\"yes\";C2>0;C2>1000) highlight%%");
		applyConditionalFormats(model, {});
		expect(getRaw(model, 1, 2)).toBe("==900==");
		expect(getRaw(model, 2, 2)).toBe("==1 200==");
	});

	it("leaves the cells alone when the expression cannot be evaluated", () => {
		const model = table();
		setRaw(model, 1, 1, "**800**");
		setRaw(model, 0, 1, "Amount %%cf B2:B4 if NOSUCHFN(B2) bold%%");
		expect(applyConditionalFormats(model, {})).toEqual([]);
		expect(getRaw(model, 1, 1)).toBe("**800**");
	});

	it("becomes the Excel expression, separators and all", () => {
		expect(ruleFormula({ r1: 1, c1: 1, op: "if", value: 'AND(B2>1000;C2<>"x")' })).toBe('AND(B2>1000,C2<>"x")');
		// A rule Excel cannot express is dropped from the file instead of breaking it.
		expect(ruleFormula({ r1: 1, c1: 1, op: "if", value: "B2 +" })).toBeNull();
	});
});

describe("a cross-table reference past the end of its table", () => {
	const source = parseTable("| A |\n| --- |\n| 1 |\n");

	it("is #REF! instead of a silent zero", () => {
		const model = parseTable("| T |\n| --- |\n| 0 %%=Table1!A9%% |\n");
		const result = recalculateWorkbook([source, model], { numberOpts: {}, format: (v) => String(v) });
		expect(result.errors.some((issue) => issue.code === "#REF!")).toBe(true);
		expect(getRaw(model, 1, 0)).toContain("#REF!");
	});

	it("still reads what exists when a range runs past the end", () => {
		const model = parseTable("| T |\n| --- |\n| 0 %%=SUM(Table1!A1:A99)%% |\n");
		recalculateWorkbook([source, model], { numberOpts: {}, format: (v) => String(v) });
		expect(getRaw(model, 1, 0)).toBe("1 %%=SUM(Table1!A1:A99)%%");
	});
});
