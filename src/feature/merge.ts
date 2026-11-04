import { getRaw, recomputeUsedRange, setRaw, type GridModel } from "../model/GridModel";
import type { TableLayout } from "../store/Sidecar";
import { adjustFormulaRefs, headerKey } from "./formula";
import { deleteRows } from "./ops";

/**
 * Merging a spreadsheet into a table by a key column.
 *
 * The case it exists for: a price list, a stock export or a time sheet comes back from the system
 * with the same rows and some new ones, and the note is supposed to stay the record. Appending
 * would duplicate what is already there; pasting over would lose the columns the export does not
 * have. So rows are matched by a key — a code, an order number, a name — and only the columns the
 * file actually carries are touched.
 *
 * Two rules keep it honest:
 *
 * - **Nothing is guessed silently.** A key column that is not in the file, a key that repeats in
 *   the table, a file with no header: all of them raise, and the caller shows the reason.
 * - **Removing rows is opt-in.** A row that the file no longer has is usually news, not something to
 *   delete; it is reported and left alone unless asked.
 */

export interface MergeOptions {
	/** Columns of the table that together identify a row, in priority order. */
	keyCols: number[];
	/** Header names match columns; position matches them left to right. */
	align: "header" | "position";
	/** Append imported columns the table does not have. */
	addColumns: boolean;
	/** Delete table rows whose key the file does not contain. */
	removeMissing: boolean;
}

export interface MergePlan {
	/** Table column index ← imported column index, for the columns that already exist. */
	pairs: Array<{ tableCol: number; importCol: number }>;
	newColumns: Array<{ importCol: number; header: string }>;
	/** Table row (>= 1) and the imported row it takes its values from. */
	matches: Array<{ row: number; from: number }>;
	/** Imported rows (>= 1) with no key in the table. */
	newRows: number[];
	/** Table rows whose key is not in the file. */
	missing: number[];
	/** How many table rows share a key with an earlier row; the first one is the one kept. */
	duplicates: number;
	/** Whether applying the plan deletes `missing`, kept with the plan so it cannot be forgotten. */
	removeMissing: boolean;
}

export class MergeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MergeError";
	}
}

/**
 * What identifies a row: the key cells, compared without case or emphasis. An all-empty key is the
 * empty string, which is how a blank row is told apart from one whose key happens to be blank-ish.
 */
function keyOf(cells: string[], cols: number[]): string {
	const parts = cols.map((c) => headerKey(cells[c] ?? ""));
	return parts.every((part) => part === "") ? "" : parts.join("\u0000");
}

function rowCells(model: GridModel, row: number, cols: number): string[] {
	const out: string[] = [];
	for (let c = 0; c < cols; c++) out.push(getRaw(model, row, c));
	return out;
}

export function planMerge(model: GridModel, values: string[][], opts: MergeOptions): MergePlan {
	if (values.length < 2) throw new MergeError("The file needs a header row and at least one row of data.");
	if (opts.keyCols.length === 0) throw new MergeError("Pick the column that identifies a row.");
	const cols = Math.max(model.usedRange.cols, 1);
	const rows = model.usedRange.rows;
	const importWidth = Math.max(...values.map((line) => line.length));

	// The import side of the key: by header name, or the same indices.
	const importKeyCols = opts.keyCols.map((tableCol) => {
		if (opts.align === "position") return tableCol;
		const name = headerKey(getRaw(model, 0, tableCol));
		const found = values[0].findIndex((cell) => headerKey(cell) === name);
		if (found === -1) throw new MergeError(`The file has no column called "${name}".`);
		return found;
	});

	const tableHeaders = new Map<string, number>();
	for (let c = 0; c < cols; c++) {
		const name = headerKey(getRaw(model, 0, c));
		if (name !== "" && !tableHeaders.has(name)) tableHeaders.set(name, c);
	}

	const pairs: Array<{ tableCol: number; importCol: number }> = [];
	const newColumns: Array<{ importCol: number; header: string }> = [];
	for (let importCol = 0; importCol < importWidth; importCol++) {
		if (opts.align === "position") {
			if (importCol < cols) pairs.push({ tableCol: importCol, importCol });
			else if (opts.addColumns) newColumns.push({ importCol, header: values[0][importCol] ?? "" });
			continue;
		}
		const name = headerKey(values[0][importCol] ?? "");
		const target = name === "" ? undefined : tableHeaders.get(name);
		if (target !== undefined) pairs.push({ tableCol: target, importCol });
		else if (opts.addColumns && (values[0][importCol] ?? "").trim() !== "") newColumns.push({ importCol, header: values[0][importCol] });
	}

	// The table's own keys. The first row with a key wins; a repeat is reported, not merged.
	const index = new Map<string, number>();
	let duplicates = 0;
	for (let r = 1; r < rows; r++) {
		const key = keyOf(rowCells(model, r, cols), opts.keyCols);
		if (key === "") continue;
		if (index.has(key)) {
			duplicates++;
			continue;
		}
		index.set(key, r);
	}

	const matches: Array<{ row: number; from: number }> = [];
	const newRows: number[] = [];
	const seen = new Set<string>();
	for (let from = 1; from < values.length; from++) {
		const key = keyOf(values[from], importKeyCols);
		if (key === "") {
			newRows.push(from);
			continue;
		}
		seen.add(key);
		const row = index.get(key);
		if (row === undefined) newRows.push(from);
		else matches.push({ row, from });
	}

	const missing: number[] = [];
	for (const [key, row] of index) if (!seen.has(key)) missing.push(row);

	return { pairs, newColumns, matches, newRows, missing, duplicates, removeMissing: opts.removeMissing };
}

/**
 * Applies a plan. Values are written, formula cells among them are left as formulas — an imported
 * literal replaces them, which is what a merge of data columns means — and deleted rows go through
 * `deleteRows` plus `adjustFormulaRefs`, so a formula elsewhere in the table keeps pointing at the
 * right cells.
 */
export function applyMerge(
	model: GridModel,
	layout: TableLayout,
	values: string[][],
	plan: MergePlan,
): { updated: number; added: number; removed: number; columns: number } {
	const lastRow = Math.max(model.usedRange.rows - 1, 0);
	const cols = Math.max(model.usedRange.cols, 1);

	// New columns go on the right, headers first.
	let nextCol = Math.max(cols, ...plan.pairs.map((p) => p.tableCol + 1));
	const columnFor = new Map<number, number>();
	for (const pair of plan.pairs) columnFor.set(pair.importCol, pair.tableCol);
	for (const column of plan.newColumns) {
		setRaw(model, 0, nextCol, column.header.trim());
		columnFor.set(column.importCol, nextCol);
		nextCol++;
	}

	for (const match of plan.matches) {
		for (const [importCol, tableCol] of columnFor) {
			const value = values[match.from][importCol] ?? "";
			setRaw(model, match.row, tableCol, value.replace(/\r?\n/g, " "));
		}
	}

	let row = lastRow + 1;
	for (const from of plan.newRows) {
		for (const [importCol, tableCol] of columnFor) {
			const value = values[from][importCol] ?? "";
			if (value !== "") setRaw(model, row, tableCol, value.replace(/\r?\n/g, " "));
		}
		row++;
	}

	let removed = 0;
	if (plan.removeMissing && plan.missing.length > 0) {
		const doomed = plan.missing.slice().sort((a, b) => a - b);
		// The references are adjusted from the bottom up, then the rows go in one operation, which
		// is also what keeps the per-row heights with the rows that survive.
		for (const target of doomed.slice().reverse()) adjustFormulaRefs(model, { kind: "deleteRows", at: target, count: 1 });
		removed = deleteRows(model, layout, doomed);
	}
	recomputeUsedRange(model);
	return { updated: plan.matches.length, added: plan.newRows.length, removed, columns: plan.newColumns.length };
}
