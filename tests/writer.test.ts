import { describe, expect, it } from "vitest";
import type { TFile, Vault } from "obsidian";
import { anchorFromRegion } from "../src/file/AnchorResolver";
import { scanTables } from "../src/file/scanTables";
import { Writer, regionHash } from "../src/file/Writer";
import { recomputeUsedRange, setRaw } from "../src/model/GridModel";
import { parseTable } from "../src/model/parse";
import { serializeTable } from "../src/model/serialize";

/**
 * Minimal stand-in for the pieces of `Vault` the writer touches.
 *
 * `process` is modelled the way Obsidian implements it — read, transform, write, atomically —
 * because the whole point of §13.1 is that no other writer can slip in between.
 */
class FakeVault {
	writes = 0;

	constructor(public text: string) {}

	process(_file: TFile, fn: (data: string) => string): Promise<string> {
		const next = fn(this.text);
		if (next !== this.text) this.writes++;
		this.text = next;
		return Promise.resolve(next);
	}

	cachedRead(_file: TFile): Promise<string> {
		return Promise.resolve(this.text);
	}
}

const FILE = { path: "Notes/Projekt.md", basename: "Projekt" } as TFile;

function setup(text: string) {
	const vault = new FakeVault(text);
	const writer = new Writer(vault as unknown as Vault);
	const region = scanTables(text)[0];
	return { vault, writer, region, anchor: anchorFromRegion(FILE.path, region), hash: regionHash(region.text) };
}

const NOTE = `# Projekt

Intro paragraph.

| Name | Qty |
| ---- | --- |
| Bolt | 10 |

Closing paragraph.
`;

describe("Writer.write", () => {
	it("replaces exactly the table lines and nothing else", async () => {
		const { vault, writer, anchor, hash } = setup(NOTE);
		const model = parseTable(scanTables(NOTE)[0].text);
		model.cells.set("1:1", { raw: "99" });

		const outcome = await writer.write(FILE, anchor, serializeTable(model), hash);
		expect(outcome.kind).toBe("written");
		expect(vault.text).toContain("Intro paragraph.");
		expect(vault.text).toContain("Closing paragraph.");
		expect(vault.text).toContain("| 99  |");
		expect(vault.text.startsWith("# Projekt\n")).toBe(true);
		expect(vault.text.endsWith("Closing paragraph.\n")).toBe(true);
	});

	it("does not touch the file when the region already matches", async () => {
		const { vault, writer, anchor, hash, region } = setup(NOTE);
		const outcome = await writer.write(FILE, anchor, region.text, hash);
		expect(outcome.kind).toBe("unchanged");
		expect(vault.writes).toBe(0);
		expect(vault.text).toBe(NOTE);
	});

	it("refuses to write when the region changed underneath (§13.1)", async () => {
		const { vault, writer, anchor, hash } = setup(NOTE);
		// Somebody else edits the same lines while the grid holds its own version.
		vault.text = vault.text.replace("| Bolt | 10 |", "| Bolt | 11 |");
		const before = vault.text;

		const model = parseTable(scanTables(NOTE)[0].text);
		model.cells.set("1:1", { raw: "99" });
		const outcome = await writer.write(FILE, anchor, serializeTable(model), hash);

		expect(outcome.kind).toBe("conflict");
		expect(vault.text).toBe(before);
		expect(vault.writes).toBe(0);
		if (outcome.kind === "conflict") expect(outcome.currentText).toContain("11");
	});

	it("still writes when the change was elsewhere in the note", async () => {
		const { vault, writer, anchor, hash } = setup(NOTE);
		// Text inserted above the table shifts every line number (§7, layer 0).
		vault.text = "New first paragraph.\n\nAnd another.\n\n" + vault.text;

		const model = parseTable(scanTables(NOTE)[0].text);
		model.cells.set("1:1", { raw: "42" });
		const outcome = await writer.write(FILE, anchor, serializeTable(model), hash);

		expect(outcome.kind).toBe("written");
		expect(vault.text).toContain("New first paragraph.");
		expect(vault.text).toContain("And another.");
		expect(vault.text).toContain("| 42  |");
		expect(vault.text).toContain("Closing paragraph.");
	});

	it("reports the returned anchor at the table's new position", async () => {
		const { vault, writer, anchor, hash } = setup(NOTE);
		vault.text = "Shifted.\n\n" + vault.text;
		const model = parseTable(scanTables(NOTE)[0].text);
		setRaw(model, 2, 0, "Nut");
		recomputeUsedRange(model);
		const outcome = await writer.write(FILE, anchor, serializeTable(model), hash);
		expect(outcome.kind).toBe("written");
		if (outcome.kind === "written") {
			expect(outcome.region.startLine).toBe(6);
			expect(outcome.anchor.rowCount).toBe(3);
		}
	});

	it("reports a vanished table without writing", async () => {
		const { vault, writer, anchor, hash } = setup(NOTE);
		vault.text = "# Projekt\n\nThe table is gone.\n";
		const outcome = await writer.write(FILE, anchor, "| A |\n| --- |\n", hash);
		expect(outcome.kind).toBe("missing");
		expect(vault.writes).toBe(0);
	});

	it("asks rather than guesses when the note became ambiguous", async () => {
		const twins = "# Same\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
		const { vault, writer, anchor, hash } = setup(twins);
		// Re-anchor onto the second twin so the resolver has two equal candidates.
		const second = anchorFromRegion(FILE.path, scanTables(twins)[1]);
		const outcome = await writer.write(FILE, second, "| A | B |\n| --- | --- |\n| 9 | 9 |\n", hash);
		expect(outcome.kind).toBe("ambiguous");
		expect(vault.text).toBe(twins);
		void anchor;
	});

	it("keeps CRLF line endings", async () => {
		const crlf = NOTE.split("\n").join("\r\n");
		const { vault, writer, anchor } = setup(crlf);
		const region = scanTables(crlf)[0];
		const model = parseTable(region.text);
		model.cells.set("1:1", { raw: "77" });
		const outcome = await writer.write(FILE, anchor, serializeTable(model), regionHash(region.text));
		expect(outcome.kind).toBe("written");
		expect(vault.text).toContain("\r\n");
		expect(vault.text).not.toMatch(/[^\r]\n/);
	});

	it("leaves the line endings of the rest of a mixed note alone", async () => {
		// CRLF above the table, LF inside and below it: a note stitched together by two editors.
		const mixed = "# Projekt\r\n\r\nIntro.\r\n\r\n| Name | Qty |\n| ---- | --- |\n| Bolt | 10 |\n\nClosing.\r\n";
		const { vault, writer, anchor } = setup(mixed);
		const region = scanTables(mixed)[0];
		const model = parseTable(region.text);
		model.cells.set("1:1", { raw: "77" });
		const outcome = await writer.write(FILE, anchor, serializeTable(model), regionHash(region.text));
		expect(outcome.kind).toBe("written");
		expect(vault.text.startsWith("# Projekt\r\n\r\nIntro.\r\n\r\n| Name")).toBe(true);
		expect(vault.text.endsWith("|\n\nClosing.\r\n")).toBe(true);
		expect(vault.text).toContain("| Bolt | 77  |\n");
	});

	it("writes a table that ends the file without a trailing newline", async () => {
		const text = "Intro\n\n| A |\n| --- |\n| 1 |";
		const { vault, writer, anchor, hash } = setup(text);
		const model = parseTable(scanTables(text)[0].text);
		model.cells.set("1:0", { raw: "2" });
		const outcome = await writer.write(FILE, anchor, serializeTable(model), hash);
		expect(outcome.kind).toBe("written");
		expect(vault.text).toBe("Intro\n\n| A   |\n| --- |\n| 2   |");
	});

	it("survives repeated edit-and-write cycles without drifting", async () => {
		const { vault, writer } = setup(NOTE);
		let anchor = anchorFromRegion(FILE.path, scanTables(NOTE)[0]);
		let hash = regionHash(scanTables(NOTE)[0].text);

		for (let i = 0; i < 5; i++) {
			const model = parseTable(scanTables(vault.text)[0].text);
			model.cells.set(`1:1`, { raw: String(i) });
			const outcome = await writer.write(FILE, anchor, serializeTable(model), hash);
			expect(outcome.kind).toBe("written");
			if (outcome.kind !== "written") return;
			anchor = outcome.anchor;
			hash = regionHash(outcome.region.text);
		}
		expect(vault.text).toContain("| 4   |");
		expect(vault.text).toContain("Intro paragraph.");
		expect(vault.text).toContain("Closing paragraph.");
		expect(scanTables(vault.text)).toHaveLength(1);
	});
});

describe("Writer.appendTable", () => {
	it("appends the table with a blank line before it", async () => {
		const vault = new FakeVault("# Projekt\n\nJust prose.\n");
		const writer = new Writer(vault as unknown as Vault);
		const region = await writer.appendTable(FILE, "| A |\n| --- |\n| 1 |\n");
		expect(region).not.toBeNull();
		expect(vault.text).toBe("# Projekt\n\nJust prose.\n\n| A |\n| --- |\n| 1 |\n");
		expect(scanTables(vault.text)).toHaveLength(1);
	});

	it("works on an empty note", async () => {
		const vault = new FakeVault("");
		const writer = new Writer(vault as unknown as Vault);
		await writer.appendTable(FILE, "| A |\n| --- |\n");
		expect(scanTables(vault.text)).toHaveLength(1);
	});
});

describe("Writer.addBlockId", () => {
	it("puts the marker on its own line, with a blank line on either side", async () => {
		const { vault, writer, anchor } = setup(NOTE);
		expect(await writer.addBlockId(FILE, anchor, "grid-a7f3")).toBe(true);
		const lines = vault.text.split("\n");
		expect(lines.slice(6, 11)).toEqual(["| Bolt | 10 |", "", "^grid-a7f3", "", "Closing paragraph."]);
		expect(scanTables(vault.text)[0].blockId).toBe("grid-a7f3");
	});

	it("adds the blank line after the marker when text follows the table directly", async () => {
		const text = "| A |\n| --- |\n| 1 |\nText\n";
		const { vault, writer, anchor } = setup(text);
		await writer.addBlockId(FILE, anchor, "grid-b1");
		expect(vault.text).toBe("| A |\n| --- |\n| 1 |\n\n^grid-b1\n\nText\n");
		expect(scanTables(vault.text)[0].blockId).toBe("grid-b1");
	});

	it("works on a table that ends the file without a newline", async () => {
		const text = "| A |\n| --- |\n| 1 |";
		const { vault, writer, anchor } = setup(text);
		await writer.addBlockId(FILE, anchor, "grid-c2");
		expect(vault.text).toBe("| A |\n| --- |\n| 1 |\n\n^grid-c2");
		expect(scanTables(vault.text)[0].blockId).toBe("grid-c2");
	});

	it("is idempotent once a marker exists", async () => {
		const { vault, writer, anchor } = setup(NOTE);
		await writer.addBlockId(FILE, anchor, "grid-a7f3");
		const after = vault.text;
		const reanchored = anchorFromRegion(FILE.path, scanTables(after)[0]);
		expect(await writer.addBlockId(FILE, reanchored, "grid-other")).toBe(true);
		expect(vault.text).toBe(after);
	});

	it("keeps the table findable by the marker after unrelated edits", async () => {
		const { vault, writer, anchor } = setup(NOTE);
		await writer.addBlockId(FILE, anchor, "grid-a7f3");
		vault.text = vault.text.replace("| Name | Qty |", "| Item | Count |");
		const outcome = await writer.readRegion(FILE, Object.assign({}, anchor, { blockId: "grid-a7f3" }));
		// The header changed, so the fingerprint alone would have failed; the marker still hits.
		expect(outcome.kind).toBe("unchanged");
		if (outcome.kind === "unchanged") expect(outcome.region.blockId).toBe("grid-a7f3");
	});
});

describe("Writer.reformatAll", () => {
	it("rewrites every table and leaves the text between them alone", async () => {
		const text = "# A\r\n\r\n|a|b|\r\n|-|-|\r\n|1|2|\r\n\r\nMiddle.\r\n\r\n| x |\r\n| --- |\r\n| 1   |\r\n";
		const vault = new FakeVault(text);
		const writer = new Writer(vault as unknown as Vault);
		const n = await writer.reformatAll(FILE, (t) => serializeTable(parseTable(t)));
		expect(n).toBe(2);
		expect(vault.text).toBe("# A\r\n\r\n| a   | b   |\r\n| --- | --- |\r\n| 1   | 2   |\r\n\r\nMiddle.\r\n\r\n| x   |\r\n| --- |\r\n| 1   |\r\n");
	});

	it("does not touch a note whose tables are already formatted", async () => {
		const vault = new FakeVault(NOTE);
		const writer = new Writer(vault as unknown as Vault);
		await writer.reformatAll(FILE, (t) => t);
		expect(vault.writes).toBe(0);
	});
});

describe("regionHash", () => {
	it("ignores trailing whitespace and line-ending differences", () => {
		expect(regionHash("| A |\n| --- |\n")).toBe(regionHash("| A |   \r\n| --- |\r\n"));
	});

	it("changes when a cell changes", () => {
		expect(regionHash("| A |\n| --- |\n| 1 |\n")).not.toBe(regionHash("| A |\n| --- |\n| 2 |\n"));
	});
});
