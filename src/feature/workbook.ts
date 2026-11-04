import type { GridModel } from "../model/GridModel";
import { recalculate, sourceOf, type CellSource, type FormulaIssue, type RecalcOptions } from "./formula";

/**
 * The tables of one note, calculated together.
 *
 * `Table2!B3` makes a note a workbook, and a workbook has an order: table 1 may feed table 2, which
 * may feed table 3. `recalculate` sorts the cells *inside* one table; this sorts the tables, by
 * running each of them in document order until nothing changes any more.
 *
 * Two honest limits, both visible rather than silent:
 *
 * - **A reference to a cell that is itself a formula reads what the note stores**, not a value
 *   computed in this pass. Three passes settle any realistic chain (a total feeding another total);
 *   a longer one stops at `maxPasses` and leaves the last values, which is what the note would show
 *   anyway.
 * - **Cycles across tables are not detected as cycles.** `Table2!A1` feeding `Table1!A1` feeding it
 *   back would oscillate between two numbers; the passes stop and the values are whatever the last
 *   pass wrote. A per-cell cycle inside one table still shows `#CYCLE!`, because that graph is known.
 */

export interface WorkbookResult {
	/** Cells whose value changed, over all tables and passes. */
	changed: number;
	/** How many cells changed in each table, in the order given. */
	perTable: number[];
	errors: FormulaIssue[];
	passes: number;
}

export function recalculateWorkbook(tables: GridModel[], opts: RecalcOptions & { maxPasses?: number }): WorkbookResult {
	const sources: CellSource[] = tables.map((model) => sourceOf(model, opts.numberOpts));
	const perTable = tables.map(() => 0);
	const errors: FormulaIssue[] = [];
	const limit = Math.max(1, opts.maxPasses ?? 4);
	let passes = 0;
	for (; passes < limit; passes++) {
		let delta = 0;
		for (let i = 0; i < tables.length; i++) {
			// Every table is readable under its own number, including the one being calculated: a
			// formula may name its own table, which is the same as a plain reference.
			const result = recalculate(tables[i], { ...opts, tables: sources });
			perTable[i] += result.changed.length;
			delta += result.changed.length;
			for (const issue of result.errors) {
				if (!errors.some((seen) => seen.row === issue.row && seen.col === issue.col && seen.code === issue.code)) errors.push(issue);
			}
		}
		if (delta === 0) break;
	}
	return { changed: perTable.reduce((a, n) => a + n, 0), perTable, errors, passes: passes + 1 };
}

/**
 * Rewrites `TableN!` in every formula of a note through `map`, which takes a 1-based table number
 * and returns the number it now has, or null when that table is gone. Text outside `%%=…%%` is left
 * alone, so a sentence about "Table 2" is not touched.
 */
export function shiftTableRefs(text: string, map: (table: number) => number | null): string {
	return text.replace(/%%=([\s\S]*?)%%/g, (whole, expr: string) => {
		if (!/Table\d+!/i.test(expr)) return whole;
		const next = expr.replace(/Table(\d+)!/gi, (match, digits: string) => {
			const moved = map(Number.parseInt(digits, 10));
			return moved === null ? match : `Table${moved}!`;
		});
		return next === expr ? whole : `%%=${next}%%`;
	});
}

/**
 * How the tables of a note moved, as a 1-based number map.
 *
 * A table is recognised by its headers and its height — the same fingerprint thinking as the anchor,
 * but here it only has to be good enough to notice that a table was inserted above another. A table
 * with no match was added (nothing to move); an old table with no match was removed, so references
 * to it have nowhere to go and stay as they are, visibly wrong rather than quietly redirected.
 */
export function tableIndexMap(before: string[], after: string[]): { map: (table: number) => number | null; moved: boolean } {
	const used = new Set<number>();
	const pairs = before.map((fingerprint) => {
		const at = after.findIndex((candidate, i) => candidate === fingerprint && !used.has(i));
		if (at >= 0) used.add(at);
		return at;
	});
	const moved = pairs.some((at, i) => at !== i);
	return {
		map: (table) => {
			const at = pairs[table - 1];
			return at === undefined || at < 0 ? null : at + 1;
		},
		moved,
	};
}
