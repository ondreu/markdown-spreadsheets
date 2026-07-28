import { describe, expect, it } from "vitest";
import { scanTables } from "../src/file/scanTables";
import { DECISIVE_MARGIN, anchorFromRegion, resolveAnchor, scoreRegion, type Anchor } from "../src/file/AnchorResolver";

const NOTE = `---
title: has a | pipe in front matter
---

# Projekt

Some prose.

| Name | Qty |
| --- | --- |
| Bolt | 10 |
| Nut | 20 |

## Second section

\`\`\`
| not | a | table |
| --- | --- | --- |
\`\`\`

| Name | Qty |
| --- | --- |
| Screw | 5 |
`;

describe("scanTables", () => {
	it("finds both real tables and neither decoy", () => {
		const tables = scanTables(NOTE);
		expect(tables).toHaveLength(2);
		expect(tables[0].rowCount).toBe(3);
		expect(tables[1].rowCount).toBe(2);
	});

	it("ignores tables inside fenced code blocks", () => {
		const tables = scanTables(NOTE);
		for (const t of tables) expect(t.text).not.toContain("not | a | table");
	});

	it("ignores pipes in YAML front matter", () => {
		const tables = scanTables(NOTE);
		expect(tables[0].startLine).toBeGreaterThan(3);
	});

	it("records the nearest heading above each table", () => {
		const tables = scanTables(NOTE);
		expect(tables[0].precedingHeading).toBe("Projekt");
		expect(tables[1].precedingHeading).toBe("Second section");
	});

	it("gives identical headers the same hash", () => {
		const tables = scanTables(NOTE);
		expect(tables[0].headerHash).toBe(tables[1].headerHash);
	});

	it("gives the line bounds of the block, alignment row included", () => {
		const lines = NOTE.split("\n");
		const region = scanTables(NOTE)[0];
		expect(lines[region.startLine]).toContain("Name");
		expect(lines[region.endLine]).toContain("Nut");
		expect(region.text.split("\n")).toHaveLength(4);
	});

	it("picks up a block ID on the line after the table", () => {
		const text = "| A |\n| --- |\n| 1 |\n^grid-a7f3\n";
		expect(scanTables(text)[0].blockId).toBe("grid-a7f3");
	});

	it("stops a table at a blank line", () => {
		const text = "| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |\n";
		expect(scanTables(text)).toHaveLength(2);
	});

	it("does not mistake an alignment row for a header", () => {
		const text = "| --- |\n| --- |\n";
		expect(scanTables(text)).toHaveLength(0);
	});

	it("returns nothing for a note with no tables", () => {
		expect(scanTables("# Just prose\n\nWith a | pipe.\n")).toHaveLength(0);
	});
});

describe("resolveAnchor", () => {
	it("short-circuits when the file has exactly one table (layer 1)", () => {
		const text = "| Totally | Different |\n| --- | --- |\n| 1 | 2 |\n";
		const anchor: Anchor = { path: "n.md", tableIndex: 7, headerHash: "deadbeef", colCount: 99, rowCount: 99 };
		const result = resolveAnchor(text, anchor);
		expect(result.kind).toBe("resolved");
	});

	it("reports missing when there is no table at all", () => {
		const anchor: Anchor = { path: "n.md", tableIndex: 0, headerHash: "x", colCount: 1, rowCount: 1 };
		expect(resolveAnchor("no tables here\n", anchor).kind).toBe("missing");
	});

	it("uses the preceding heading to separate two identical headers", () => {
		const anchor = anchorFromRegion("n.md", scanTables(NOTE)[0]);
		const result = resolveAnchor(NOTE, anchor);
		expect(result.kind).toBe("resolved");
		if (result.kind === "resolved") expect(result.region.text).toContain("Bolt");
	});

	it("asks the user when two tables are genuinely indistinguishable", () => {
		// Identical header, identical shape, same heading above both: nothing left to score on
		// except position, which is exactly the case §7 says must not be guessed.
		const twins = "# Same\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
		const anchor = anchorFromRegion("n.md", scanTables(twins)[1]);
		const result = resolveAnchor(twins, anchor);
		expect(result.kind).toBe("ambiguous");
		if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
	});

	it("still finds the right table after text is inserted above it", () => {
		const shifted = "Extra paragraph.\n\nAnother one.\n\n" + NOTE;
		const anchor = anchorFromRegion("n.md", scanTables(NOTE)[1]);
		const result = resolveAnchor(shifted, anchor);
		if (result.kind !== "resolved") {
			// Ambiguity is acceptable here; what must never happen is a wrong confident match.
			expect(result.kind).toBe("ambiguous");
			return;
		}
		expect(result.region.text).toContain("Screw");
	});

	it("resolves confidently when the headers differ", () => {
		const text = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| X | Y | Z |\n| --- | --- | --- |\n| 3 | 4 | 5 |\n";
		const anchor = anchorFromRegion("n.md", scanTables(text)[1]);
		const result = resolveAnchor(text, anchor);
		expect(result.kind).toBe("resolved");
		if (result.kind === "resolved") expect(result.region.text).toContain("X");
	});

	it("lets a block ID win outright", () => {
		const text = "| A | B |\n| --- | --- |\n| 1 | 2 |\n^grid-keep\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
		const anchor: Anchor = {
			path: "n.md",
			// Deliberately wrong index and shape: the block ID must override all of it.
			tableIndex: 1,
			headerHash: "0",
			colCount: 0,
			rowCount: 0,
			blockId: "grid-keep",
		};
		const result = resolveAnchor(text, anchor);
		expect(result.kind).toBe("resolved");
		if (result.kind === "resolved") expect(result.region.index).toBe(0);
	});
});

describe("scoreRegion", () => {
	const text = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
	const regions = scanTables(text);

	it("weights the header hash above everything short of a block ID", () => {
		const anchor: Anchor = { path: "n.md", tableIndex: 0, headerHash: regions[0].headerHash, colCount: 2, rowCount: 2 };
		expect(scoreRegion(anchor, regions[0])).toBeGreaterThan(scoreRegion(anchor, regions[1]));
	});

	it("penalises positional distance", () => {
		const anchor: Anchor = { path: "n.md", tableIndex: 0, headerHash: "none", colCount: 0, rowCount: 0 };
		expect(scoreRegion(anchor, regions[0])).toBeGreaterThan(scoreRegion(anchor, regions[1]));
	});

	it("rewards a matching preceding heading", () => {
		const withHeadings = "# One\n\n| A |\n| --- |\n| 1 |\n\n# Two\n\n| A |\n| --- |\n| 1 |\n";
		const list = scanTables(withHeadings);
		const anchor: Anchor = {
			path: "n.md",
			tableIndex: 1,
			headerHash: list[1].headerHash,
			colCount: 1,
			rowCount: 2,
			precedingHeading: "Two",
		};
		expect(scoreRegion(anchor, list[1]) - scoreRegion(anchor, list[0])).toBeGreaterThanOrEqual(DECISIVE_MARGIN);
	});
});
