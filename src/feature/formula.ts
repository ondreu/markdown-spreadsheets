import { addrKey, colIndex, colName, parseAddrKey, type CellAddr } from "../model/address";
import { getRaw, recomputeUsedRange, setRaw, type GridModel } from "../model/GridModel";
import {
	isoFromSerial,
	parseNumber,
	serialFromIsoDate,
	stripInlineMarkdown,
	type NumberParseOptions,
} from "../model/numbers";
import { peelInline } from "./ops";

/**
 * Formula cells.
 *
 * A formula lives inside its cell as an Obsidian comment after the value: `1 250 %%=SUM(B2:B3)%%`.
 * Obsidian hides the comment, every other Markdown reader shows a literal number followed by some
 * text, and the note stays the source of truth (D1): the plugin recomputes the display value and
 * writes it back as plain text, so a note opened without the plugin still reads correctly, just
 * possibly stale.
 *
 * References use the grid's labels: column letter plus a 1-based row where row 1 is the markdown
 * header, so model row `r` is label `r + 1`. The expression language is parsed here by hand —
 * no `eval`, no `new Function` — and follows Excel where the two could disagree, because the XLSX
 * export hands the same text to Excel.
 */

export interface FormulaCell {
	/** Raw markdown before the comment, trimmed, emphasis wrappers included. */
	display: string;
	/** The expression without the leading `=`. */
	expr: string;
}

/** Error codes a formula can produce. `#CYCLE!` and `#ERROR!` are ours; the rest are Excel's. */
export type FormulaErrorCode = "#VALUE!" | "#REF!" | "#DIV/0!" | "#N/A" | "#CYCLE!" | "#ERROR!" | "#NUM!" | "#NAME?";

export class FormulaError extends Error {
	readonly code: FormulaErrorCode;

	constructor(code: FormulaErrorCode, message: string) {
		super(message);
		this.name = "FormulaError";
		this.code = code;
	}
}

/* ------------------------------------------------------------- cell format */

/**
 * Recognises exactly one trailing `%%=…%%`.
 *
 * The text before it must hold an even number of `%%`: otherwise Obsidian pairs the markers
 * differently from us (`a %% b %%=x%%` is the comment ` b ` followed by text), and treating the
 * tail as a formula would rewrite something the user sees.
 */
export function parseFormulaCell(raw: string): FormulaCell | null {
	let s = raw.trimEnd();
	// Bolding a cell in the note's own editor is easy to do *around* the comment: `**1 200 %%=…%%**`.
	// The comment still ends the visible text, just not the string, and treating that as prose left a
	// formula that silently never recalculated. The wrapper is peeled and put back on the display, so
	// the cell reads as a formula everywhere and the next write normalises it.
	let wrapper = "";
	for (const token of ["**", "__", "~~", "==", "*", "_"]) {
		if (s.length > token.length * 2 && s.startsWith(token) && s.endsWith(token)) {
			wrapper = token;
			s = s.slice(token.length, s.length - token.length).trimEnd();
			break;
		}
	}
	if (s.length < 6 || !s.endsWith("%%")) return null;
	const open = s.lastIndexOf("%%=", s.length - 3);
	if (open === -1 || open + 3 > s.length - 2) return null;
	const expr = s.slice(open + 3, s.length - 2).trim();
	if (expr === "" || expr.includes("%%")) return null;
	const before = s.slice(0, open);
	if (countMarkers(before) % 2 !== 0) return null;
	const display = withoutRuleComments(before).trim();
	if (display === "") return { display: wrapper === "" ? "" : `${wrapper}${wrapper}`, expr };
	return { display: wrapper === "" ? display : `${wrapper}${display}${wrapper}`, expr };
}

/**
 * A cell split into its display and the trailing `%%…%%` comments after it.
 *
 * A formula has to be the last comment in the cell, so everything before it is a marker of some
 * kind: a conditional rule (`cf …`) or the date marker (`date`). Written by hand the cell may hold
 * prose with its own `%%` pairs, which is why only whole trailing comments are peeled.
 */
function splitTrailing(raw: string): { display: string; comments: string[] } {
	const comments: string[] = [];
	let s = raw.trimEnd();
	for (;;) {
		if (!s.endsWith("%%")) break;
		const open = s.lastIndexOf("%%", s.length - 3);
		if (open === -1) break;
		const body = s.slice(open + 2, s.length - 2);
		if (body.includes("%%")) break;
		comments.unshift(body);
		s = s.slice(0, open).trimEnd();
	}
	return { display: s, comments };
}

const DATE_MARK = /^date$/i;

/** Whether the cell asks for its result to be written as a date. */
export function hasDateMark(raw: string): boolean {
	return splitTrailing(raw).comments.some((body) => DATE_MARK.test(body));
}

/**
 * Rebuilds a formula cell with the comments it carried in front of the formula.
 *
 * A recalculation rewrites the display, and `buildFormulaCell` knows only the display and the
 * expression — so without this the cell would lose the rule or the date marker that lived in it,
 * silently and for good.
 */
export function withMarkerComments(next: string, raw: string): string {
	const markers = splitTrailing(raw).comments.filter((body) => !body.startsWith("="));
	if (markers.length === 0) return next;
	const tail = markers.map((body) => `%%${body}%%`).join(" ");
	const at = next.indexOf("%%=");
	if (at === -1) return `${next} ${tail}`;
	const head = next.slice(0, at).trimEnd();
	const rest = next.slice(at);
	return head === "" ? `${tail} ${rest}` : `${head} ${tail} ${rest}`;
}

/**
 * Replaces every formula in a model with the value it shows, and reports how many cells changed.
 *
 * The value is the display the cell already had, so nothing a reader sees changes — what goes is
 * the expression. A rule comment or a date marker stays where it was: it is not a formula, and
 * flattening a cell should not quietly take its formatting with it.
 */
export function flattenFormulas(model: GridModel): number {
	let changed = 0;
	for (const [key, cell] of Array.from(model.cells)) {
		const formula = parseFormulaCell(cell.raw);
		if (formula === null) continue;
		const next = withMarkerComments(formula.display, cell.raw);
		if (next === cell.raw) continue;
		const { row, col } = parseAddrKey(key);
		setRaw(model, row, col, next);
		changed++;
	}
	return changed;
}

/**
 * Adds or removes the date marker, keeping the formula the last comment.
 *
 * The marker is exactly one `%%` pair: `2026-03-15 %%date%% %%=A2+30%%`. A second pair would end
 * the comment early, and whatever followed it would be read as part of the cell's text.
 */
export function setDateMark(raw: string, wanted: boolean): string {
	const { display, comments } = splitTrailing(raw);
	const formula = comments.find((body) => body.startsWith("="));
	const rest = comments.filter((body) => !body.startsWith("=") && !DATE_MARK.test(body));
	const next = wanted ? [...rest, "date"] : rest;
	if (formula !== undefined) next.push(formula);
	if (next.length === 0) return display;
	const tail = next.map((body) => `%%${body}%%`).join(" ");
	return display === "" ? tail : `${display} ${tail}`;
}

/**
 * Drops the markers from the text in front of a formula.
 *
 * A conditional rule is written into the first cell of its range, and that cell may well hold the
 * formula whose value the rule tests — so the two comments share a cell, and the rule sits first
 * because the formula has to stay the last comment for the parser to find it. What the cell *shows*
 * is neither of them.
 */
function withoutRuleComments(text: string): string {
	let s = text.trimEnd();
	for (;;) {
		if (!s.endsWith("%%")) break;
		const open = s.lastIndexOf("%%", s.length - 3);
		if (open === -1) break;
		const body = s.slice(open + 2, s.length - 2);
		if (body.includes("%%") || !(/^cf\s/i.test(body) || DATE_MARK.test(body))) break;
		s = s.slice(0, open).trimEnd();
	}
	return s;
}

function countMarkers(s: string): number {
	let n = 0;
	let i = s.indexOf("%%");
	while (i !== -1) {
		n++;
		i = s.indexOf("%%", i + 2);
	}
	return n;
}

export function buildFormulaCell(display: string, expr: string): string {
	const shown = display.trim();
	return shown === "" ? `%%=${expr}%%` : `${shown} %%=${expr}%%`;
}

export function isFormulaCell(raw: string): boolean {
	return parseFormulaCell(raw) !== null;
}

/** The cell without its formula comment — what exports and number parsing should see. */
export function stripFormula(raw: string): string {
	const f = parseFormulaCell(raw);
	return f === null ? raw : f.display;
}

/** What the cell editor shows: the formula for a formula cell, the raw text otherwise. */
export function editTextOf(raw: string): string {
	const f = parseFormulaCell(raw);
	return f === null ? raw : `=${f.expr}`;
}

/**
 * Inverse of `editTextOf`.
 *
 * `=` starts a formula, but `==` does not: that is Obsidian's highlight syntax. A leading
 * apostrophe escapes the equals sign, as in Excel. The new formula keeps the emphasis of the
 * previous display (a bold total stays bold) with a placeholder value that recalculation replaces.
 * An unchanged formula returns the previous raw text, so its computed value does not flash to 0.
 */
export function rawFromEdit(previousRaw: string, text: string): string {
	if (text.startsWith("'=")) return text.slice(1);
	const trimmed = text.trim();
	if (!trimmed.startsWith("=") || trimmed.startsWith("==")) return text;
	const expr = trimmed.slice(1).trim();
	// `%%` inside the expression would end the comment early and leak the rest into the note.
	if (expr === "" || expr.includes("%%")) return text;
	const previous = parseFormulaCell(previousRaw);
	if (previous !== null && previous.expr === expr) return previousRaw;
	const display = previous === null ? previousRaw : previous.display;
	return buildFormulaCell(withLayersOf(display, "0"), expr);
}

/**
 * Closes the parentheses a half-typed formula still has open, the way Enter does in Excel.
 *
 * Pointing a range into `=SUM(` leaves `=SUM(B2:B5`, and nothing comes of it until the bracket is
 * closed — which is a keystroke nobody types, because the spreadsheet normally types it for you.
 * Quotes are honoured, so `=IF(A1="(","x","y")` is left alone; text that is not a formula, that
 * already balances, or that has more closers than openers comes back unchanged.
 */
export function closeUnbalanced(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("=") || trimmed.startsWith("==")) return text;
	let depth = 0;
	let quoted = false;
	for (const ch of trimmed) {
		if (ch === '"') {
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
	}
	if (depth <= 0) return text;
	return text + ")".repeat(depth);
}

/**
 * Wraps `inner` in the emphasis layers that wrap the whole of `previous`.
 *
 * Used wherever a value is replaced but its formatting should survive: `**12**` recomputed to 15
 * becomes `**15**`, not `15`.
 */
export function withLayersOf(previous: string, inner: string): string {
	if (previous.trim() === "" || inner === "") return inner;
	const { layers } = peelInline(previous);
	let s = inner;
	for (let i = layers.length - 1; i >= 0; i--) {
		const token = layers[i];
		s = token === "`" ? wrapCode(s) : `${token}${s}${token}`;
	}
	return s;
}

function wrapCode(s: string): string {
	let longest = 0;
	let run = 0;
	for (const ch of s) {
		run = ch === "`" ? run + 1 : 0;
		if (run > longest) longest = run;
	}
	const fence = "`".repeat(longest + 1);
	const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
	return `${fence}${pad}${s}${pad}${fence}`;
}

/* --------------------------------------------------------------- tokenizer */

type TokenType = "num" | "str" | "ref" | "name" | "func" | "bracket" | "error" | "op" | "lparen" | "rparen" | "sep" | "colon" | "bang";

interface Token {
	type: TokenType;
	text: string;
	start: number;
	end: number;
}

const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD_RE = /\$?[A-Za-z]+\$?\d*/y;
const ERROR_RE = /#[A-Za-z0-9/]+[!?]?/y;
const REF_RE = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;

function stickyMatch(re: RegExp, src: string, at: number): string | null {
	re.lastIndex = at;
	const m = re.exec(src);
	return m === null ? null : m[0];
}

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const start = i;
		const push = (type: TokenType, text: string): void => {
			out.push({ type, text, start, end: start + text.length });
			i = start + text.length;
		};
		if (/[\d.]/.test(ch)) {
			const num = stickyMatch(NUMBER_RE, src, i);
			if (num === null) throw new FormulaError("#ERROR!", `Unexpected "${ch}"`);
			push("num", num);
			continue;
		}
		if (ch === "$" || /[A-Za-z]/.test(ch)) {
			const word = stickyMatch(WORD_RE, src, i);
			if (word === null) throw new FormulaError("#ERROR!", `Unexpected "${ch}"`);
			let after = i + word.length;
			while (after < src.length && /\s/.test(src[after])) after++;
			if (src[after] === "(" && !word.includes("$")) push("func", word);
			// `Table2!B3`: a word followed by `!` names a table, even though it looks like a cell
			// reference — `Table2` would otherwise parse as column TABLE, row 2.
			else if (src[after] === "!") push("name", word);
			else if (REF_RE.test(word)) push("ref", word);
			else if (/^[A-Za-z]+$/.test(word)) push("name", word);
			else throw new FormulaError("#ERROR!", `Not a reference: ${word}`);
			continue;
		}
		if (ch === "[") {
			const close = src.indexOf("]", i);
			if (close === -1) throw new FormulaError("#ERROR!", "Unclosed column name");
			out.push({ type: "bracket", text: src.slice(i + 1, close), start, end: close + 1 });
			i = close + 1;
			continue;
		}
		if (ch === "#") {
			const err = stickyMatch(ERROR_RE, src, i);
			if (err === null) throw new FormulaError("#ERROR!", 'Unexpected "#"');
			push("error", err);
			continue;
		}
		// Excel's only string literal. A doubled quote inside stands for one quote.
		if (ch === '"') {
			let j = i + 1;
			for (;;) {
				if (j >= src.length) throw new FormulaError("#ERROR!", "Missing closing quote");
				if (src[j] !== '"') {
					j++;
					continue;
				}
				if (src[j + 1] === '"') {
					j += 2;
					continue;
				}
				break;
			}
			out.push({ type: "str", text: src.slice(i, j + 1), start, end: j + 1 });
			i = j + 1;
			continue;
		}
		if (ch === "<" || ch === ">" || ch === "=") {
			const two = src.slice(i, i + 2);
			push("op", two === "<=" || two === ">=" || two === "<>" ? two : ch);
			continue;
		}
		if ("+-*/^&".includes(ch)) push("op", ch);
		else if (ch === "(") push("lparen", ch);
		else if (ch === ")") push("rparen", ch);
		// `;` is the argument separator in comma-decimal locales of Excel.
		else if (ch === "," || ch === ";") push("sep", ch);
		else if (ch === ":") push("colon", ch);
		else if (ch === "!") push("bang", ch);
		else throw new FormulaError("#ERROR!", `Unexpected "${ch}"`);
	}
	return out;
}

interface RefParts {
	absCol: boolean;
	col: number;
	absRow: boolean;
	/** Model row: label minus one. -1 for the label `0`, which is a bad reference. */
	row: number;
}

function parseRef(text: string): RefParts {
	const m = REF_RE.exec(text);
	if (m === null) throw new FormulaError("#ERROR!", `Not a reference: ${text}`);
	return {
		absCol: m[1] === "$",
		col: colIndex(m[2]),
		absRow: m[3] === "$",
		row: Number.parseInt(m[4], 10) - 1,
	};
}

function formatRef(ref: RefParts): string {
	return `${ref.absCol ? "$" : ""}${colName(ref.col)}${ref.absRow ? "$" : ""}${ref.row + 1}`;
}

/* ------------------------------------------------------------------ parser */

type ArithmeticOp = "+" | "-" | "*" | "/" | "^";
type ComparisonOp = "=" | "<>" | "<" | "<=" | ">" | ">=";
/** `&` concatenates, as in Excel; everything else is an operator or a comparison. */
type BinaryOp = ArithmeticOp | ComparisonOp | "&";

type Node =
	| { kind: "num"; value: number }
	| { kind: "str"; value: string }
	| { kind: "ref"; row: number; col: number }
	| { kind: "range"; r1: number; c1: number; r2: number; c2: number }
	/** `Table2!B3` — a cell of another table in the same note, counted from the top. */
	| { kind: "xref"; table: number; row: number; col: number }
	| { kind: "xrange"; table: number; r1: number; c1: number; r2: number; c2: number }
	/** A column of the current row — only in `computeColumn` expressions. */
	| { kind: "col"; col: number }
	| { kind: "err"; code: FormulaErrorCode }
	| { kind: "neg"; arg: Node }
	| { kind: "bin"; op: BinaryOp; left: Node; right: Node }
	| { kind: "call"; fn: FunctionName; args: Node[] };

type FunctionName =
	| "SUM"
	| "AVERAGE"
	| "MIN"
	| "MAX"
	| "COUNT"
	| "COUNTA"
	| "MEDIAN"
	| "PRODUCT"
	| "ROUND"
	| "ABS"
	| "IF"
	| "IFERROR"
	| "AND"
	| "OR"
	| "NOT"
	| "TRUE"
	| "FALSE"
	| "SUMIF"
	| "SUMIFS"
	| "COUNTIF"
	| "COUNTIFS"
	| "AVERAGEIF"
	| "AVERAGEIFS"
	| "XLOOKUP"
	| "INDEX"
	| "MATCH"
	| "TODAY"
	| "NOW";

/** Canonical name and arity. AVG is accepted as an alias and exported to Excel as AVERAGE. */
const FUNCTIONS: Record<string, { fn: FunctionName; min: number; max: number }> = {
	SUM: { fn: "SUM", min: 1, max: 255 },
	AVERAGE: { fn: "AVERAGE", min: 1, max: 255 },
	AVG: { fn: "AVERAGE", min: 1, max: 255 },
	MIN: { fn: "MIN", min: 1, max: 255 },
	MAX: { fn: "MAX", min: 1, max: 255 },
	COUNT: { fn: "COUNT", min: 1, max: 255 },
	COUNTA: { fn: "COUNTA", min: 1, max: 255 },
	MEDIAN: { fn: "MEDIAN", min: 1, max: 255 },
	PRODUCT: { fn: "PRODUCT", min: 1, max: 255 },
	ROUND: { fn: "ROUND", min: 2, max: 2 },
	ABS: { fn: "ABS", min: 1, max: 1 },
	IF: { fn: "IF", min: 2, max: 3 },
	IFERROR: { fn: "IFERROR", min: 2, max: 2 },
	AND: { fn: "AND", min: 1, max: 255 },
	OR: { fn: "OR", min: 1, max: 255 },
	NOT: { fn: "NOT", min: 1, max: 1 },
	TRUE: { fn: "TRUE", min: 0, max: 0 },
	FALSE: { fn: "FALSE", min: 0, max: 0 },
	SUMIF: { fn: "SUMIF", min: 2, max: 3 },
	SUMIFS: { fn: "SUMIFS", min: 3, max: 255 },
	COUNTIF: { fn: "COUNTIF", min: 2, max: 2 },
	COUNTIFS: { fn: "COUNTIFS", min: 2, max: 255 },
	AVERAGEIF: { fn: "AVERAGEIF", min: 2, max: 3 },
	AVERAGEIFS: { fn: "AVERAGEIFS", min: 3, max: 255 },
	XLOOKUP: { fn: "XLOOKUP", min: 3, max: 4 },
	INDEX: { fn: "INDEX", min: 2, max: 3 },
	MATCH: { fn: "MATCH", min: 2, max: 3 },
	TODAY: { fn: "TODAY", min: 0, max: 0 },
	NOW: { fn: "NOW", min: 0, max: 0 },
};

/**
 * What the editor offers while a function name is being typed: the arguments, and one line saying
 * what it does. Kept next to `FUNCTIONS` and checked against it by a test, so a name cannot be
 * suggested that the parser would reject.
 */
export interface FormulaFunctionDoc {
	name: string;
	/** The arguments only — the editor renders `NAME(signature)`. Empty for a constant. */
	signature: string;
	summary: string;
}

/** In the order the list shows them with nothing typed: the ones a table actually uses. */
export const FORMULA_FUNCTIONS: readonly FormulaFunctionDoc[] = [
	{ name: "SUM", signature: "number, …", summary: "Adds the numbers in the arguments" },
	{ name: "IF", signature: "condition, then, else?", summary: "One value when a condition holds, another when it does not" },
	{ name: "AVERAGE", signature: "number, …", summary: "The mean of the numbers" },
	{ name: "COUNT", signature: "value, …", summary: "How many of the cells hold numbers" },
	{ name: "COUNTIF", signature: "range, condition", summary: "Counts the cells that match a condition" },
	{ name: "SUMIF", signature: "range, condition, sumRange?", summary: "Adds the cells whose neighbours match a condition" },
	{ name: "COUNTA", signature: "value, …", summary: "How many of the cells are not empty" },
	{ name: "MIN", signature: "number, …", summary: "The smallest number" },
	{ name: "MAX", signature: "number, …", summary: "The largest number" },
	{ name: "ROUND", signature: "number, digits", summary: "Rounds to a number of digits" },
	{ name: "ABS", signature: "number", summary: "The value without its sign" },
	{ name: "MEDIAN", signature: "number, …", summary: "The middle number" },
	{ name: "PRODUCT", signature: "number, …", summary: "Multiplies the numbers" },
	{ name: "IFERROR", signature: "value, fallback", summary: "A fallback when the first argument is an error" },
	{ name: "AND", signature: "condition, …", summary: "True when every condition holds" },
	{ name: "OR", signature: "condition, …", summary: "True when any condition holds" },
	{ name: "NOT", signature: "condition", summary: "The opposite of a condition" },
	{ name: "SUMIFS", signature: "sumRange, range, condition, …", summary: "Adds the cells that match several conditions" },
	{ name: "COUNTIFS", signature: "range, condition, …", summary: "Counts the cells that match several conditions" },
	{ name: "AVERAGEIF", signature: "range, condition, averageRange?", summary: "Averages the cells whose neighbours match a condition" },
	{ name: "AVERAGEIFS", signature: "averageRange, range, condition, …", summary: "Averages the cells that match several conditions" },
	{ name: "XLOOKUP", signature: "lookup, keys, results, ifNotFound?", summary: "The result beside the first key that matches — the lookup that survives an inserted column" },
	{ name: "INDEX", signature: "range, row, column?", summary: "The nth cell of a range, or the cell at a row and column in it" },
	{ name: "MATCH", signature: "lookup, range, exact?", summary: "Where in a range a value first appears" },
	{ name: "TODAY", signature: "", summary: "Today's date, as a number the grid shows as a date" },
	{ name: "NOW", signature: "", summary: "Today's date and the time of the recalculation" },
	{ name: "TRUE", signature: "", summary: "The constant true" },
	{ name: "FALSE", signature: "", summary: "The constant false" },
];

const ERROR_CODES: readonly FormulaErrorCode[] = ["#VALUE!", "#REF!", "#DIV/0!", "#N/A", "#CYCLE!", "#ERROR!", "#NUM!", "#NAME?"];

/** Resolves a bare column letter (`bracket` false) or a `[Header]` to a column index, or -1. */
type ColumnResolver = (name: string, bracket: boolean) => number;

/**
 * Recursive descent, Excel precedence: unary minus binds tighter than `^` (so `-2^2` is 4), and
 * `^` is left-associative (`2^3^2` is 64). Both surprise a mathematician, but the XLSX export
 * hands this same text to Excel, and the two must not compute different numbers.
 */
class Parser {
	private pos = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly columns: ColumnResolver | null,
	) {}

	parse(): Node {
		if (this.tokens.length === 0) throw new FormulaError("#ERROR!", "The formula is empty");
		const node = this.comparison();
		const extra = this.tokens[this.pos];
		if (extra !== undefined) throw new FormulaError("#ERROR!", `Unexpected "${extra.text}"`);
		return node;
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private next(): Token {
		const tok = this.tokens[this.pos];
		if (tok === undefined) throw new FormulaError("#ERROR!", "The formula ends too early");
		this.pos++;
		return tok;
	}

	private isOp(...ops: string[]): boolean {
		const tok = this.peek();
		return tok !== undefined && tok.type === "op" && ops.includes(tok.text);
	}

	/** Comparison binds loosest, so `A1+1>2` is `(A1+1)>2`, as in Excel. */
	private comparison(): Node {
		let left = this.concat();
		while (this.isOp("=", "<>", "<", "<=", ">", ">=")) {
			const op = this.next().text as ComparisonOp;
			left = { kind: "bin", op, left, right: this.concat() };
		}
		return left;
	}

	private concat(): Node {
		let left = this.additive();
		while (this.isOp("&")) {
			this.next();
			left = { kind: "bin", op: "&", left, right: this.additive() };
		}
		return left;
	}

	private additive(): Node {
		let left = this.multiplicative();
		while (this.isOp("+", "-")) {
			const op = this.next().text as BinaryOp;
			left = { kind: "bin", op, left, right: this.multiplicative() };
		}
		return left;
	}

	private multiplicative(): Node {
		let left = this.power();
		while (this.isOp("*", "/")) {
			const op = this.next().text as BinaryOp;
			left = { kind: "bin", op, left, right: this.power() };
		}
		return left;
	}

	private power(): Node {
		let left = this.signed();
		while (this.isOp("^")) {
			this.next();
			left = { kind: "bin", op: "^", left, right: this.signed() };
		}
		return left;
	}

	private signed(): Node {
		if (this.isOp("-")) {
			this.next();
			return { kind: "neg", arg: this.signed() };
		}
		if (this.isOp("+")) {
			this.next();
			return this.signed();
		}
		return this.primary();
	}

	private primary(): Node {
		const tok = this.next();
		switch (tok.type) {
			case "num":
				return { kind: "num", value: Number.parseFloat(tok.text) };
			case "str":
				return { kind: "str", value: tok.text.slice(1, -1).replace(/""/g, '"') };
			case "error":
				return { kind: "err", code: errorCodeOf(tok.text) };
			case "ref": {
				const a = parseRef(tok.text);
				if (this.peek()?.type !== "colon") return { kind: "ref", row: a.row, col: a.col };
				this.next();
				const endTok = this.next();
				if (endTok.type !== "ref") throw new FormulaError("#ERROR!", `Expected a cell after "${tok.text}:"`);
				const b = parseRef(endTok.text);
				return {
					kind: "range",
					r1: Math.min(a.row, b.row),
					c1: Math.min(a.col, b.col),
					r2: Math.max(a.row, b.row),
					c2: Math.max(a.col, b.col),
				};
			}
			case "name":
			case "bracket": {
				// `TRUE` and `FALSE` are constants in Excel, with or without the parentheses.
				const constant = tok.type === "name" ? tok.text.toUpperCase() : "";
				if (constant === "TRUE" || constant === "FALSE") return { kind: "call", fn: constant, args: [] };
				// `Table2!B3` reaches into another table of the same note, which is the only way to
				// say "that table over there" without storing a name anywhere.
				if (tok.type === "name" && this.peek()?.type === "bang") return this.crossReference(tok);
				const col = this.columns === null ? -1 : this.columns(tok.text, tok.type === "bracket");
				if (col < 0) throw new FormulaError("#NAME?", `Unknown name: ${tok.text}`);
				return { kind: "col", col };
			}
			case "func":
				return this.call(tok);
			case "lparen": {
				const inner = this.comparison();
				if (this.next().type !== "rparen") throw new FormulaError("#ERROR!", 'Missing ")"');
				return inner;
			}
			default:
				throw new FormulaError("#ERROR!", `Unexpected "${tok.text}"`);
		}
	}

	/** `Name!B3` or `Name!B3:C7`; anything but `Table<number>` is refused with a reason. */
	private crossReference(tok: Token): Node {
		const table = tableIndexOf(tok.text);
		if (table < 0) throw new FormulaError("#NAME?", `"${tok.text}" is not a table name — use Table1, Table2, …`);
		this.next(); // the `!`
		const first = this.next();
		if (first.type !== "ref") throw new FormulaError("#ERROR!", `Expected a cell after "${tok.text}!"`);
		const a = parseRef(first.text);
		if (this.peek()?.type !== "colon") return { kind: "xref", table, row: a.row, col: a.col };
		this.next();
		const endTok = this.next();
		if (endTok.type !== "ref") throw new FormulaError("#ERROR!", `Expected a cell after "${tok.text}!${first.text}:"`);
		const b = parseRef(endTok.text);
		return {
			kind: "xrange",
			table,
			r1: Math.min(a.row, b.row),
			c1: Math.min(a.col, b.col),
			r2: Math.max(a.row, b.row),
			c2: Math.max(a.col, b.col),
		};
	}

	private call(tok: Token): Node {
		const spec = FUNCTIONS[tok.text.toUpperCase()];
		if (spec === undefined) throw new FormulaError("#NAME?", `Unknown function: ${tok.text}`);
		this.next(); // (
		const args: Node[] = [];
		if (this.peek()?.type !== "rparen") {
			for (;;) {
				args.push(this.comparison());
				if (this.peek()?.type !== "sep") break;
				this.next();
			}
		}
		if (this.next().type !== "rparen") throw new FormulaError("#ERROR!", `Missing ")" after ${spec.fn}`);
		if (args.length < spec.min || args.length > spec.max) {
			const want = spec.min === spec.max ? `${spec.min}` : `at least ${spec.min}`;
			throw new FormulaError("#ERROR!", `${spec.fn} takes ${want} ${spec.min === 1 && spec.max === 1 ? "argument" : "arguments"}`);
		}
		return { kind: "call", fn: spec.fn, args };
	}
}

/** `Table3` is the third table of the note, counted the way a reader counts them. -1 for anything else. */
function tableIndexOf(word: string): number {
	const m = /^Table(\d+)$/i.exec(word);
	if (m === null) return -1;
	const n = Number.parseInt(m[1], 10);
	return n >= 1 ? n - 1 : -1;
}

function errorCodeOf(text: string): FormulaErrorCode {
	const upper = text.toUpperCase();
	return ERROR_CODES.find((c) => c === upper) ?? "#ERROR!";
}

function parseExpr(expr: string, columns: ColumnResolver | null = null): Node {
	return new Parser(tokenize(expr), columns).parse();
}

/* -------------------------------------------------------------- evaluation */

/**
 * What a formula works with. Cells only ever hold the first four; booleans and text results exist
 * so that `IF`, comparisons and `&` can be written at all.
 */
type CellValue =
	| { t: "empty" }
	| { t: "num"; n: number }
	| { t: "text"; s: string }
	| { t: "bool"; b: boolean }
	/** `message` explains the error to the user; it never reaches the note. */
	| { t: "err"; code: FormulaErrorCode; message?: string };

export interface CellSource {
	value(row: number, col: number): CellValue;
	/** Rows and columns that can hold anything; a range is clipped to them. */
	rows: number;
	cols: number;
}

interface EvalContext {
	source: CellSource;
	/** The current row, for `col` nodes. */
	row: number;
	/** How text is read as a number, for criteria such as `">1 200"`. */
	numberOpts?: NumberParseOptions;
	/** The other tables of the note, by position: `Table2!B3` reads `tables[1]`. */
	tables?: ReadonlyArray<CellSource | null>;
}

function refValue(ctx: EvalContext, row: number, col: number): CellValue {
	if (row < 0 || col < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
	return ctx.source.value(row, col);
}

/** One of the note's other tables, or a `#REF!` that says which number was missing. */
function tableSource(ctx: EvalContext, table: number): CellSource {
	const source = ctx.tables?.[table];
	if (source === undefined || source === null) {
		throw new FormulaError("#REF!", `This note has no Table ${table + 1}`);
	}
	return source;
}

function classify(raw: string, numberOpts?: NumberParseOptions): CellValue {
	const shown = stripFormula(raw);
	if (shown.trim() === "") return { t: "empty" };
	// A date is text in the note and a serial number in a formula, as it was in Excel: `B2-A2`
	// has to be a count of days. Numbers stay numbers everywhere else — sorting and the series
	// filler have their own, calendar-aware reading of a date.
	const n = parseNumber(shown, numberOpts) ?? serialFromIsoDate(stripInlineMarkdown(shown));
	return n === null ? { t: "text", s: shown.trim() } : { t: "num", n };
}

/**
 * A number out of any value: empty counts as 0, a boolean as 1 or 0, text is an error. Excel
 * agrees except on text that looks like a number, where it coerces silently; refusing is the
 * honest behaviour for a note, where a stray word in a sum is nearly always a mistake.
 */
function toNumber(v: CellValue): number {
	switch (v.t) {
		case "empty":
			return 0;
		case "num":
			return v.n;
		case "bool":
			return v.b ? 1 : 0;
		case "text":
			throw new FormulaError("#VALUE!", "Text where a number was expected");
		case "err":
			throw new FormulaError(v.code, v.message ?? `A referenced cell shows ${v.code}`);
	}
}

/** How a value reads when it is concatenated, compared as text, or written into a cell. */
function toText(v: CellValue): string {
	switch (v.t) {
		case "empty":
			return "";
		case "num":
			return String(clean(v.n));
		case "bool":
			return v.b ? "TRUE" : "FALSE";
		case "text":
			return v.s;
		case "err":
			throw new FormulaError(v.code, v.message ?? `A referenced cell shows ${v.code}`);
	}
}

function toBool(v: CellValue): boolean {
	switch (v.t) {
		case "empty":
			return false;
		case "num":
			return v.n !== 0;
		case "bool":
			return v.b;
		case "text":
			throw new FormulaError("#VALUE!", "Text where a condition was expected");
		case "err":
			throw new FormulaError(v.code, v.message ?? `A referenced cell shows ${v.code}`);
	}
}

/** Excel's type order: numbers before text before booleans. */
function typeRank(v: CellValue): number {
	switch (v.t) {
		case "num":
		case "empty":
			return 0;
		case "text":
			return 1;
		case "bool":
			return 2;
		case "err":
			return 3;
	}
}

/** An empty cell takes the type of the other side: `=""` is true, `=0` is true, so is `=FALSE`. */
function blankLike(v: CellValue): CellValue {
	switch (v.t) {
		case "num":
			return { t: "num", n: 0 };
		case "text":
			return { t: "text", s: "" };
		case "bool":
			return { t: "bool", b: false };
		default:
			return { t: "empty" };
	}
}

/** Negative, zero or positive, the way a three-way comparison wants it. Text compares without case. */
function compareValues(a: CellValue, b: CellValue): number {
	if (a.t === "err") throw new FormulaError(a.code, a.message ?? `A referenced cell shows ${a.code}`);
	if (b.t === "err") throw new FormulaError(b.code, b.message ?? `A referenced cell shows ${b.code}`);
	const left = a.t === "empty" && b.t !== "empty" ? blankLike(b) : a;
	const right = b.t === "empty" && a.t !== "empty" ? blankLike(a) : b;
	if (left.t !== right.t) return typeRank(left) - typeRank(right);
	if (left.t === "num" && right.t === "num") return left.n === right.n ? 0 : left.n < right.n ? -1 : 1;
	if (left.t === "bool" && right.t === "bool") return Number(left.b) - Number(right.b);
	if (left.t === "text" && right.t === "text") {
		const l = left.s.toLowerCase();
		const r = right.s.toLowerCase();
		return l === r ? 0 : l < r ? -1 : 1;
	}
	return 0;
}

const COMPARISON_OPS: readonly string[] = ["=", "<>", "<", "<=", ">", ">="];

function isComparison(op: BinaryOp): op is ComparisonOp {
	return COMPARISON_OPS.includes(op);
}

function comparisonHolds(op: ComparisonOp, d: number): boolean {
	switch (op) {
		case "=":
			return d === 0;
		case "<>":
			return d !== 0;
		case "<":
			return d < 0;
		case "<=":
			return d <= 0;
		case ">":
			return d > 0;
		case ">=":
			return d >= 0;
	}
}

function evalValue(node: Node, ctx: EvalContext): CellValue {
	switch (node.kind) {
		case "num":
			return { t: "num", n: node.value };
		case "str":
			return { t: "text", s: node.value };
		case "err":
			throw new FormulaError(node.code, node.code === "#REF!" ? "Reference to a deleted row or column" : `The formula contains ${node.code}`);
		case "ref":
			return refValue(ctx, node.row, node.col);
		case "col":
			return refValue(ctx, ctx.row, node.col);
		case "xref": {
			if (node.row < 0 || node.col < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
			const source = tableSource(ctx, node.table);
			// Past the last row or column of that table there is no cell to read: a typo has to say so
			// instead of quietly adding zero (which is how an off-by-one slipped through once).
			if (node.row >= source.rows || node.col >= source.cols) {
				throw new FormulaError("#REF!", `Table${node.table + 1} has no ${colName(node.col)}${node.row + 1} — it ends at ${colName(Math.max(source.cols - 1, 0))}${source.rows}`);
			}
			return source.value(node.row, node.col);
		}
		case "range":
		case "xrange":
			throw new FormulaError("#VALUE!", "A range can only be used inside a function");
		case "neg":
			return { t: "num", n: -toNumber(evalValue(node.arg, ctx)) };
		case "bin": {
			if (node.op === "&") {
				return { t: "text", s: toText(evalValue(node.left, ctx)) + toText(evalValue(node.right, ctx)) };
			}
			if (isComparison(node.op)) {
				const d = compareValues(evalValue(node.left, ctx), evalValue(node.right, ctx));
				return { t: "bool", b: comparisonHolds(node.op, d) };
			}
			return { t: "num", n: binary(node.op, toNumber(evalValue(node.left, ctx)), toNumber(evalValue(node.right, ctx))) };
		}
		case "call":
			return evalCall(node.fn, node.args, ctx);
	}
}

function evalNum(node: Node, ctx: EvalContext): number {
	return toNumber(evalValue(node, ctx));
}

function binary(op: ArithmeticOp, a: number, b: number): number {
	let out: number;
	switch (op) {
		case "+":
			out = a + b;
			break;
		case "-":
			out = a - b;
			break;
		case "*":
			out = a * b;
			break;
		case "/":
			if (b === 0) throw new FormulaError("#DIV/0!", "Division by zero");
			out = a / b;
			break;
		case "^":
			if (a === 0 && b < 0) throw new FormulaError("#DIV/0!", "Division by zero");
			out = a ** b;
			break;
	}
	if (!Number.isFinite(out)) throw new FormulaError("#NUM!", "The result is not a finite number");
	return out;
}

interface Collected {
	nums: number[];
	/** Non-empty cells, numeric or not — what COUNTA counts. */
	filled: number;
}

/**
 * Gathers the arguments of an aggregate the way Excel does: a referenced cell holding text or
 * nothing is skipped, while an expression argument must be a number. COUNT and COUNTA ignore error
 * cells (COUNTA counts them as filled); every other function propagates them.
 */
function collect(args: Node[], ctx: EvalContext, tolerateErrors: boolean): Collected {
	const out: Collected = { nums: [], filled: 0 };
	const take = (v: CellValue): void => {
		if (v.t === "empty") return;
		out.filled++;
		if (v.t === "num") out.nums.push(v.n);
		else if (v.t === "bool") out.nums.push(v.b ? 1 : 0);
		else if (v.t === "err" && !tolerateErrors) throw new FormulaError(v.code, v.message ?? `A referenced cell shows ${v.code}`);
	};
	for (const arg of args) {
		if (arg.kind === "range") {
			if (arg.r1 < 0 || arg.c1 < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
			const r2 = Math.min(arg.r2, ctx.source.rows - 1);
			const c2 = Math.min(arg.c2, ctx.source.cols - 1);
			for (let r = arg.r1; r <= r2; r++) {
				for (let c = arg.c1; c <= c2; c++) take(ctx.source.value(r, c));
			}
		} else if (arg.kind === "xrange") {
			if (arg.r1 < 0 || arg.c1 < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
			const source = tableSource(ctx, arg.table);
			if (arg.r1 >= source.rows || arg.c1 >= source.cols) {
				throw new FormulaError("#REF!", `Table${arg.table + 1} has no ${colName(arg.c1)}${arg.r1 + 1} — it ends at ${colName(Math.max(source.cols - 1, 0))}${source.rows}`);
			}
			// Clipping at the end is deliberate: `Table1!B2:B99` over a short table reads what exists.
			const r2 = Math.min(arg.r2, source.rows - 1);
			const c2 = Math.min(arg.c2, source.cols - 1);
			for (let r = arg.r1; r <= r2; r++) {
				for (let c = arg.c1; c <= c2; c++) take(source.value(r, c));
			}
		} else if (arg.kind === "xref") {
			if (arg.row < 0 || arg.col < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
			take(tableSource(ctx, arg.table).value(arg.row, arg.col));
		} else if (arg.kind === "ref") {
			take(refValue(ctx, arg.row, arg.col));
		} else if (arg.kind === "col") {
			take(refValue(ctx, ctx.row, arg.col));
		} else {
			out.nums.push(evalNum(arg, ctx));
			out.filled++;
		}
	}
	return out;
}

/** The operands of AND and OR: text and empties inside references are skipped, as in Excel. */
function logicalOperands(args: Node[], ctx: EvalContext): boolean[] {
	const out: boolean[] = [];
	for (const arg of args) {
		if (arg.kind === "range" || arg.kind === "ref" || arg.kind === "col" || arg.kind === "xrange" || arg.kind === "xref") {
			for (const v of valuesOf(arg, ctx)) {
				if (v.t === "num") out.push(v.n !== 0);
				else if (v.t === "bool") out.push(v.b);
				else if (v.t === "err") throw new FormulaError(v.code, v.message ?? `A referenced cell shows ${v.code}`);
			}
			continue;
		}
		out.push(toBool(evalValue(arg, ctx)));
	}
	return out;
}

/** A model as a formula source, so a workbook pass can read every table of a note. */
export function sourceOf(model: GridModel, numberOpts?: NumberParseOptions): CellSource {
	let rows = model.usedRange.rows;
	let cols = model.usedRange.cols;
	for (const [key, cell] of model.cells) {
		const { row, col } = parseAddrKey(key);
		rows = Math.max(rows, row + 1);
		cols = Math.max(cols, col + 1);
		void cell;
	}
	return {
		rows,
		cols,
		value: (row, col) => classify(getRaw(model, row, col), numberOpts),
	};
}

interface Rect {
	r1: number;
	c1: number;
	r2: number;
	c2: number;
}

/** A range and the table it lives in — the same table, unless the formula names another one. */
interface RectRef {
	rect: Rect;
	source: CellSource;
}

/** A range argument, clipped to what its table can hold; a single reference is a 1×1 range. */
function rectOf(node: Node, ctx: EvalContext): RectRef {
	const clip = (r1: number, c1: number, r2: number, c2: number, source: CellSource): RectRef => ({
		rect: {
			r1,
			c1,
			r2: Math.min(r2, Math.max(source.rows - 1, r1)),
			c2: Math.min(c2, Math.max(source.cols - 1, c1)),
		},
		source,
	});
	if (node.kind === "range") {
		if (node.r1 < 0 || node.c1 < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
		return clip(node.r1, node.c1, node.r2, node.c2, ctx.source);
	}
	if (node.kind === "xrange") {
		if (node.r1 < 0 || node.c1 < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
		return clip(node.r1, node.c1, node.r2, node.c2, tableSource(ctx, node.table));
	}
	if (node.kind === "ref") return { rect: { r1: node.row, c1: node.col, r2: node.row, c2: node.col }, source: ctx.source };
	if (node.kind === "xref") {
		return { rect: { r1: node.row, c1: node.col, r2: node.row, c2: node.col }, source: tableSource(ctx, node.table) };
	}
	if (node.kind === "col") return { rect: { r1: ctx.row, c1: node.col, r2: ctx.row, c2: node.col }, source: ctx.source };
	throw new FormulaError("#VALUE!", "A range is expected here");
}

/** A range argument read into a flat list, row by row, with its rectangle for indexing. */
function rangeValues(node: Node, ctx: EvalContext): { values: CellValue[]; rect: Rect } {
	const { rect, source } = rectOf(node, ctx);
	const values: CellValue[] = [];
	for (let r = rect.r1; r <= rect.r2; r++) {
		for (let c = rect.c1; c <= rect.c2; c++) values.push(source.value(r, c));
	}
	return { values, rect };
}

function* valuesOf(node: Node, ctx: EvalContext): Generator<CellValue> {
	const { rect, source } = rectOf(node, ctx);
	for (let r = rect.r1; r <= rect.r2; r++) {
		for (let c = rect.c1; c <= rect.c2; c++) yield source.value(r, c);
	}
}

const CRITERIA_RE = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/;

function escapeRegExp(ch: string): string {
	return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Excel's `*` and `?` wildcards, with `~` escaping them. Null when the text has no wildcard. */
function wildcardRegex(body: string): RegExp | null {
	let wild = false;
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "~" && i + 1 < body.length) {
			out += escapeRegExp(body[i + 1]);
			i++;
		} else if (ch === "*") {
			out += "[\\s\\S]*";
			wild = true;
		} else if (ch === "?") {
			out += "[\\s\\S]";
			wild = true;
		} else {
			out += escapeRegExp(ch);
		}
	}
	return wild ? new RegExp(`^${out}$`, "i") : null;
}

function compareNumber(actual: number, target: number, op: ComparisonOp): boolean {
	return comparisonHolds(op, actual === target ? 0 : actual < target ? -1 : 1);
}

/**
 * Turns a criterion into a test: a number matches numbers, `">100"` matches numbers above 100,
 * `"Movers"` matches text without case, `"*ov*"` uses wildcards, and `""` with `=` or `<>`
 * matches empty or non-empty cells.
 */
function predicateFor(crit: CellValue, numberOpts?: NumberParseOptions): (v: CellValue) => boolean {
	if (crit.t === "num") return (v) => v.t === "num" && v.n === crit.n;
	if (crit.t === "bool") return (v) => v.t === "bool" && v.b === crit.b;
	if (crit.t === "err") throw new FormulaError(crit.code, "A condition cannot be an error");
	const m = CRITERIA_RE.exec(crit.t === "text" ? crit.s : "");
	const op = (m?.[1] ?? "=") as ComparisonOp;
	const body = m?.[2] ?? "";
	if (body === "") {
		const empty = (v: CellValue): boolean => v.t === "empty";
		return op === "<>" ? (v) => !empty(v) : empty;
	}
	const number = parseNumber(body, numberOpts);
	if (number !== null) return (v) => v.t === "num" && compareNumber(v.n, number, op);
	const wildcard = wildcardRegex(body);
	const same = (v: CellValue): boolean => v.t !== "empty" && (wildcard?.test(toText(v)) ?? toText(v).toLowerCase() === body.toLowerCase());
	if (op === "=") return same;
	if (op === "<>") return (v) => v.t !== "empty" && !same(v);
	return (v) => {
		if (v.t === "empty") return false;
		const s = toText(v).toLowerCase();
		const b = body.toLowerCase();
		return comparisonHolds(op, s === b ? 0 : s < b ? -1 : 1);
	};
}

/**
 * SUMIF/COUNTIF/AVERAGEIF and their plural forms.
 *
 * The singular form pairs the criteria range with the sum range by offset; the plural form walks
 * every criteria/value pair over the first range's rectangle, which is how Excel defines it: all
 * ranges must be the same shape, and a shorter one reads as empty rather than as an error.
 */
function conditionalAggregate(fn: FunctionName, args: Node[], ctx: EvalContext): CellValue {
	const counting = fn === "COUNTIF" || fn === "COUNTIFS";
	const plural = fn === "SUMIFS" || fn === "COUNTIFS" || fn === "AVERAGEIFS";
	// The plural forms take criteria in pairs; the ones that also sum take a value range first.
	const remainder = counting ? 0 : 1;
	if (plural && args.length % 2 !== remainder) {
		throw new FormulaError("#VALUE!", `${fn} needs a value range and a condition for every range`);
	}
	const pairs: Array<{ rect: Rect; source: CellSource; test: (v: CellValue) => boolean }> = [];
	let sums: RectRef | null = null;
	if (plural) {
		if (!counting) sums = rectOf(args[0], ctx);
		for (let i = counting ? 0 : 1; i + 1 < args.length; i += 2) {
			const pair = rectOf(args[i], ctx);
			pairs.push({ ...pair, test: predicateFor(evalValue(args[i + 1], ctx), ctx.numberOpts) });
		}
	} else {
		const criteria = rectOf(args[0], ctx);
		pairs.push({ ...criteria, test: predicateFor(evalValue(args[1], ctx), ctx.numberOpts) });
		// Without a third argument Excel sums the criteria range itself.
		if (!counting) sums = args.length > 2 ? rectOf(args[2], ctx) : criteria;
	}
	const frame = pairs[0].rect;
	const rows = frame.r2 - frame.r1 + 1;
	const cols = frame.c2 - frame.c1 + 1;
	let matched = 0;
	const nums: number[] = [];
	for (let dr = 0; dr < rows; dr++) {
		for (let dc = 0; dc < cols; dc++) {
			const hit = pairs.every(({ rect, source, test }) => {
				const r = rect.r1 + dr;
				const c = rect.c1 + dc;
				return test(r <= rect.r2 && c <= rect.c2 ? source.value(r, c) : { t: "empty" });
			});
			if (!hit) continue;
			matched++;
			if (sums === null) continue;
			const r = sums.rect.r1 + dr;
			const c = sums.rect.c1 + dc;
			if (r > sums.rect.r2 || c > sums.rect.c2) continue;
			const v = sums.source.value(r, c);
			if (v.t === "num") nums.push(v.n);
			else if (v.t === "err") throw new FormulaError(v.code, v.message ?? `A referenced cell shows ${v.code}`);
		}
	}
	if (counting) return { t: "num", n: matched };
	const total = nums.reduce((a, n) => a + n, 0);
	if (fn === "AVERAGEIF" || fn === "AVERAGEIFS") {
		if (nums.length === 0) throw new FormulaError("#DIV/0!", "No matching number to average");
		return { t: "num", n: total / nums.length };
	}
	return { t: "num", n: total };
}

function evalCall(fn: FunctionName, args: Node[], ctx: EvalContext): CellValue {
	switch (fn) {
		case "IF": {
			const cond = toBool(evalValue(args[0], ctx));
			// Only the branch that is taken is evaluated, as in Excel: the other one may divide by zero.
			if (cond) return evalValue(args[1], ctx);
			return args.length > 2 ? evalValue(args[2], ctx) : { t: "empty" };
		}
		case "IFERROR":
			try {
				return evalValue(args[0], ctx);
			} catch (e) {
				if (!(e instanceof FormulaError)) throw e;
				return evalValue(args[1], ctx);
			}
		case "AND":
		case "OR": {
			const operands = logicalOperands(args, ctx);
			if (operands.length === 0) throw new FormulaError("#VALUE!", `${fn} of no values`);
			return { t: "bool", b: fn === "AND" ? operands.every(Boolean) : operands.some(Boolean) };
		}
		case "NOT":
			return { t: "bool", b: !toBool(evalValue(args[0], ctx)) };
		case "TODAY":
			return { t: "num", n: todaySerial() };
		case "NOW":
			return { t: "num", n: nowSerial() };
		case "TRUE":
			return { t: "bool", b: true };
		case "FALSE":
			return { t: "bool", b: false };
		case "SUMIF":
		case "COUNTIF":
		case "AVERAGEIF":
		case "SUMIFS":
		case "COUNTIFS":
		case "AVERAGEIFS":
			return conditionalAggregate(fn, args, ctx);
		case "ROUND":
			return { t: "num", n: round(evalNum(args[0], ctx), Math.trunc(evalNum(args[1], ctx))) };
		case "ABS":
			return { t: "num", n: Math.abs(evalNum(args[0], ctx)) };
		case "XLOOKUP": {
			const needle = evalValue(args[0], ctx);
			const keys = rangeValues(args[1], ctx).values;
			const results = rangeValues(args[2], ctx).values;
			if (keys.length !== results.length) {
				throw new FormulaError("#VALUE!", `XLOOKUP has ${keys.length} keys for ${results.length} results — they have to line up`);
			}
			const at = keys.findIndex((key) => compareValues(key, needle) === 0);
			if (at === -1) {
				if (args.length > 3) return evalValue(args[3], ctx);
				throw new FormulaError("#N/A", "XLOOKUP found no match");
			}
			return results[at];
		}
		case "MATCH": {
			if (args.length > 2 && evalNum(args[2], ctx) !== 0) {
				// Approximate matching needs a sorted range and an Excel-defined tie-break; a note
				// that says a value is "near" this one is a recipe for a wrong answer nobody sees.
				throw new FormulaError("#VALUE!", "MATCH here is exact — the third argument must be 0 or left out");
			}
			const needle = evalValue(args[0], ctx);
			const values = rangeValues(args[1], ctx).values;
			const at = values.findIndex((value) => compareValues(value, needle) === 0);
			if (at === -1) throw new FormulaError("#N/A", "MATCH found no match");
			return { t: "num", n: at + 1 };
		}
		case "INDEX": {
			const { values, rect } = rangeValues(args[0], ctx);
			const rows = rect.r2 - rect.r1 + 1;
			const cols = rect.c2 - rect.c1 + 1;
			let row = Math.trunc(evalNum(args[1], ctx));
			let col = args.length > 2 ? Math.trunc(evalNum(args[2], ctx)) : 1;
			// A single row (or column) is a vector, and one number walks along it, as in Excel.
			if (args.length === 2 && rows === 1) {
				col = row;
				row = 1;
			}
			if (row < 1 || row > rows || col < 1 || col > cols) {
				throw new FormulaError("#REF!", `INDEX asks for ${row}, ${col} in a ${rows} × ${cols} range`);
			}
			return values[(row - 1) * cols + (col - 1)];
		}
		case "COUNT":
			return { t: "num", n: collect(args, ctx, true).nums.length };
		case "COUNTA":
			return { t: "num", n: collect(args, ctx, true).filled };
		default:
			break;
	}
	const { nums } = collect(args, ctx, false);
	switch (fn) {
		case "SUM":
			return { t: "num", n: nums.reduce((a, n) => a + n, 0) };
		case "AVERAGE":
			if (nums.length === 0) throw new FormulaError("#DIV/0!", "AVERAGE of no numbers");
			return { t: "num", n: nums.reduce((a, n) => a + n, 0) / nums.length };
		case "MIN":
			return { t: "num", n: nums.length === 0 ? 0 : nums.reduce((a, n) => (n < a ? n : a), nums[0]) };
		case "MAX":
			return { t: "num", n: nums.length === 0 ? 0 : nums.reduce((a, n) => (n > a ? n : a), nums[0]) };
		case "PRODUCT":
			return { t: "num", n: nums.length === 0 ? 0 : nums.reduce((a, n) => a * n, 1) };
		case "MEDIAN": {
			if (nums.length === 0) throw new FormulaError("#NUM!", "MEDIAN of no numbers");
			const sorted = nums.slice().sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return { t: "num", n: sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 };
		}
		default:
			throw new FormulaError("#NAME?", "Unknown function");
	}
}

/** Today at midnight on this machine's calendar, as a serial — Excel's TODAY is local, not UTC. */
function todaySerial(): number {
	const now = new Date();
	return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000 + 25569;
}

function nowSerial(): number {
	const now = new Date();
	const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
	return todaySerial() + seconds / 86_400;
}

/** Half away from zero, like Excel; the epsilon nudge makes ROUND(1.005, 2) give 1.01. */
function round(x: number, digits: number): number {
	const sign = x < 0 ? -1 : 1;
	const abs = Math.abs(x);
	if (digits >= 0) {
		const f = 10 ** Math.min(digits, 15);
		return (sign * Math.round(abs * f * (1 + Number.EPSILON))) / f;
	}
	const f = 10 ** Math.min(-digits, 308);
	return sign * Math.round(abs / f) * f;
}

/**
 * Trims binary noise to the 15 significant digits Excel works with, so `0.1 + 0.2` is written as
 * 0.3 whatever the format callback does with it.
 */
function clean(n: number): number {
	const v = Number.parseFloat(n.toPrecision(15));
	return v === 0 ? 0 : v;
}

/**
 * A text result has to survive as a note cell: one line, no comment markers. A pipe is left alone
 * because the serializer escapes it.
 */
function cellText(s: string): string {
	return s.replace(/\r?\n/g, " ").replace(/%%/g, "% %").trim();
}

/** What a non-numeric result looks like inside the cell. */
function displayText(v: CellValue): string {
	switch (v.t) {
		case "num":
			return String(clean(v.n));
		case "text":
			return cellText(v.s);
		case "bool":
			return v.b ? "TRUE" : "FALSE";
		case "empty":
			return "";
		case "err":
			return v.code;
	}
}

/* ------------------------------------------------------------ recalculation */

export interface RecalcOptions {
	numberOpts?: NumberParseOptions;
	/** Turns a computed value into the cell's display text. */
	format: (value: number) => string;
	/** The note's other tables, by position, so `Table2!B3` can be read. */
	tables?: ReadonlyArray<CellSource | null>;
}

export interface FormulaIssue {
	row: number;
	col: number;
	code: FormulaErrorCode;
	message: string;
}

export interface RecalcResult {
	changed: Array<{ row: number; col: number }>;
	errors: FormulaIssue[];
}

interface FormulaEntry {
	key: CellAddr;
	row: number;
	col: number;
	raw: string;
	cell: FormulaCell;
	ast: Node | null;
	parseError: FormulaError | null;
}

/**
 * Recomputes every formula cell and writes the display values back.
 *
 * Order is a topological sort (Kahn) over formula-to-formula references, so no cell is evaluated
 * before what it reads and nothing recurses through the cells — a running total down two thousand
 * rows would otherwise be two thousand nested calls. Whatever is left when the sort runs dry is on
 * a cycle or downstream of one, and shows `#CYCLE!`.
 *
 * A cell is only written when its text actually changes, so an unchanged table stays clean.
 */
export function recalculate(model: GridModel, opts: RecalcOptions): RecalcResult {
	const entries = new Map<CellAddr, FormulaEntry>();
	let rows = 0;
	let cols = 0;
	for (const [key, cell] of model.cells) {
		const { row, col } = parseAddrKey(key);
		rows = Math.max(rows, row + 1);
		cols = Math.max(cols, col + 1);
		const f = parseFormulaCell(cell.raw);
		if (f === null) continue;
		let ast: Node | null = null;
		let parseError: FormulaError | null = null;
		try {
			ast = parseExpr(f.expr);
		} catch (e) {
			parseError = asFormulaError(e);
		}
		entries.set(key, { key, row, col, raw: cell.raw, cell: f, ast, parseError });
	}
	if (entries.size === 0) return { changed: [], errors: [] };

	const computed = new Map<CellAddr, CellValue>();
	const source: CellSource = {
		rows,
		cols,
		value(row, col) {
			const key = addrKey(row, col);
			if (entries.has(key)) return computed.get(key) ?? { t: "err", code: "#CYCLE!" };
			return classify(getRaw(model, row, col), opts.numberOpts);
		},
	};

	// Dependency graph between formula cells.
	const all = Array.from(entries.values()).sort((a, b) => a.row - b.row || a.col - b.col);
	const pending = new Map<CellAddr, number>();
	const dependents = new Map<CellAddr, CellAddr[]>();
	for (const entry of all) {
		const deps = entry.ast === null ? new Set<CellAddr>() : formulaDeps(entry.ast, all);
		pending.set(entry.key, deps.size);
		for (const dep of deps) {
			const list = dependents.get(dep);
			if (list === undefined) dependents.set(dep, [entry.key]);
			else list.push(entry.key);
		}
	}

	const queue = all.filter((e) => pending.get(e.key) === 0);
	for (let qi = 0; qi < queue.length; qi++) {
		const entry = queue[qi];
		computed.set(entry.key, evaluateEntry(entry, source, opts));
		for (const dependent of dependents.get(entry.key) ?? []) {
			const left = (pending.get(dependent) ?? 0) - 1;
			pending.set(dependent, left);
			if (left === 0) {
				const next = entries.get(dependent);
				if (next !== undefined) queue.push(next);
			}
		}
	}
	for (const entry of all) {
		if (!computed.has(entry.key)) computed.set(entry.key, { t: "err", code: "#CYCLE!", message: "Circular reference" });
	}

	const result: RecalcResult = { changed: [], errors: [] };
	for (const entry of all) {
		const value = computed.get(entry.key);
		if (value === undefined) continue;
		let text: string;
		if (value.t === "num") {
			const n = clean(value.n);
			const asDate = dateText(entry, n);
			if (asDate !== null) {
				text = asDate;
			} else {
				// A display that already reads as this number stays as written. Formatting is locale
				// dependent, and rewriting "1 200" as "1,200" on another machine would make every open
				// on that machine an edit — two devices would rewrite the note back and forth forever.
				const shown = parseNumber(entry.cell.display, opts.numberOpts);
				if (shown !== null && Math.abs(shown - n) <= 1e-9 * Math.max(1, Math.abs(shown))) continue;
				text = opts.format(n);
			}
		} else if (value.t === "text") {
			text = cellText(value.s);
		} else if (value.t === "bool") {
			text = value.b ? "TRUE" : "FALSE";
		} else if (value.t === "empty") {
			text = "";
		} else {
			text = value.code;
			result.errors.push({ row: entry.row, col: entry.col, code: value.code, message: value.message ?? "The formula cannot be evaluated" });
		}
		const next = withMarkerComments(buildFormulaCell(withLayersOf(entry.cell.display, text), entry.cell.expr), entry.raw);
		if (next !== entry.raw) {
			setRaw(model, entry.row, entry.col, next);
			result.changed.push({ row: entry.row, col: entry.col });
		}
	}
	return result;
}

/**
 * The date a numeric result should be written as, or null when it stays a number.
 *
 * Three things ask for it. The `date` marker is explicit. `TODAY()` and `NOW()` are the one
 * automatic case, because their result cannot mean anything else. And a cell that already reads as
 * a date keeps doing so — but only while the number stays within a century of it, so a formula
 * changed from `=A2+30` to `=B2-A2` gives 14 days rather than 1900-01-14.
 */
function dateText(entry: FormulaEntry, value: number): string | null {
	if (value < 1 || value >= 2_958_466) return null;
	if (hasDateMark(entry.raw)) return isoFromSerial(value);
	const ast = entry.ast;
	if (ast !== null && ast.kind === "call" && ast.args.length === 0 && (ast.fn === "TODAY" || ast.fn === "NOW")) {
		return isoFromSerial(value);
	}
	const shown = serialFromIsoDate(entry.cell.display);
	return shown !== null && Math.abs(value - shown) <= 36_500 ? isoFromSerial(value) : null;
}

function evaluateEntry(entry: FormulaEntry, source: CellSource, opts: RecalcOptions): CellValue {
	if (entry.ast === null) {
		const problem = entry.parseError ?? new FormulaError("#ERROR!", "The formula cannot be read");
		return { t: "err", code: problem.code, message: problem.message };
	}
	try {
		return evalValue(entry.ast, { source, row: entry.row, numberOpts: opts.numberOpts, tables: opts.tables });
	} catch (e) {
		const problem = asFormulaError(e);
		return { t: "err", code: problem.code, message: problem.message };
	}
}

function asFormulaError(e: unknown): FormulaError {
	if (e instanceof FormulaError) return e;
	// Defensive: evaluation only throws FormulaError, but a bug must not abort a whole recalculation.
	return new FormulaError("#ERROR!", e instanceof Error ? e.message : "The formula cannot be evaluated");
}

/** The formula cells `node` reads, directly or through a range. */
function formulaDeps(node: Node, formulas: FormulaEntry[]): Set<CellAddr> {
	const out = new Set<CellAddr>();
	const visit = (n: Node): void => {
		switch (n.kind) {
			case "ref":
				for (const f of formulas) if (f.row === n.row && f.col === n.col) out.add(f.key);
				break;
			case "range":
				for (const f of formulas) {
					if (f.row >= n.r1 && f.row <= n.r2 && f.col >= n.c1 && f.col <= n.c2) out.add(f.key);
				}
				break;
			// Another table's cells are ordered by the workbook, not by this table's sort.
			case "xref":
			case "xrange":
				break;
			case "neg":
				visit(n.arg);
				break;
			case "bin":
				visit(n.left);
				visit(n.right);
				break;
			case "call":
				n.args.forEach(visit);
				break;
			default:
				break;
		}
	};
	visit(node);
	return out;
}

/* ------------------------------------------------------ structural changes */

export interface StructuralChange {
	kind: "insertRows" | "deleteRows" | "insertCols" | "deleteCols";
	/** Model index (0-based, row 0 is the header). */
	at: number;
	count: number;
}

/**
 * Rewrites the references of every formula after rows or columns were inserted or deleted, the
 * way Excel does: references at or after an insertion shift; a range grows when the insertion is
 * strictly inside it; a reference to a deleted cell becomes `#REF!`; a range shrinks when part of
 * it is deleted and becomes `#REF!` only when all of it is.
 *
 * A deletion is one contiguous block; for a scattered selection call this once per block, from the
 * bottom up. Row 0 is clamped out exactly as `insertRows`/`deleteRows` do. Display values are left
 * alone — run `recalculate` afterwards.
 */
export function adjustFormulaRefs(model: GridModel, change: StructuralChange): void {
	let { at, count } = change;
	const rowsAxis = change.kind === "insertRows" || change.kind === "deleteRows";
	const inserting = change.kind === "insertRows" || change.kind === "insertCols";
	if (rowsAxis) {
		// The header row can neither be pushed down nor deleted.
		if (at < 1) {
			if (!inserting) count -= 1 - at;
			at = 1;
		}
	}
	if (count <= 0 || at < 0) return;

	const shift = (lo: number, hi: number): [number, number] | null => {
		if (inserting) return [lo >= at ? lo + count : lo, hi >= at ? hi + count : hi];
		const d1 = at;
		const d2 = at + count - 1;
		const nlo = lo < d1 ? lo : lo > d2 ? lo - count : d1;
		const nhi = hi > d2 ? hi - count : hi < d1 ? hi : d1 - 1;
		return nlo > nhi ? null : [nlo, nhi];
	};

	for (const [key, cell] of Array.from(model.cells)) {
		const f = parseFormulaCell(cell.raw);
		if (f === null) continue;
		const expr = rewriteRefs(f.expr, (a, b) => {
			const lo = rowsAxis ? Math.min(a.row, b.row) : Math.min(a.col, b.col);
			const hi = rowsAxis ? Math.max(a.row, b.row) : Math.max(a.col, b.col);
			if (lo < 0) return null;
			const moved = shift(lo, hi);
			if (moved === null) return null;
			const first = { ...a };
			const last = { ...b };
			// Keep each endpoint's `$` markers while placing them in order.
			const swap = rowsAxis ? a.row > b.row : a.col > b.col;
			const [p, q] = swap ? [last, first] : [first, last];
			if (rowsAxis) {
				p.row = moved[0];
				q.row = moved[1];
			} else {
				p.col = moved[0];
				q.col = moved[1];
			}
			return [first, last];
		});
		if (expr === null || expr === f.expr) continue;
		const { row, col } = parseAddrKey(key);
		setRaw(model, row, col, buildFormulaCell(f.display, expr));
	}
}

/**
 * Shifts the relative references of a formula by a row and column offset, leaving `$`-anchored
 * ones where they are — what copy, paste and fill do in Excel. A reference that would land left of
 * or above the sheet becomes `#REF!`, and an expression that cannot be read comes back as null so
 * the caller can keep the original rather than write something wrong.
 */
export function translateFormula(expr: string, dRow: number, dCol: number): string | null {
	if (dRow === 0 && dCol === 0) return expr;
	return rewriteRefs(expr, (a, b) => {
		const moved = (ref: RefParts): RefParts | null => {
			const row = ref.absRow ? ref.row : ref.row + dRow;
			const col = ref.absCol ? ref.col : ref.col + dCol;
			return row < 0 || col < 0 ? null : { absCol: ref.absCol, col, absRow: ref.absRow, row };
		};
		const first = moved(a);
		const last = moved(b);
		return first === null || last === null ? null : [first, last];
	});
}

/**
 * Replaces every reference and range in `expr` through `map`, leaving the rest of the text exactly
 * as written. `map` gets both endpoints (the same one twice for a single cell) and returns the new
 * endpoints, or null for `#REF!`. Returns null when the expression cannot be tokenized.
 */
function rewriteRefs(expr: string, map: (a: RefParts, b: RefParts) => [RefParts, RefParts] | null): string | null {
	let tokens: Token[];
	try {
		tokens = tokenize(expr);
	} catch {
		return null;
	}
	let out = "";
	let last = 0;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.type !== "ref") continue;
		// `Table2!B3` is a cell of another table: moving rows around here does not move it.
		if (i > 0 && tokens[i - 1].type === "bang") continue;
		const isRange = tokens[i + 1]?.type === "colon" && tokens[i + 2]?.type === "ref";
		const endTok = isRange ? tokens[i + 2] : tok;
		const a = parseRef(tok.text);
		const b = parseRef(endTok.text);
		const mapped = map(a, b);
		const text = mapped === null ? "#REF!" : isRange ? `${formatRef(mapped[0])}:${formatRef(mapped[1])}` : formatRef(mapped[0]);
		out += expr.slice(last, tok.start) + text;
		last = endTok.end;
		if (isRange) i += 2;
	}
	return out + expr.slice(last);
}

/* --------------------------------------------------------------- exporting */

/**
 * The expression in Excel's syntax, or null when it does not parse — a malformed `<f>` makes Excel
 * reject the whole file, so an unreadable formula is exported as its value only.
 *
 * `sheets` is what a workbook export knows and a single-sheet one does not: which sheet each table
 * became, keyed by the lowercase `Table1`, `Table2`, … the note's formulas use. With it, `Table2!B3`
 * becomes `'Budget'!B3` — the sheet is named after the heading above the table, not after the
 * number, so the name has to be looked up rather than reused. Without the sheet, or when a formula
 * points at a table that is not in the file, it stays text: a `<f>` aimed at a missing sheet makes
 * Excel refuse the whole workbook.
 */
/** Functions whose Excel spelling is not their name: `XLOOKUP` is written `_xlfn.XLOOKUP`. */
const EXCEL_NAMES: Record<string, string> = { XLOOKUP: "_xlfn.XLOOKUP" };

export function toExcelFormula(expr: string, sheets?: ReadonlyMap<string, string>): string | null {
	let tokens: Token[];
	try {
		tokens = tokenize(expr);
		new Parser(tokens, null).parse();
	} catch {
		return null;
	}
	/** Token index of a table name → the sheet name Excel will have for it. */
	const sheetAt = new Map<number, string>();
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type !== "bang") continue;
		const before = tokens[i - 1];
		const sheet = before !== undefined && before.type === "name" ? sheets?.get(before.text.toLowerCase()) : undefined;
		if (sheet === undefined) return null;
		sheetAt.set(i - 1, sheet);
	}
	return tokens
		.map((tok, index) => {
			const sheet = sheetAt.get(index);
			// Always quoted: `'Budget'!B3` is what Excel writes itself, and it stays valid whatever
			// characters a sheet name ends up with.
			if (sheet !== undefined) return `'${sheet.replace(/'/g, "''")}'`;
			switch (tok.type) {
				case "func":
					// Excel stores functions it did not ship with under `_xlfn.`; without the prefix
					// it reads the formula as a name it has never heard of.
					return EXCEL_NAMES[tok.text.toUpperCase()] ?? FUNCTIONS[tok.text.toUpperCase()]?.fn ?? tok.text.toUpperCase();
				case "sep":
					return ",";
				case "ref":
				case "num":
				case "error":
					return tok.text.toUpperCase();
				default:
					return tok.text;
			}
		})
		.join("");
}

/**
 * Whether the grid's parser knows this function.
 *
 * Imported formulas are checked against this before they reach the cell: a name the parser does
 * not know would be written into the note and then read as `#NAME?`. It is also what keeps the
 * import honest about which Excel functions travel and which keep their value.
 */
export function isGridFunction(name: string): boolean {
	return FUNCTIONS[name.toUpperCase()] !== undefined;
}

/** Why the grid cannot read this expression, or null when it can. */
export function formulaProblem(expr: string): string | null {
	try {
		parseExpr(expr, null);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/* -------------------------------------------------------------- generators */

export type TotalsFunction = "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT";

export interface TotalsOptions {
	fn: TotalsFunction;
	label: string;
	numberOpts?: NumberParseOptions;
}

/**
 * Appends a totals row after the last data row and returns its index.
 *
 * Every column whose non-empty data cells are mostly numbers gets `=FN(X2:Xn)`; the label goes in
 * the first column that is not, or nowhere when every column is numeric. The formulas carry a
 * placeholder value — run `recalculate` afterwards.
 */
export function totalsRow(model: GridModel, opts: TotalsOptions): number {
	let lastRow = 0;
	let cols = model.usedRange.cols;
	for (const key of model.cells.keys()) {
		const { row, col } = parseAddrKey(key);
		lastRow = Math.max(lastRow, row);
		cols = Math.max(cols, col + 1);
	}
	cols = Math.max(cols, 1);
	const target = lastRow + 1;

	const numericCols: boolean[] = [];
	for (let c = 0; c < cols; c++) {
		let filled = 0;
		let numeric = 0;
		for (let r = 1; r <= lastRow; r++) {
			const raw = stripFormula(getRaw(model, r, c));
			if (raw.trim() === "") continue;
			filled++;
			if (parseNumber(raw, opts.numberOpts) !== null) numeric++;
		}
		numericCols.push(filled > 0 && numeric * 2 > filled);
	}

	const labelCol = numericCols.findIndex((n) => !n);
	if (labelCol !== -1) setRaw(model, target, labelCol, opts.label);
	for (let c = 0; c < cols; c++) {
		if (!numericCols[c]) continue;
		const letter = colName(c);
		setRaw(model, target, c, buildFormulaCell("0", `${opts.fn}(${letter}2:${letter}${lastRow + 1})`));
	}
	recomputeUsedRange(model);
	return target;
}

export interface ComputeResult {
	/** Cells written, error codes included. */
	written: number;
	/** How many of those got an error code. */
	errors: number;
	/** Set when the expression itself is unusable; nothing was written then. */
	problem?: string;
}

/**
 * Fills `target` with a one-off computed value for every data row — plain literals, no formula.
 *
 * `expr` names columns of the same row by letter (`B * C`) or by header (`[Qty] * [Price]`,
 * matched case-insensitively without emphasis). Fixed cells such as `$E$1` work too. An expression
 * that does not parse, or names a column that does not exist, writes nothing: filling a whole
 * column with `#NAME?` would destroy its contents for a typo. Entirely empty rows are skipped.
 */
export function computeColumn(model: GridModel, target: number, expr: string, opts: RecalcOptions): ComputeResult {
	let rows = 0;
	let cols = model.usedRange.cols;
	const occupied = new Set<number>();
	for (const key of model.cells.keys()) {
		const { row, col } = parseAddrKey(key);
		rows = Math.max(rows, row + 1);
		cols = Math.max(cols, col + 1);
		occupied.add(row);
	}

	const headers = new Map<string, number>();
	for (let c = 0; c < cols; c++) {
		const name = headerKey(getRaw(model, 0, c));
		if (name !== "" && !headers.has(name)) headers.set(name, c);
	}
	// A bare word past the last column is far more likely a header typed without brackets.
	const resolve: ColumnResolver = (name, bracket) => {
		if (bracket) return headers.get(headerKey(name)) ?? -1;
		const c = colIndex(name);
		return c < cols ? c : -1;
	};

	const text = expr.trim().startsWith("=") ? expr.trim().slice(1) : expr;
	let ast: Node;
	try {
		ast = parseExpr(text, resolve);
	} catch (e) {
		return { written: 0, errors: 0, problem: asFormulaError(e).message };
	}

	const source: CellSource = {
		rows,
		cols,
		value: (row, col) => classify(getRaw(model, row, col), opts.numberOpts),
	};
	const result: ComputeResult = { written: 0, errors: 0 };
	for (let r = 1; r < rows; r++) {
		if (!occupied.has(r)) continue;
		let value: string;
		try {
			const computed = evalValue(ast, { source, row: r, numberOpts: opts.numberOpts });
			value = computed.t === "num" ? opts.format(clean(computed.n)) : displayText(computed);
		} catch (e) {
			value = asFormulaError(e).code;
			result.errors++;
		}
		setRaw(model, r, target, withLayersOf(stripFormula(getRaw(model, r, target)), value));
		result.written++;
	}
	recomputeUsedRange(model);
	return result;
}

/**
 * Evaluates one expression as if it sat in `row` of a table — a conditional-format rule that tests a
 * formula rather than a value (`if B2>1000`). Returns null when the expression cannot be read or
 * evaluated: a rule that cannot judge a cell has to leave it alone rather than paint it wrong.
 */
export function testExpression(
	expr: string,
	model: GridModel,
	row: number,
	opts: { numberOpts?: NumberParseOptions; tables?: CellSource[] } = {},
): boolean | null {
	const text = (expr.trim().startsWith("=") ? expr.trim().slice(1) : expr.trim()).trim();
	if (text === "") return null;
	let ast: Node;
	try {
		ast = new Parser(tokenize(text), null).parse();
	} catch {
		return null;
	}
	const source: CellSource = sourceOf(model, opts.numberOpts);
	try {
		const value = evalValue(ast, { source, row, numberOpts: opts.numberOpts, tables: opts.tables });
		switch (value.t) {
			case "num":
				return value.n !== 0;
			case "bool":
				return value.b;
			case "text": {
				const text = value.s.trim().toLowerCase();
				return text !== "" && text !== "false" && text !== "0";
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/** A header as it is matched: emphasis stripped, no case, single spaces. Shared with the merge. */
export function headerKey(raw: string): string {
	return peelInline(stripFormula(raw)).inner.trim().toLowerCase();
}
