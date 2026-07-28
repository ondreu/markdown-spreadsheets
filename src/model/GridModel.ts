import { addrKey, parseAddrKey, type CellAddr } from "./address";

export type Align = null | "left" | "center" | "right";

export interface Cell {
	/** Raw markdown text of the cell — the source of truth (§5). Never a rendered value. */
	raw: string;
}

export interface GridModel {
	/** Sparse: an empty cell is absent from the map. */
	cells: Map<CellAddr, Cell>;
	colAlign: Align[];
	/** Derived bounding box of the non-empty cells (§3). */
	usedRange: { rows: number; cols: number };
}

export function createModel(): GridModel {
	return { cells: new Map(), colAlign: [], usedRange: { rows: 0, cols: 0 } };
}

export function getRaw(model: GridModel, row: number, col: number): string {
	return model.cells.get(addrKey(row, col))?.raw ?? "";
}

/** Writes a cell. An empty (or whitespace-only) value deletes the entry — the map stays sparse. */
export function setRaw(model: GridModel, row: number, col: number, raw: string): void {
	const key = addrKey(row, col);
	if (raw.trim() === "") model.cells.delete(key);
	else model.cells.set(key, { raw });
}

export function recomputeUsedRange(model: GridModel): void {
	let rows = 0;
	let cols = 0;
	for (const key of model.cells.keys()) {
		const { row, col } = parseAddrKey(key);
		if (row + 1 > rows) rows = row + 1;
		if (col + 1 > cols) cols = col + 1;
	}
	// The alignment row pins the column count even when the trailing columns are empty:
	// dropping them would silently change the note's shape.
	if (model.colAlign.length > cols) cols = model.colAlign.length;
	// A GFM table always has a header row, so a table with any content has at least 1 row.
	if (cols > 0 && rows === 0) rows = 1;
	model.usedRange = { rows, cols };
}

export function cloneModel(model: GridModel): GridModel {
	const cells = new Map<CellAddr, Cell>();
	for (const [key, cell] of model.cells) cells.set(key, { raw: cell.raw });
	return {
		cells,
		colAlign: model.colAlign.slice(),
		usedRange: { ...model.usedRange },
	};
}

/** Number of non-empty cells — the numerator of the density check in §13.1. */
export function filledCount(model: GridModel): number {
	return model.cells.size;
}

/**
 * Density of the bounding box. A low value means serialization would write a lot of
 * padding cells into the note, which is what the §13.1 modal warns about.
 */
export function density(model: GridModel): number {
	const { rows, cols } = model.usedRange;
	const total = rows * cols;
	if (total === 0) return 1;
	return model.cells.size / total;
}

/** Drops every cell outside `rows` x `cols` and shrinks the used range to match. */
export function cropModel(model: GridModel, rows: number, cols: number): void {
	for (const key of Array.from(model.cells.keys())) {
		const { row, col } = parseAddrKey(key);
		if (row >= rows || col >= cols) model.cells.delete(key);
	}
	model.colAlign = model.colAlign.slice(0, cols);
	recomputeUsedRange(model);
}

/** Tightens the used range onto the actual data — the "Shrink to actual data" action of §13.1. */
export function shrinkToData(model: GridModel): void {
	let rows = 0;
	let cols = 0;
	for (const key of model.cells.keys()) {
		const { row, col } = parseAddrKey(key);
		if (row + 1 > rows) rows = row + 1;
		if (col + 1 > cols) cols = col + 1;
	}
	model.colAlign = model.colAlign.slice(0, cols);
	model.usedRange = { rows: cols > 0 && rows === 0 ? 1 : rows, cols };
}
