import { describe, expect, it } from "vitest";
import { GRID_COMMANDS } from "../src/view/gridCommands";

/*
 * These commands are the whole contract with a host ribbon (Ribbon toolbar draws its spreadsheet
 * tabs from this list). A duplicated or malformed id silently removes a button there, so the list
 * itself is worth a test.
 */
describe("grid commands", () => {
	it("has unique, kebab-case ids", () => {
		const ids = GRID_COMMANDS.map(([id]) => id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	});

	it("names every command for the palette", () => {
		for (const [id, name] of GRID_COMMANDS) {
			expect(name.trim(), id).not.toBe("");
			expect(name.charAt(0), id).toBe(name.charAt(0).toUpperCase());
		}
	});

	it("offers the formatting actions a host ribbon shows", () => {
		const ids = new Set(GRID_COMMANDS.map(([id]) => id));
		for (const id of ["bold", "italic", "code", "strike", "highlight", "link", "wrap", "render"]) {
			expect(ids.has(id), id).toBe(true);
		}
	});
});
