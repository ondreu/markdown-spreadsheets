import { describe, expect, it } from "vitest";
import { getRaw } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { fillRange, type FillDirection } from "../src/feature/ops";
import { detectSeries } from "../src/feature/series";

/** The next `count` values after the source, as fill down would write them. */
function continueSeries(values: string[], count = 3): string[] {
	const fn = detectSeries(values);
	if (!fn) throw new Error(`no series for ${values.join(", ")}`);
	return Array.from({ length: count }, (_, i) => fn(values.length + i));
}

/** Builds a one-column table, fills it in `direction`, and returns the column. */
function fillColumn(values: string[], extra: number, direction: FillDirection = "down"): string[] {
	const pad = direction === "up" ? extra : 0;
	const lines = ["| H |", "| --- |"];
	for (let i = 0; i < pad; i++) lines.push("|  |");
	for (const v of values) lines.push(`| ${v} |`);
	const model = parseTable(lines.join("\n") + "\n");
	const r1 = 1 + pad;
	const r2 = r1 + values.length - 1;
	const target = direction === "down" ? { r1, c1: 0, r2: r2 + extra, c2: 0 } : { r1: 1, c1: 0, r2, c2: 0 };
	fillRange(model, { r1, c1: 0, r2, c2: 0 }, target, direction);
	const out: string[] = [];
	for (let r = 1; r < model.usedRange.rows; r++) out.push(getRaw(model, r, 0));
	return out;
}

describe("detectSeries: numbers", () => {
	it("continues a constant step", () => {
		expect(continueSeries(["1", "3"])).toEqual(["5", "7", "9"]);
		expect(continueSeries(["0.1", "0.2"])).toEqual(["0.3", "0.4", "0.5"]);
	});

	it("copies a single number and an irregular sequence", () => {
		expect(detectSeries(["7"])).toBeNull();
		expect(detectSeries(["$5"])).toBeNull();
		expect(detectSeries(["1", "2", "4"])).toBeNull();
	});

	it("does not treat a gap as part of a series", () => {
		expect(detectSeries(["Item 1", ""])).toBeNull();
	});
});

describe("detectSeries: dates", () => {
	it("steps a single ISO date by one day, across month and year ends", () => {
		expect(continueSeries(["2026-12-30"])).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
		expect(continueSeries(["2028-02-28"], 2)).toEqual(["2028-02-29", "2028-03-01"]);
	});

	it("keeps a day step from two ISO dates", () => {
		expect(continueSeries(["2026-01-01", "2026-01-08"], 2)).toEqual(["2026-01-15", "2026-01-22"]);
	});

	it("steps by months when the day of month is equal", () => {
		expect(continueSeries(["2026-01-15", "2026-02-15"])).toEqual(["2026-03-15", "2026-04-15", "2026-05-15"]);
		expect(continueSeries(["2026-11-01", "2027-01-01"], 2)).toEqual(["2027-03-01", "2027-05-01"]);
	});

	it("clamps the 31st to the end of a short month", () => {
		expect(continueSeries(["2026-01-31", "2026-03-31"], 2)).toEqual(["2026-05-31", "2026-07-31"]);
		expect(continueSeries(["2025-12-31", "2026-01-31"], 1)).toEqual(["2026-02-28"]);
	});

	it("rejects an invalid date as a date", () => {
		expect(detectSeries(["2026-02-30"])).not.toBeNull(); // still text ending in a number
		expect(continueSeries(["2026-02-30"], 1)).toEqual(["2026-02-31"]);
	});

	it("continues Czech dotted dates preserving width and spacing", () => {
		expect(continueSeries(["31.1.2026"], 2)).toEqual(["1.2.2026", "2.2.2026"]);
		expect(continueSeries(["30.01.2026"], 3)).toEqual(["31.01.2026", "01.02.2026", "02.02.2026"]);
		expect(continueSeries(["1. 2. 2026"], 1)).toEqual(["2. 2. 2026"]);
		expect(continueSeries(["1.1.2026", "1.2.2026"], 2)).toEqual(["1.3.2026", "1.4.2026"]);
	});
});

describe("detectSeries: names", () => {
	it("continues English weekdays and months, preserving case", () => {
		expect(continueSeries(["Mon"])).toEqual(["Tue", "Wed", "Thu"]);
		expect(continueSeries(["SATURDAY"], 2)).toEqual(["SUNDAY", "MONDAY"]);
		expect(continueSeries(["nov"], 3)).toEqual(["dec", "jan", "feb"]);
		expect(continueSeries(["May", "June"], 1)).toEqual(["July"]);
		expect(continueSeries(["May"], 1)).toEqual(["Jun"]);
	});

	it("continues Czech names", () => {
		expect(continueSeries(["pondělí"], 2)).toEqual(["úterý", "středa"]);
		expect(continueSeries(["Leden"], 2)).toEqual(["Únor", "Březen"]);
		expect(continueSeries(["Červen"], 2)).toEqual(["Červenec", "Srpen"]);
		expect(continueSeries(["po", "st"], 2)).toEqual(["pá", "ne"]);
	});

	it("keeps a step greater than one", () => {
		expect(continueSeries(["Jan", "Apr"], 3)).toEqual(["Jul", "Oct", "Jan"]);
	});

	it("does not turn a lone Czech word into a weekday", () => {
		expect(detectSeries(["ne"])).toBeNull();
		expect(detectSeries(["pro"])).toBeNull();
	});
});

describe("detectSeries: text ending in a number", () => {
	it("counts on from a single cell", () => {
		expect(continueSeries(["Item 9"], 2)).toEqual(["Item 10", "Item 11"]);
		expect(continueSeries(["Q1"], 3)).toEqual(["Q2", "Q3", "Q4"]);
	});

	it("keeps zero padding", () => {
		expect(continueSeries(["A-007"], 3)).toEqual(["A-008", "A-009", "A-010"]);
		expect(continueSeries(["A-098"], 3)).toEqual(["A-099", "A-100", "A-101"]);
	});

	it("uses the step of several cells and needs a common prefix", () => {
		expect(continueSeries(["Run 5", "Run 10"], 2)).toEqual(["Run 15", "Run 20"]);
		expect(detectSeries(["A1", "B2"])).toBeNull();
	});

	it("copies plain text", () => {
		expect(detectSeries(["hello"])).toBeNull();
	});
});

describe("fillRange with series", () => {
	it("fills dates down", () => {
		expect(fillColumn(["2026-01-30"], 3)).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
	});

	it("fills up backwards", () => {
		expect(fillColumn(["Wed"], 2, "up")).toEqual(["Mon", "Tue", "Wed"]);
		expect(fillColumn(["Item 3", "Item 4"], 2, "up")).toEqual(["Item 1", "Item 2", "Item 3", "Item 4"]);
		expect(fillColumn(["1.3.2026"], 1, "up")).toEqual(["28.2.2026", "1.3.2026"]);
	});

	it("fills left backwards", () => {
		const model = parseTable("|  |  | Q3 |\n| --- | --- | --- |\n");
		fillRange(model, { r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 0, r2: 0, c2: 2 }, "left");
		expect([0, 1, 2].map((c) => getRaw(model, 0, c))).toEqual(["Q1", "Q2", "Q3"]);
	});

	it("still copies a single number and repeats a text pattern", () => {
		expect(fillColumn(["7"], 2)).toEqual(["7", "7", "7"]);
		expect(fillColumn(["x", "y"], 3)).toEqual(["x", "y", "x", "y", "x"]);
	});
});
