import { describe, expect, it } from "vitest";
import { formatNumber, isNumeric, parseNumber, stripInlineMarkdown } from "../src/model/numbers";

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
