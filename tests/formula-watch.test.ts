import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type MarkdownSpreadsheetsSettings } from "../src/settings";
import { FormulaWatcher } from "../src/file/FormulaWatcher";

/**
 * The watcher is the one part of the plugin that writes without being asked, so its rules are
 * tested directly: only a note with a formula, never one that is open, and only when a value
 * actually changed.
 */
class FakeVault {
	text: string;
	writes = 0;

	constructor(text: string) {
		this.text = text;
	}

	async cachedRead(): Promise<string> {
		return this.text;
	}

	async process(_file: unknown, fn: (data: string) => string): Promise<string> {
		const next = fn(this.text);
		if (next !== this.text) {
			this.text = next;
			this.writes++;
		}
		return next;
	}

	getMarkdownFiles(): unknown[] {
		return [];
	}
}

const file = { path: "Note.md", extension: "md" } as never;

function watcherFor(vault: FakeVault, settings?: Partial<MarkdownSpreadsheetsSettings>, open = false): FormulaWatcher {
	const merged = { ...DEFAULT_SETTINGS, numberLocale: "en-US", ...settings };
	return new FormulaWatcher(
		vault as never,
		() => merged,
		() => open,
	);
}

describe("FormulaWatcher", () => {
	it("recalculates a note whose stored value is stale", async () => {
		const vault = new FakeVault("| A | B |\n| --- | --- |\n| 1 | 3 %%=1+1%% |\n");
		const written = await watcherFor(vault).run(file);
		expect(written).toBe(1);
		// A table that had to be written comes back in the configured layout, padding included.
		expect(vault.text.replace(/\s+/g, " ")).toContain("| 1 | 2 %%=1+1%% |");
	});

	it("leaves a note alone when every value is already right", async () => {
		const vault = new FakeVault("| A | B |\n| --- | --- |\n| 1 | 2 %%=1+1%% |\n");
		expect(await watcherFor(vault).run(file)).toBe(0);
		expect(vault.writes).toBe(0);
	});

	it("does not even read a note that has no formula", async () => {
		const vault = new FakeVault("| A |\n| --- |\n| plain |\n");
		expect(await watcherFor(vault).run(file)).toBe(0);
		expect(vault.writes).toBe(0);
	});

	it("never writes a note that is open in an editor or a grid", async () => {
		const vault = new FakeVault("| A |\n| --- |\n| 3 %%=1+1%% |\n");
		expect(await watcherFor(vault, {}, true).run(file)).toBe(0);
		expect(vault.writes).toBe(0);
	});

	it("respects the setting", async () => {
		const vault = new FakeVault("| A |\n| --- |\n| 3 %%=1+1%% |\n");
		expect(await watcherFor(vault, { recalculateInBackground: false }).run(file)).toBe(0);
		expect(vault.writes).toBe(0);
	});

	it("writes only the tables that changed, in a note with two of them", async () => {
		const vault = new FakeVault("| A |\n| --- |\n| 3 %%=1+1%% |\n\nText.\n\n| B |\n| --- |\n| 4 %%=2+2%% |\n");
		expect(await watcherFor(vault).run(file)).toBe(1);
		expect(vault.text.replace(/\s+/g, " ")).toContain("| 2 %%=1+1%% |");
		expect(vault.text.replace(/\s+/g, " ")).toContain("| 4 %%=2+2%% |");
	});

	it("renumbers TableN references when a table is inserted above another", async () => {
		const first = "| A |\n| --- |\n| 1 %%=Table2!B2%% |\n\n| B | C |\n| --- | --- |\n| 7 | 9 |\n";
		const vault = new FakeVault(first);
		const watcher = watcherFor(vault);
		await watcher.run(file);
		expect(vault.text).toContain("Table2!B2");

		// A new table at the top pushes both others down by one.
		vault.text = "| N |\n| --- |\n| 1 |\n\n" + first;
		await watcher.run(file);
		expect(vault.text).toContain("Table3!B2");
		expect(vault.text).not.toContain("Table2!B2");
	});
});
