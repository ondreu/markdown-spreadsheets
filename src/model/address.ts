/**
 * Cell addressing helpers.
 *
 * Internally a cell is keyed by `"<row>:<col>"`, both 0-based, where row 0 is the
 * markdown header row (§5). The user-facing label is spreadsheet style (`A1`), so
 * the header row is displayed as row 1.
 */

export type CellAddr = string;

export function addrKey(row: number, col: number): CellAddr {
	return `${row}:${col}`;
}

export function parseAddrKey(key: CellAddr): { row: number; col: number } {
	const sep = key.indexOf(":");
	return {
		row: Number.parseInt(key.slice(0, sep), 10),
		col: Number.parseInt(key.slice(sep + 1), 10),
	};
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function colName(col: number): string {
	let n = col;
	let out = "";
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

/** "A" -> 0, "AA" -> 26. Returns -1 for anything that is not a column name. */
export function colIndex(name: string): number {
	if (!/^[A-Za-z]+$/.test(name)) return -1;
	let n = 0;
	for (const ch of name.toUpperCase()) {
		n = n * 26 + (ch.charCodeAt(0) - 64);
	}
	return n - 1;
}

/** Spreadsheet-style label for a cell, e.g. row 0 col 0 -> "A1". */
export function cellLabel(row: number, col: number): string {
	return `${colName(col)}${row + 1}`;
}

/** Label for a rectangular range, e.g. "A1:C4" (or "A1" for a single cell). */
export function rangeLabel(r1: number, c1: number, r2: number, c2: number): string {
	if (r1 === r2 && c1 === c2) return cellLabel(r1, c1);
	return `${cellLabel(r1, c1)}:${cellLabel(r2, c2)}`;
}
