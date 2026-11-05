import { colIndex, colName, parseAddrKey } from "../model/address";
import { getRaw, setRaw, type GridModel } from "../model/GridModel";
import { parseNumber, type NumberParseOptions } from "../model/numbers";
import { addInlineFormat, peelInline, removeInlineFormat, type InlineFormat } from "./ops";

/**
 * Conditional formatting, stored the way everything else in a note is stored.
 *
 * A rule is a comment in the first cell of the range it governs:
 *
 *     | **Total** | 1 200 %%cf F2:F9 > 1000 bold%% |
 *
 * Obsidian hides the comment, a plain Markdown reader shows the value and the rule as text, and the
 * note stays the source of truth (D1). A rule for one cell needs no range — it is written in the
 * cell it governs. The result is what a person sees: the plugin writes the format into the cell as
 * inline Markdown (`**1 200**`, `==37 140==`), so a note read without the plugin still shows it, and
 * the pass is idempotent — matching adds the mark, no longer matching removes it.
 *
 * Why the comment holds a range instead of the rule being repeated per cell: a note with a rule on
 * forty cells would otherwise carry forty comments, and there would be nowhere to say what the range
 * *is* — editing one of them would silently mean "and also the others", or nothing at all.
 */

export type ConditionalFormat = "bold" | "italic" | "strike" | "code" | "highlight";

/** `=` and `<>` compare text case-insensitively; the ordering operators need numbers. */
export type ConditionalOp = ">" | ">=" | "<" | "<=" | "=" | "<>" | "contains";

export interface ConditionalRule {
	/** Model coordinates, not labels: row 0 is the header row. */
	r1: number;
	c1: number;
	r2: number;
	c2: number;
	op: ConditionalOp;
	value: string;
	format: ConditionalFormat;
	/** The cell holding the comment, which is where the rule is written back to. */
	row: number;
	col: number;
}

const OPS: readonly ConditionalOp[] = [">", ">=", "<", "<=", "=", "<>", "contains"];

const FORMAT_ALIASES: Record<string, ConditionalFormat> = {
	bold: "bold",
	italic: "italic",
	strike: "strike",
	strikethrough: "strike",
	code: "code",
	mono: "code",
	highlight: "highlight",
	mark: "highlight",
};

const RANGE_RE = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/;

/** The inline format a rule writes, in the one vocabulary `ops.ts` knows. */
export function inlineFormatOf(format: ConditionalFormat): InlineFormat {
	return format === "strike" ? "strikethrough" : format;
}

/* ------------------------------------------------------------------ comments */

export interface CellComments {
	/** What a person sees: the value, still carrying its own emphasis. */
	display: string;
	/** Comment bodies without the `%%` fences, in the order they were written. */
	comments: string[];
}

/**
 * Splits a cell into its display text and the comments trailing it.
 *
 * Only whole trailing `%%…%%` blocks count, and the closing fence must end the cell: a `%%` pair in
 * the middle of a value is text, not a comment, and treating it as one would rewrite the cell.
 */
export function splitComments(raw: string): CellComments {
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

/**
 * Comments in the one order the reader expects: rules first, the formula last.
 *
 * `parseFormulaCell` only recognises a formula when its comment ends the cell — everything after it
 * would otherwise be read as part of the expression. A note written by hand may say it the other way
 * round, so the pass rewrites the cell in this order and every later read agrees.
 */
export function orderComments(comments: readonly string[]): string[] {
	return [...comments.filter((body) => /^cf\s/i.test(body)), ...comments.filter((body) => !/^cf\s/i.test(body))];
}

export function joinComments(display: string, comments: readonly string[]): string {
	if (comments.length === 0) return display;
	const tail = comments.map((c) => `%%${c}%%`).join(" ");
	return display === "" ? tail : `${display} ${tail}`;
}

/* ------------------------------------------------------------------- parsing */

/** Splits a rule body on spaces, keeping a quoted value in one piece. */
function tokenize(s: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < s.length) {
		if (/\s/.test(s[i])) {
			i++;
			continue;
		}
		if (s[i] === '"') {
			const close = s.indexOf('"', i + 1);
			if (close === -1) {
				out.push(s.slice(i + 1));
				break;
			}
			out.push(s.slice(i + 1, close));
			i = close + 1;
			continue;
		}
		let j = i;
		while (j < s.length && !/\s/.test(s[j])) j++;
		out.push(s.slice(i, j));
		i = j;
	}
	return out;
}

/**
 * `cf [range] <op> <value> <format>` → its parts, or null for anything that is not a rule.
 *
 * A malformed rule is left in the note untouched and simply does not apply: rewriting a comment a
 * person typed by hand would be worse than ignoring it.
 */
export function parseRuleBody(body: string): { range: { r1: number; c1: number; r2: number; c2: number } | null; op: ConditionalOp; value: string; format: ConditionalFormat } | null {
	const tokens = tokenize(body.replace(/^cf\s+/i, ""));
	let range: { r1: number; c1: number; r2: number; c2: number } | null = null;
	const first = tokens[0];
	if (first !== undefined && !OPS.includes(first as ConditionalOp)) {
		const m = RANGE_RE.exec(first);
		if (m === null) return null;
		const c1 = colIndex(m[1]);
		const r1 = Number.parseInt(m[2], 10) - 1;
		const c2 = m[3] === undefined ? c1 : colIndex(m[3]);
		const r2 = m[4] === undefined ? r1 : Number.parseInt(m[4], 10) - 1;
		if (c1 < 0 || c2 < 0 || r1 < 0 || r2 < 0) return null;
		range = { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
		tokens.shift();
	}
	const op = tokens.shift() as ConditionalOp | undefined;
	if (op === undefined || !OPS.includes(op)) return null;
	const formatToken = tokens.pop();
	if (formatToken === undefined) return null;
	const format = FORMAT_ALIASES[formatToken.toLowerCase()];
	if (format === undefined) return null;
	const value = tokens.join(" ");
	// Only the two equality operators have a meaningful empty side: `= ""` is "is blank".
	if (value === "" && op !== "=" && op !== "<>") return null;
	return { range, op, value, format };
}

/** The rules written in one cell, with the fallback range being the cell itself. */
export function rulesInCell(raw: string, row: number, col: number): ConditionalRule[] {
	const out: ConditionalRule[] = [];
	for (const body of splitComments(raw).comments) {
		if (!/^cf\s/i.test(body)) continue;
		const parsed = parseRuleBody(body);
		if (parsed === null) continue;
		const range = parsed.range ?? { r1: row, c1: col, r2: row, c2: col };
		out.push({ ...range, op: parsed.op, value: parsed.value, format: parsed.format, row, col });
	}
	return out;
}

/** Every rule in a table, in cell order. */
export function allRules(model: GridModel): ConditionalRule[] {
	const out: ConditionalRule[] = [];
	for (const [key, cell] of model.cells) {
		if (!cell.raw.includes("%%cf")) continue;
		const { row, col } = parseAddrKey(key);
		out.push(...rulesInCell(cell.raw, row, col));
	}
	return out;
}

/** True when the table carries at least one rule, so the pass can be skipped entirely. */
export function hasRules(model: GridModel): boolean {
	for (const cell of model.cells.values()) if (cell.raw.includes("%%cf")) return true;
	return false;
}

/* -------------------------------------------------------------- serializing */

export function buildRuleComment(rule: Omit<ConditionalRule, "row" | "col">): string {
	const anchorIsCell = rule.r1 === rule.r2 && rule.c1 === rule.c2;
	const range = anchorIsCell ? "" : `${colName(rule.c1)}${rule.r1 + 1}:${colName(rule.c2)}${rule.r2 + 1} `;
	const value = rule.value === "" ? "" : /\s/.test(rule.value) ? `"${rule.value}" ` : `${rule.value} `;
	return `%%cf ${range}${rule.op} ${value}${rule.format}%%`;
}

/* ----------------------------------------------------------------- matching */

function numeric(rule: ConditionalRule, value: string, numberOpts?: NumberParseOptions): number | null {
	return parseNumber(rule.value, numberOpts) === null ? null : parseNumber(value, numberOpts);
}

/**
 * Whether the rule can say anything about this cell at all.
 *
 * A numeric comparison against text is not a "no" — it is no answer, and treating it as "no" would
 * take a manually bolded `Done` out of a column because `> 1000` does not hold for it. Only the
 * operators that compare text are always applicable.
 */
export function ruleApplies(rule: ConditionalRule, display: string, numberOpts?: NumberParseOptions): boolean {
	if (rule.op === "=" || rule.op === "<>" || rule.op === "contains") return true;
	const text = peelInline(display).inner.trim();
	if (text === "") return false;
	return parseNumber(text, numberOpts) !== null && parseNumber(rule.value, numberOpts) !== null;
}

/** Whether the cell's displayed value satisfies the rule. */
export function ruleMatches(rule: ConditionalRule, display: string, numberOpts?: NumberParseOptions): boolean {
	const text = peelInline(display).inner.trim();
	switch (rule.op) {
		case "contains":
			return text.toLowerCase().includes(rule.value.trim().toLowerCase());
		case "=":
			return text.toLowerCase() === rule.value.trim().toLowerCase();
		case "<>":
			return text.toLowerCase() !== rule.value.trim().toLowerCase();
		default: {
			const left = numeric(rule, text, numberOpts);
			const right = parseNumber(rule.value, numberOpts);
			// A number compared with text is not a match: silently reading "" as 0 would paint the
			// empty rows of a column, which is never what a rule over a whole column means.
			if (left === null || right === null) return false;
			switch (rule.op) {
				case ">":
					return left > right;
				case ">=":
					return left >= right;
				case "<":
					return left < right;
				default:
					return left <= right;
			}
		}
	}
}

/* ----------------------------------------------------------------- applying */

/**
 * Applies every rule in the table to the cells it governs and returns the cells that changed.
 *
 * The format goes into the cell as inline Markdown, so the note shows it without the plugin. The
 * pass is idempotent: a mark that is already there is not added twice, and a mark that no longer
 * applies is removed. Only marks the rule itself writes are touched, so a manually bolded cell in a
 * column with an italic rule keeps its bold.
 *
 * A cell whose comment holds a rule is left with its comment intact — the display is rewritten and
 * the comments are put back in the order they were found.
 */
export function applyConditionalFormats(model: GridModel, numberOpts?: NumberParseOptions): Array<{ row: number; col: number }> {
	const changed: Array<{ row: number; col: number }> = [];
	if (!hasRules(model)) return changed;
	const rules = allRules(model);
	if (rules.length === 0) return changed;
	const rows = Math.max(model.usedRange.rows, 0);
	const cols = Math.max(model.usedRange.cols, 0);
	for (const rule of rules) {
		const r2 = Math.max(rule.r2, Math.min(rows - 1, rule.r2));
		const c2 = Math.max(rule.c2, Math.min(cols - 1, rule.c2));
		for (let r = rule.r1; r <= r2; r++) {
			for (let c = rule.c1; c <= c2; c++) {
				const raw = getRaw(model, r, c);
				if (raw.trim() === "" && !(rule.op === "=" && rule.value.trim() === "")) continue;
				const { display, comments } = splitComments(raw);
				if (display === "") continue;
				// A cell the rule cannot judge is left exactly as it is: no mark removed, none added.
				if (!ruleApplies(rule, display, numberOpts)) continue;
				const matches = ruleMatches(rule, display, numberOpts);
				const inline = inlineFormatOf(rule.format);
				const next = matches ? addInlineFormat(display, inline) : removeInlineFormat(display, inline);
				if (next === display) continue;
				setRaw(model, r, c, joinComments(next, orderComments(comments)));
				if (!changed.some((seen) => seen.row === r && seen.col === c)) changed.push({ row: r, col: c });
			}
		}
	}
	return changed;
}
