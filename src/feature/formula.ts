import { addrKey, colIndex, colName, parseAddrKey, type CellAddr } from "../model/address";
import { getRaw, recomputeUsedRange, setRaw, type GridModel } from "../model/GridModel";
import { parseNumber, type NumberParseOptions } from "../model/numbers";
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
export type FormulaErrorCode = "#VALUE!" | "#REF!" | "#DIV/0!" | "#CYCLE!" | "#ERROR!" | "#NUM!" | "#NAME?";

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
	const s = raw.trimEnd();
	if (s.length < 6 || !s.endsWith("%%")) return null;
	const open = s.lastIndexOf("%%=", s.length - 3);
	if (open === -1 || open + 3 > s.length - 2) return null;
	const expr = s.slice(open + 3, s.length - 2).trim();
	if (expr === "" || expr.includes("%%")) return null;
	const before = s.slice(0, open);
	if (countMarkers(before) % 2 !== 0) return null;
	return { display: before.trim(), expr };
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

type TokenType = "num" | "ref" | "name" | "func" | "bracket" | "error" | "op" | "lparen" | "rparen" | "sep" | "colon";

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
		if ("+-*/^".includes(ch)) push("op", ch);
		else if (ch === "(") push("lparen", ch);
		else if (ch === ")") push("rparen", ch);
		// `;` is the argument separator in comma-decimal locales of Excel.
		else if (ch === "," || ch === ";") push("sep", ch);
		else if (ch === ":") push("colon", ch);
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

type BinaryOp = "+" | "-" | "*" | "/" | "^";

type Node =
	| { kind: "num"; value: number }
	| { kind: "ref"; row: number; col: number }
	| { kind: "range"; r1: number; c1: number; r2: number; c2: number }
	/** A column of the current row — only in `computeColumn` expressions. */
	| { kind: "col"; col: number }
	| { kind: "err"; code: FormulaErrorCode }
	| { kind: "neg"; arg: Node }
	| { kind: "bin"; op: BinaryOp; left: Node; right: Node }
	| { kind: "call"; fn: FunctionName; args: Node[] };

type FunctionName = "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT" | "COUNTA" | "MEDIAN" | "PRODUCT" | "ROUND" | "ABS";

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
};

const ERROR_CODES: readonly FormulaErrorCode[] = ["#VALUE!", "#REF!", "#DIV/0!", "#CYCLE!", "#ERROR!", "#NUM!", "#NAME?"];

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
		const node = this.additive();
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
				const col = this.columns === null ? -1 : this.columns(tok.text, tok.type === "bracket");
				if (col < 0) throw new FormulaError("#NAME?", `Unknown name: ${tok.text}`);
				return { kind: "col", col };
			}
			case "func":
				return this.call(tok);
			case "lparen": {
				const inner = this.additive();
				if (this.next().type !== "rparen") throw new FormulaError("#ERROR!", 'Missing ")"');
				return inner;
			}
			default:
				throw new FormulaError("#ERROR!", `Unexpected "${tok.text}"`);
		}
	}

	private call(tok: Token): Node {
		const spec = FUNCTIONS[tok.text.toUpperCase()];
		if (spec === undefined) throw new FormulaError("#NAME?", `Unknown function: ${tok.text}`);
		this.next(); // (
		const args: Node[] = [];
		if (this.peek()?.type !== "rparen") {
			for (;;) {
				args.push(this.additive());
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

function errorCodeOf(text: string): FormulaErrorCode {
	const upper = text.toUpperCase();
	return ERROR_CODES.find((c) => c === upper) ?? "#ERROR!";
}

function parseExpr(expr: string, columns: ColumnResolver | null = null): Node {
	return new Parser(tokenize(expr), columns).parse();
}

/* -------------------------------------------------------------- evaluation */

type CellValue = { t: "empty" } | { t: "num"; n: number } | { t: "text" } | { t: "err"; code: FormulaErrorCode };

interface CellSource {
	value(row: number, col: number): CellValue;
	/** Rows and columns that can hold anything; a range is clipped to them. */
	rows: number;
	cols: number;
}

interface EvalContext {
	source: CellSource;
	/** The current row, for `col` nodes. */
	row: number;
}

function classify(raw: string, numberOpts?: NumberParseOptions): CellValue {
	const shown = stripFormula(raw);
	if (shown.trim() === "") return { t: "empty" };
	const n = parseNumber(shown, numberOpts);
	return n === null ? { t: "text" } : { t: "num", n };
}

function cellNumber(v: CellValue): number {
	switch (v.t) {
		case "empty":
			return 0;
		case "num":
			return v.n;
		case "text":
			throw new FormulaError("#VALUE!", "Text where a number was expected");
		case "err":
			throw new FormulaError(v.code, `A referenced cell shows ${v.code}`);
	}
}

function refValue(ctx: EvalContext, row: number, col: number): CellValue {
	if (row < 0 || col < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
	return ctx.source.value(row, col);
}

function evalNum(node: Node, ctx: EvalContext): number {
	switch (node.kind) {
		case "num":
			return node.value;
		case "err":
			throw new FormulaError(node.code, node.code === "#REF!" ? "Reference to a deleted row or column" : `The formula contains ${node.code}`);
		case "ref":
			return cellNumber(refValue(ctx, node.row, node.col));
		case "col":
			return cellNumber(refValue(ctx, ctx.row, node.col));
		case "range":
			throw new FormulaError("#VALUE!", "A range can only be used inside a function");
		case "neg":
			return -evalNum(node.arg, ctx);
		case "bin":
			return binary(node.op, evalNum(node.left, ctx), evalNum(node.right, ctx));
		case "call":
			return evalCall(node.fn, node.args, ctx);
	}
}

function binary(op: BinaryOp, a: number, b: number): number {
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
		else if (v.t === "err" && !tolerateErrors) throw new FormulaError(v.code, `A referenced cell shows ${v.code}`);
	};
	for (const arg of args) {
		if (arg.kind === "range") {
			if (arg.r1 < 0 || arg.c1 < 0) throw new FormulaError("#REF!", "Reference to a cell that does not exist");
			const r2 = Math.min(arg.r2, ctx.source.rows - 1);
			const c2 = Math.min(arg.c2, ctx.source.cols - 1);
			for (let r = arg.r1; r <= r2; r++) {
				for (let c = arg.c1; c <= c2; c++) take(ctx.source.value(r, c));
			}
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

function evalCall(fn: FunctionName, args: Node[], ctx: EvalContext): number {
	switch (fn) {
		case "ROUND":
			return round(evalNum(args[0], ctx), Math.trunc(evalNum(args[1], ctx)));
		case "ABS":
			return Math.abs(evalNum(args[0], ctx));
		case "COUNT":
			return collect(args, ctx, true).nums.length;
		case "COUNTA":
			return collect(args, ctx, true).filled;
		default:
			break;
	}
	const { nums } = collect(args, ctx, false);
	switch (fn) {
		case "SUM":
			return nums.reduce((a, n) => a + n, 0);
		case "AVERAGE":
			if (nums.length === 0) throw new FormulaError("#DIV/0!", "AVERAGE of no numbers");
			return nums.reduce((a, n) => a + n, 0) / nums.length;
		case "MIN":
			return nums.length === 0 ? 0 : nums.reduce((a, n) => (n < a ? n : a), nums[0]);
		case "MAX":
			return nums.length === 0 ? 0 : nums.reduce((a, n) => (n > a ? n : a), nums[0]);
		case "PRODUCT":
			return nums.length === 0 ? 0 : nums.reduce((a, n) => a * n, 1);
		case "MEDIAN": {
			if (nums.length === 0) throw new FormulaError("#NUM!", "MEDIAN of no numbers");
			const sorted = nums.slice().sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
		}
		default:
			throw new FormulaError("#NAME?", "Unknown function");
	}
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

/* ------------------------------------------------------------ recalculation */

export interface RecalcOptions {
	numberOpts?: NumberParseOptions;
	/** Turns a computed value into the cell's display text. */
	format: (value: number) => string;
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

	const computed = new Map<CellAddr, number | FormulaError>();
	const source: CellSource = {
		rows,
		cols,
		value(row, col) {
			const key = addrKey(row, col);
			if (entries.has(key)) {
				const v = computed.get(key);
				if (v === undefined) return { t: "err", code: "#CYCLE!" };
				return typeof v === "number" ? { t: "num", n: v } : { t: "err", code: v.code };
			}
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
		computed.set(entry.key, evaluateEntry(entry, source));
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
		if (!computed.has(entry.key)) computed.set(entry.key, new FormulaError("#CYCLE!", "Circular reference"));
	}

	const result: RecalcResult = { changed: [], errors: [] };
	for (const entry of all) {
		const value = computed.get(entry.key);
		if (value === undefined) continue;
		let text: string;
		if (typeof value === "number") {
			// A display that already reads as this number stays as written. Formatting is locale
			// dependent, and rewriting "1 200" as "1,200" on another machine would make every open
			// on that machine an edit — two devices would rewrite the note back and forth forever.
			const shown = parseNumber(entry.cell.display, opts.numberOpts);
			if (shown !== null && Math.abs(shown - clean(value)) <= 1e-9 * Math.max(1, Math.abs(shown))) continue;
			text = opts.format(clean(value));
		} else {
			text = value.code;
			result.errors.push({ row: entry.row, col: entry.col, code: value.code, message: value.message });
		}
		const next = buildFormulaCell(withLayersOf(entry.cell.display, text), entry.cell.expr);
		if (next !== entry.raw) {
			setRaw(model, entry.row, entry.col, next);
			result.changed.push({ row: entry.row, col: entry.col });
		}
	}
	return result;
}

function evaluateEntry(entry: FormulaEntry, source: CellSource): number | FormulaError {
	if (entry.ast === null) return entry.parseError ?? new FormulaError("#ERROR!", "The formula cannot be read");
	try {
		return evalNum(entry.ast, { source, row: entry.row });
	} catch (e) {
		return asFormulaError(e);
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
 */
export function toExcelFormula(expr: string): string | null {
	let tokens: Token[];
	try {
		tokens = tokenize(expr);
		new Parser(tokens, null).parse();
	} catch {
		return null;
	}
	return tokens
		.map((tok) => {
			switch (tok.type) {
				case "func":
					return FUNCTIONS[tok.text.toUpperCase()]?.fn ?? tok.text.toUpperCase();
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
			value = opts.format(clean(evalNum(ast, { source, row: r })));
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

function headerKey(raw: string): string {
	return peelInline(stripFormula(raw)).inner.trim().toLowerCase();
}
