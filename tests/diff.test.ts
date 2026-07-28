import { describe, expect, it } from "vitest";
import { describeDiff, diffLines, diffStats, relativeTime, tableShape } from "../src/feature/diff";

const TABLE_A = ["| a   | b   |", "| --- | --- |", "| 1   | 2   |", "| 3   | 4   |"].join("\n");
const TABLE_B = ["| a   | b   |", "| --- | --- |", "| 1   | 9   |", "| 3   | 4   |", "| 5   | 6   |"].join("\n");

describe("diffLines", () => {
	it("reports nothing for identical texts", () => {
		const lines = diffLines(TABLE_A, TABLE_A);
		expect(lines.every((l) => l.kind === "same")).toBe(true);
		expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
		expect(describeDiff(diffStats(lines))).toBe("Identical to what the grid holds now");
	});

	it("ignores a trailing newline difference", () => {
		expect(diffStats(diffLines(TABLE_A, TABLE_A + "\n"))).toEqual({ added: 0, removed: 0 });
	});

	it("normalizes CRLF", () => {
		expect(diffStats(diffLines(TABLE_A.replace(/\n/g, "\r\n"), TABLE_A))).toEqual({ added: 0, removed: 0 });
	});

	it("pairs a changed line as one removal and one addition", () => {
		const lines = diffLines(TABLE_A, TABLE_B);
		expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
		expect(lines.filter((l) => l.kind === "remove").map((l) => l.text)).toEqual(["| 1   | 2   |"]);
		expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["| 1   | 9   |", "| 5   | 6   |"]);
	});

	it("keeps every line of both texts", () => {
		const lines = diffLines(TABLE_A, TABLE_B);
		const left = lines.filter((l) => l.kind !== "add").map((l) => l.text);
		const right = lines.filter((l) => l.kind !== "remove").map((l) => l.text);
		expect(left).toEqual(TABLE_A.split("\n"));
		expect(right).toEqual(TABLE_B.split("\n"));
	});

	it("numbers the lines on the side they belong to", () => {
		const lines = diffLines(TABLE_A, TABLE_B);
		for (const line of lines) {
			if (line.kind === "add") expect(line.left).toBeUndefined();
			if (line.kind === "remove") expect(line.right).toBeUndefined();
			if (line.kind === "same") expect(typeof line.left).toBe("number");
		}
	});

	it("handles an empty side", () => {
		expect(diffStats(diffLines("", TABLE_A))).toEqual({ added: 4, removed: 0 });
		expect(diffStats(diffLines(TABLE_A, ""))).toEqual({ added: 0, removed: 4 });
		expect(diffLines("", "")).toEqual([]);
	});

	it("falls back to a block replace past the LCS limit without losing lines", () => {
		const big = (fill: string) =>
			Array.from({ length: 700 }, (_, i) => `| ${fill}${i} |`).join("\n");
		const lines = diffLines(big("a"), big("b"));
		expect(diffStats(lines)).toEqual({ added: 700, removed: 700 });
	});
});

describe("relativeTime", () => {
	const now = 1_800_000_000_000;
	it("labels an age the way a person reads it", () => {
		expect(relativeTime(now, now)).toBe("Just now");
		expect(relativeTime(now - 30_000, now)).toBe("Just now");
		expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
		expect(relativeTime(now - 25 * 60_000, now)).toBe("25 minutes ago");
		expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
		expect(relativeTime(now - 50 * 3_600_000, now)).toBe("2 days ago");
	});

	it("never shows a negative age from a clock skew", () => {
		expect(relativeTime(now + 60_000, now)).toBe("Just now");
	});
});

describe("tableShape", () => {
	it("counts data rows and header columns", () => {
		expect(tableShape(TABLE_A)).toBe("3 × 2");
		expect(tableShape("")).toBe("0 × 0");
	});
});
