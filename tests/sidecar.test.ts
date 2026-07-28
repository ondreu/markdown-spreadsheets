import { beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";
import { BACKUP_COALESCE_MS, MAX_BACKUPS, Sidecar } from "../src/store/Sidecar";

/**
 * `Sidecar` only imports `Plugin` as a type, so the two methods it needs can be faked and the
 * whole class is testable outside Obsidian.
 */
function fakePlugin(): { plugin: Plugin; saved: () => Record<string, unknown> | null } {
	let stored: Record<string, unknown> | null = null;
	const plugin = {
		loadData: () => Promise.resolve(stored),
		saveData: (data: Record<string, unknown>) => {
			stored = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
			return Promise.resolve();
		},
	} as unknown as Plugin;
	return { plugin, saved: () => stored };
}

const T0 = 1_800_000_000_000;
const KEY = "note.md::0";

/**
 * `queueSave` coalesces through `window.setTimeout` — `prefer-window-timers` (§15.2) requires the
 * `window.` form — and the tests run in plain Node with no DOM. The timer is not what is under
 * test, so a two-method shim is enough.
 */
function shimWindowTimers(): void {
	const g = globalThis as unknown as { window?: unknown };
	g.window = { setTimeout: () => 0, clearTimeout: () => undefined };
}

describe("Sidecar backups", () => {
	let sidecar: Sidecar;

	beforeEach(async () => {
		shimWindowTimers();
		sidecar = new Sidecar(fakePlugin().plugin);
		await sidecar.load();
	});

	it("ignores a write that changes nothing", () => {
		sidecar.pushBackup(KEY, "a", T0);
		sidecar.pushBackup(KEY, "a", T0 + 10 * BACKUP_COALESCE_MS);
		expect(sidecar.getBackups(KEY)).toHaveLength(1);
	});

	it("coalesces a burst of autosaves into one version", () => {
		// What a minute of typing produces: a write every 800 ms.
		for (let i = 0; i < 40; i++) sidecar.pushBackup(KEY, `text ${i}`, T0 + i * 800);
		const backups = sidecar.getBackups(KEY);
		expect(backups).toHaveLength(1);
		// The slot holds the latest text but the timestamp of when the burst started.
		expect(backups[0].text).toBe("text 39");
		expect(backups[0].at).toBe(T0);
	});

	it("starts a new version once the writes are far enough apart", () => {
		sidecar.pushBackup(KEY, "a", T0);
		sidecar.pushBackup(KEY, "b", T0 + BACKUP_COALESCE_MS);
		sidecar.pushBackup(KEY, "c", T0 + 2 * BACKUP_COALESCE_MS);
		expect(sidecar.getBackups(KEY).map((b) => b.text)).toEqual(["c", "b", "a"]);
	});

	it("keeps the newest versions, newest first, and never more than the cap", () => {
		for (let i = 0; i < MAX_BACKUPS + 5; i++) {
			sidecar.pushBackup(KEY, `v${i}`, T0 + i * BACKUP_COALESCE_MS);
		}
		const backups = sidecar.getBackups(KEY);
		expect(backups).toHaveLength(MAX_BACKUPS);
		expect(backups[0].text).toBe(`v${MAX_BACKUPS + 4}`);
		expect(backups[backups.length - 1].text).toBe("v5");
	});

	it("does not let an out-of-order timestamp overwrite the newest version", () => {
		sidecar.pushBackup(KEY, "a", T0);
		sidecar.pushBackup(KEY, "b", T0 + 5 * BACKUP_COALESCE_MS);
		// A clock that went backwards, or a stale caller: this must not silently replace "b".
		sidecar.pushBackup(KEY, "c", T0 + BACKUP_COALESCE_MS);
		expect(sidecar.getBackups(KEY).map((b) => b.text)).toEqual(["c", "b", "a"]);
	});

	it("keeps backups per table, not per note", () => {
		sidecar.pushBackup("note.md::0", "first", T0);
		sidecar.pushBackup("note.md::1", "second", T0);
		expect(sidecar.getBackups("note.md::0").map((b) => b.text)).toEqual(["first"]);
		expect(sidecar.getBackups("note.md::1").map((b) => b.text)).toEqual(["second"]);
	});

	it("follows a rename so the versions are not orphaned", () => {
		sidecar.pushBackup("note.md::0", "kept", T0);
		sidecar.handleRename("note.md", "folder/renamed.md");
		expect(sidecar.getBackups("note.md::0")).toHaveLength(0);
		expect(sidecar.getBackups("folder/renamed.md::0").map((b) => b.text)).toEqual(["kept"]);
	});
});
