import { describe, expect, it } from "vitest";
import {
	formatNumber,
	isoDateFromSerial,
	isoFromSerial,
	isNumeric,
	parseNumber,
	serialFromIsoDate,
	stripInlineMarkdown,
	stripObsidianComments,
} from "../src/model/numbers";

describe("stripInlineMarkdown", () => {
	it("removes balanced wrappers", () => {
		expect(stripInlineMarkdown("**42**")).toBe("42");
		expect(stripInlineMarkdown("*`42`*")).toBe("42");
		expect(stripInlineMarkdown("~~42~~")).toBe("42");
	});

	it("leaves unbalanced markers alone", () => {
		expect(stripInlineMarkdown("**42")).toBe("**42");
		expect(stripInlineMarkdown("1*2")).toBe("1*2");
	});
});

describe("parseNumber", () => {
	it("reads plain numbers", () => {
		expect(parseNumber("42")).toBe(42);
		expect(parseNumber("-3.5")).toBe(-3.5);
		expect(parseNumber("+7")).toBe(7);
		expect(parseNumber(".5")).toBe(0.5);
		expect(parseNumber("1e3")).toBe(1000);
	});

	it("reads the Czech grouped form, non-breaking spaces included", () => {
		expect(parseNumber("1 234,56")).toBeCloseTo(1234.56);
		expect(parseNumber("1 234,56")).toBeCloseTo(1234.56);
		expect(parseNumber("1 234,56")).toBeCloseTo(1234.56);
		expect(parseNumber("1.234.567")).toBe(1234567);
	});

	it("reads the English grouped form", () => {
		expect(parseNumber("1,234.56")).toBeCloseTo(1234.56);
		expect(parseNumber("1,234,567")).toBe(1234567);
	});

	it("treats a lone separator as decimal", () => {
		expect(parseNumber("1,5")).toBe(1.5);
		expect(parseNumber("1.5")).toBe(1.5);
		expect(parseNumber("1,234")).toBe(1.234);
	});

	it("honours an explicit decimal separator", () => {
		expect(parseNumber("1,234", { decimalSeparator: "." })).toBe(1.234);
		expect(parseNumber("1.234", { decimalSeparator: "," })).toBe(1.234);
	});

	it("sees through inline markdown and currency", () => {
		expect(parseNumber("**42**")).toBe(42);
		expect(parseNumber("1 234 Kč")).toBe(null);
		expect(parseNumber("€ 99,50")).toBeCloseTo(99.5);
	});

	it("reads percentages and accounting negatives", () => {
		expect(parseNumber("50%")).toBe(0.5);
		expect(parseNumber("(1 234,50)")).toBeCloseTo(-1234.5);
	});

	it("rejects anything that is not a number", () => {
		for (const text of ["", "abc", "12abc", "--3", "1.2.3.4a", "N/A", "-", "1 2 3 x"]) {
			expect(parseNumber(text)).toBe(null);
		}
	});

	it("keeps dates out of the numeric path", () => {
		// A dotted date used to lose its dots and export to Excel as 07072026.
		for (const text of ["07.07.2026", "7.7.2026", "1.1.99", "2026-07-07", "07/07/2026", "10.000.5"]) {
			expect(parseNumber(text)).toBe(null);
			expect(parseNumber(text, { decimalSeparator: "," })).toBe(null);
			expect(parseNumber(text, { decimalSeparator: "." })).toBe(null);
		}
	});

	it("still accepts well-formed grouping", () => {
		expect(parseNumber("1.234.567", { decimalSeparator: "," })).toBe(1234567);
		expect(parseNumber("12.345,60", { decimalSeparator: "," })).toBeCloseTo(12345.6);
		expect(parseNumber("1,234,567.89", { decimalSeparator: "." })).toBeCloseTo(1234567.89);
	});

	it("round-trips its own formatted output", () => {
		for (const locale of ["cs-CZ", "en-US", "de-DE"]) {
			const text = formatNumber(1234.56, 2, locale);
			expect(parseNumber(text)).toBeCloseTo(1234.56);
		}
	});
});

describe("isNumeric", () => {
	it("agrees with parseNumber", () => {
		expect(isNumeric("1 234,56")).toBe(true);
		expect(isNumeric("kilo")).toBe(false);
	});
});

describe("formatNumber", () => {
	it("respects the decimal count", () => {
		expect(formatNumber(1.5, 0, "en-US")).toBe("2");
		expect(formatNumber(1.5, 3, "en-US")).toBe("1.500");
	});

	it("falls back gracefully on a bad locale", () => {
		expect(formatNumber(1.5, 1, "not a locale")).toBe("1.5");
	});
});

describe("Obsidian comments", () => {
	it("are stripped when closed, kept when not", () => {
		expect(stripObsidianComments("1 %%a%% 2 %%b%%")).toBe("1  2 ");
		expect(stripObsidianComments("50%%")).toBe("50%%");
		expect(stripObsidianComments("plain")).toBe("plain");
	});

	it("do not stop a formula cell from counting as its value", () => {
		expect(parseNumber("1 250 %%=SUM(B2:B3)%%")).toBe(1250);
		expect(parseNumber("**1 234,5** %%=A1*2%%")).toBeCloseTo(1234.5);
		expect(parseNumber("%%=A1%% 7")).toBe(7);
		expect(parseNumber("%%=A1%%")).toBeNull();
		expect(parseNumber("#DIV/0! %%=1/0%%")).toBeNull();
		expect(isNumeric("12 %%note%%")).toBe(true);
	});
});

describe("dates and serials", () => {
	it("round-trips an ISO date through Excel's serial", () => {
		expect(serialFromIsoDate("2026-03-15")).toBe(46096);
		expect(isoDateFromSerial(46096)).toBe("2026-03-15");
		expect(isoFromSerial(46096)).toBe("2026-03-15");
	});

	it("keeps the time of day, without seconds when there are none", () => {
		expect(isoFromSerial(46096.625)).toBe("2026-03-15 15:00");
		expect(isoFromSerial(46096.500694)).toBe("2026-03-15 12:01");
	});

	it("reads a time-only serial as a time", () => {
		expect(isoFromSerial(0.5)).toBe("1899-12-30 12:00");
	});

	it("refuses what is not a date", () => {
		expect(serialFromIsoDate("2026-02-30")).toBeNull();
		expect(serialFromIsoDate("15. 3. 2026")).toBeNull();
		expect(serialFromIsoDate("2026-03-15 25:00")).toBeNull();
	});

	it("does not turn a date into a number for the rest of the grid", () => {
		// Sorting and the series filler read dates as dates; only a formula wants the serial.
		expect(parseNumber("2026-03-15")).toBeNull();
	});
});
