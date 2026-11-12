import { colIndex, colName } from "../model/address";
import { buildFormulaCell, formulaProblem, isGridFunction } from "./formula";

/**
 * Excel formulas on their way into a table.
 *
 * The grid's formula language is a deliberate subset of Excel's: A1 references, the operators
 * Excel has, and the functions in `FUNCTIONS`. An imported formula is therefore translated when
 * that is possible, and left as its value when it is not. A formula the grid cannot evaluate would
 * be worse than a number: it reads `#NAME?` or `#REF!` in the cell while the note claims to hold
 * the original, and nothing on screen says which part was lost.
 *
 * Everything here is pure. The reader hands over the formula text Excel stored, the caller says
 * which sheets are coming along and under which table number, and the answer is either an
 * expression this grid can parse or `null`.
 */

/** One cell of an imported sheet, in the shape the reader produces. */
export interface FormulaCellSource {
	value: string;
	formula?: string;
}

/** A rectangle of cells, so a reference can be checked against what was actually imported. */
export interface FormulaRect {
	rows: number;
	cols: number;
}

/** An imported sheet: where its references point, and how big it is. */
export interface FormulaSheet extends FormulaRect {
	/** The `TableN` the note will use for this sheet. */
	ref: string;
}

export interface FormulaContext {
	/** The sheet the formula is written on. */
	sheet: FormulaRect;
	/** Every imported sheet by its lowercased Excel name, the sheet itself included. */
	sheets: ReadonlyMap<string, FormulaSheet>;
	/**
	 * How far the rectangle moves before it lands. A paste into the grid at some cell other than
	 * A1 shifts every relative reference, exactly as dragging the block would in Excel. References
	 * into another sheet do not shift — they belong to that sheet, which is not moving.
	 */
	offset?: { row: number; col: number };
}

export interface FormulaCounts {
	total: number;
	convertible: number;
}

/** `$B$2`, split the way Excel writes it: the `$`s say which half stays put. */
const A1 = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
/** A reference, a function name or a sheet name. Dots and underscores appear in modern names. */
const WORD = /^[$A-Za-z_][$A-Za-z0-9_.]*/;

/**
 * The formula as this grid's syntax, or null when it cannot be carried over.
 *
 * `=SUM(B2:B4)` comes back unchanged; `=SUM('Q1 data'!B2:B4)` becomes `=SUM(Table2!B2:B4)` when
 * that sheet is part of the same import. Functions outside the grid's list, structured references
 * (`Table1[Qty]`), array constants, external links and percent literals all come back null, and
 * the caller keeps the value Excel calculated.
 */
export function importFormula(formula: string, context: FormulaContext): string | null {
	let text = formula.trim();
	if (text.startsWith("=")) text = text.slice(1).trim();
	if (text === "") return null;

	const offsetRow = context.offset?.row ?? 0;
	const offsetCol = context.offset?.col ?? 0;
	let out = "";
	/** Set by a sheet prefix; the next reference, and its range, belongs to that sheet. */
	let foreign: FormulaSheet | null = null;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === '"') {
			const end = stringEnd(text, i);
			if (end === -1) return null;
			out += text.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "'") {
			const end = quotedEnd(text, i);
			if (end === -1) return null;
			const sheet = context.sheets.get(text.slice(i + 1, end).replace(/''/g, "'").toLowerCase());
			if (sheet === undefined || text[end + 1] !== "!") return null;
			out += `${sheet.ref}!`;
			foreign = sheet;
			i = end + 2;
			continue;
		}
		if (/[\d.]/.test(ch)) {
			const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
			if (num === null) return null;
			out += num[0];
			i += num[0].length;
			continue;
		}
		const word = WORD.exec(text.slice(i));
		if (word !== null) {
			const token = word[0];
			let after = i + token.length;
			while (/\s/.test(text[after] ?? "")) after++;
			if (text[after] === "(") {
				// Excel writes a function it did not ship with as `_xlfn.NAME`; the name is ours.
				const name = token.toUpperCase().replace(/^_XLFN\./, "");
				if (name === "VLOOKUP" || name === "HLOOKUP") {
					const close = callEnd(text, after);
					if (close === -1) return null;
					const translated = translateLookup(name, text.slice(after + 1, close), context);
					if (translated === null) return null;
					out += translated;
					foreign = null;
					i = close + 1;
					continue;
				}
				if (!isGridFunction(name)) return null;
				out += name;
				foreign = null;
				i = after;
				continue;
			}
			if (text[after] === "!") {
				const sheet = context.sheets.get(token.toLowerCase());
				if (sheet === undefined) return null;
				out += `${sheet.ref}!`;
				foreign = sheet;
				i = after + 1;
				continue;
			}
			const upper = token.toUpperCase();
			if (upper === "TRUE" || upper === "FALSE") {
				out += upper;
				foreign = null;
				i += token.length;
				continue;
			}
			const ref = A1.exec(token);
			if (ref === null) return null;
			const target = foreign ?? context.sheet;
			const row = Number.parseInt(ref[4], 10) - 1;
			const col = colIndex(ref[2]);
			if (row < 0 || col < 0 || row >= target.rows || col >= target.cols) return null;
			const moved = foreign === null ? { row: offsetRow, col: offsetCol } : { row: 0, col: 0 };
			out += `${ref[1]}${colName(col + moved.col)}${ref[3]}${row + moved.row + 1}`;
			i += token.length;
			continue;
		}
		if (ch === ":" || ch === "(" || ch === ")") {
			out += ch;
			if (ch !== ":") foreign = null;
			i++;
			continue;
		}
		if (ch === "," || ch === ";") {
			out += ",";
			foreign = null;
			i++;
			continue;
		}
		if ("+-*/^&=<>".includes(ch)) {
			out += ch;
			foreign = null;
			i++;
			continue;
		}
		return null;
	}
	const expr = out.trim();
	if (expr === "") return null;
	return formulaProblem(expr) === null ? expr : null;
}

/** How many cells of a sheet carry a formula, whatever can be made of them. */
export function formulaTotal(rows: ReadonlyArray<ReadonlyArray<FormulaCellSource>>): number {
	let total = 0;
	for (const row of rows) for (const cell of row) if (cell.formula !== undefined) total++;
	return total;
}

/** How many formulas a set of cells holds, and how many of them this grid can keep. */
export function countFormulas(rows: ReadonlyArray<ReadonlyArray<FormulaCellSource>>, context: FormulaContext): FormulaCounts {
	let total = 0;
	let convertible = 0;
	for (const row of rows) {
		for (const cell of row) {
			if (cell.formula === undefined) continue;
			total++;
			if (importFormula(cell.formula, context) !== null) convertible++;
		}
	}
	return { total, convertible };
}

/**
 * The sheet as the string values a table is written from.
 *
 * A convertible formula becomes the cell's value followed by the formula comment — the value Excel
 * cached, so the table reads correctly before the first recalculation and stays readable anywhere
 * the plugin is not installed. `values` drops every formula and keeps only that value.
 */
export function sheetToValues(
	rows: ReadonlyArray<ReadonlyArray<FormulaCellSource>>,
	options: { formulas: "convert" | "values"; context: FormulaContext },
): string[][] {
	return rows.map((row) =>
		row.map((cell) => {
			if (options.formulas === "values" || cell.formula === undefined) return cell.value;
			const expr = importFormula(cell.formula, options.context);
			return expr === null ? cell.value : buildFormulaCell(cell.value, expr);
		}),
	);
}

/**
 * Shifts every relative reference, as filling a formula down or across does.
 *
 * Excel stores a filled-in column of formulas once: the first cell holds the formula and the rest
 * say only "shared, number 0". Those followers are unreadable without the shift, and a real
 * workbook is full of them — a column of `=B2*C2` is the normal way to type it. String literals and
 * quoted sheet names are copied through untouched; a name is only a reference when the whole token
 * reads as one.
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
	if (dRow === 0 && dCol === 0) return formula;
	let out = "";
	let i = 0;
	while (i < formula.length) {
		const ch = formula[i];
		if (ch === '"') {
			const end = stringEnd(formula, i);
			if (end === -1) return formula;
			out += formula.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "'") {
			const end = quotedEnd(formula, i);
			if (end === -1) return formula;
			out += formula.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		const word = WORD.exec(formula.slice(i));
		if (word !== null) {
			const token = word[0];
			const after = formula[i + token.length];
			const ref = A1.exec(token);
			// `LOG10(` is a call, not the cell LOG10; a token followed by `(` or `.` is a name.
			if (ref !== null && after !== "(" && after !== "." && after !== "_") {
				const row = Number.parseInt(ref[4], 10) + (ref[3] === "$" ? 0 : dRow);
				const col = colIndex(ref[2]) + (ref[1] === "$" ? 0 : dCol);
				if (row >= 1 && col >= 0) out += `${ref[1]}${colName(col)}${ref[3]}${row}`;
				else out += token;
				i += token.length;
				continue;
			}
			out += token;
			i += token.length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}


/* -------------------------------------------------- the legacy lookups */

/**
 * `VLOOKUP` and `HLOOKUP` do not exist here: both are a positional count into a block, which is
 * exactly what breaks when a column is inserted — and in a note, a column gets inserted.
 *
 * They are translated on the way in instead, because at import time the block is known and its
 * columns have names: `VLOOKUP(A2, D2:F9, 3, FALSE)` becomes `XLOOKUP(A2, D2:D9, F2:F9)`. The
 * lookup keeps working and keeps meaning the same thing, without a legacy function in the grid's
 * evaluator. An approximate lookup (`TRUE`, `1`, or the flag left out) is not translated: it needs
 * a sorted range and Excel's tie-break, and a note that says "near this one" is a wrong answer
 * nobody notices.
 */
function translateLookup(name: "VLOOKUP" | "HLOOKUP", inner: string, context: FormulaContext): string | null {
	const args = splitArgs(inner);
	if (args === null || (args.length !== 3 && args.length !== 4)) return null;
	// The fourth argument is mandatory here: Excel without it means "approximate", and a text
	// block has nothing to be near.
	const exact = args[3]?.trim().toUpperCase();
	if (exact !== "FALSE" && exact !== "0") return null;
	const index = /^\s*(\d+)\s*$/.exec(args[2]);
	if (index === null) return null;
	const offset = Number.parseInt(index[1], 10);
	if (offset < 1) return null;
	const key = importFormula(args[0], context);
	if (key === null) return null;
	const block = parseBlock(args[1], context);
	if (block === null) return null;
	const vertical = name === "VLOOKUP";
	const span = vertical ? block.c2 - block.c1 : block.r2 - block.r1;
	if (offset - 1 > span) return null;
	const keyRange = vertical
		? `${rangeRef(block, block.r1, block.c1, block.r2, block.c1)}`
		: `${rangeRef(block, block.r1, block.c1, block.r1, block.c2)}`;
	const valueRange = vertical
		? rangeRef(block, block.r1, block.c1 + offset - 1, block.r2, block.c1 + offset - 1)
		: rangeRef(block, block.r1 + offset - 1, block.c1, block.r1 + offset - 1, block.c2);
	return `XLOOKUP(${key},${keyRange},${valueRange})`;
}

/** A `B2:F9` (or `'Sheet'!B2:F9`) argument, with the `$` markers its endpoints carry. */
interface ParsedBlock {
	prefix: string;
	r1: number;
	c1: number;
	r2: number;
	c2: number;
	absCol1: boolean;
	absRow1: boolean;
	absCol2: boolean;
	absRow2: boolean;
}

function parseBlock(text: string, context: FormulaContext): ParsedBlock | null {
	let rest = text.trim();
	let prefix = "";
	let target: FormulaRect = context.sheet;
	if (rest.startsWith("'")) {
		const end = quotedEnd(rest, 0);
		if (end === -1 || rest[end + 1] !== "!") return null;
		const sheet = context.sheets.get(rest.slice(1, end).replace(/''/g, "'").toLowerCase());
		if (sheet === undefined) return null;
		prefix = `${sheet.ref}!`;
		target = sheet;
		rest = rest.slice(end + 2);
	} else {
		const bare = /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(rest);
		if (bare !== null) {
			const sheet = context.sheets.get(bare[1].toLowerCase());
			if (sheet === undefined) return null;
			prefix = `${sheet.ref}!`;
			target = sheet;
			rest = rest.slice(bare[0].length);
		}
	}
	const parts = rest.split(":");
	if (parts.length !== 2) return null;
	const first = A1.exec(parts[0].trim());
	const last = A1.exec(parts[1].trim());
	if (first === null || last === null) return null;
	const r1 = Number.parseInt(first[4], 10) - 1;
	const c1 = colIndex(first[2]);
	const r2 = Number.parseInt(last[4], 10) - 1;
	const c2 = colIndex(last[2]);
	if (r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1 || r2 >= target.rows || c2 >= target.cols) return null;
	return {
		prefix,
		r1,
		c1,
		r2,
		c2,
		absCol1: first[1] === "$",
		absRow1: first[3] === "$",
		absCol2: last[1] === "$",
		absRow2: last[3] === "$",
	};
}

/** One slice of a block, keeping the `$` markers of the corner it starts from. */
function rangeRef(block: ParsedBlock, r1: number, c1: number, r2: number, c2: number): string {
	const col = (c: number): boolean => (c === block.c1 ? block.absCol1 : block.absCol2);
	const row = (r: number): boolean => (r === block.r1 ? block.absRow1 : block.absRow2);
	const at = (r: number, c: number): string => `${col(c) ? "$" : ""}${colName(c)}${row(r) ? "$" : ""}${r + 1}`;
	return `${block.prefix}${at(r1, c1)}:${at(r2, c2)}`;
}

/** Index of the `)` closing the call whose `(` is at `open`, or -1. */
function callEnd(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			const end = stringEnd(text, i);
			if (end === -1) return -1;
			i = end - 1;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** A call's arguments, split at its top-level separators; null when the text is unbalanced. */
function splitArgs(inner: string): string[] | null {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === '"') {
			const end = stringEnd(inner, i);
			if (end === -1) return null;
			i = end - 1;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth < 0) return null;
		} else if ((ch === "," || ch === ";") && depth === 0) {
			out.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	if (depth !== 0) return null;
	out.push(inner.slice(start));
	return out;
}

/** Index just past the closing quote of the string literal starting at `at`, or -1. */
function stringEnd(text: string, at: number): number {
	let i = at + 1;
	while (i < text.length) {
		if (text[i] !== '"') {
			i++;
			continue;
		}
		if (text[i + 1] === '"') {
			i += 2;
			continue;
		}
		return i + 1;
	}
	return -1;
}

/** Index of the closing `'` of a quoted sheet name starting at `at`, or -1. */
function quotedEnd(text: string, at: number): number {
	let i = at + 1;
	while (i < text.length) {
		if (text[i] !== "'") {
			i++;
			continue;
		}
		if (text[i + 1] === "'") {
			i += 2;
			continue;
		}
		return i;
	}
	return -1;
}
