import { getRaw, type GridModel } from "../model/GridModel";
import type { CsvDelimiter } from "../settings";
import { stripFormula } from "./formula";

export interface CsvOptions {
	delimiter: CsvDelimiter;
	/** Excel on Windows needs the BOM to detect UTF-8 (§14). */
	bom: boolean;
	/** `raw` keeps the markdown, `plain` strips inline wrappers and link syntax. */
	content: "raw" | "plain";
	/** CRLF is what Excel writes; the setting exists because diff tools prefer LF. */
	crlf: boolean;
}

export const DEFAULT_CSV_OPTIONS: CsvOptions = {
	delimiter: ";",
	bom: true,
	content: "raw",
	crlf: true,
};

const WIKILINK = /!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MDLINK = /!?\[([^\]]*)\]\([^)]*\)/g;

/** `![[img.png|300]]` and `![[img.png|300x200]]` carry a size, not a label. */
const EMBED_SIZE = /^\d+(?:x\d+)?$/;
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const ESCAPED_PUNCTUATION = /\\([!-/:-@[-`{-~])/g;

/**
 * Best-effort plain text of a cell: the display text of links, without inline wrappers.
 *
 * Emphasis is removed wherever it is, not only around the whole cell — `hello *world*` used to
 * export with its asterisks. Code spans keep their content verbatim.
 */
export function plainText(raw: string): string {
	const linked = raw
		.replace(WIKILINK, (match: string, target: string, alias?: string) => {
			if (alias === undefined) return target;
			return match.startsWith("!") && EMBED_SIZE.test(alias.trim()) ? target : alias;
		})
		.replace(MDLINK, (_m, label: string) => label);
	let out = "";
	let last = 0;
	CODE_SPAN.lastIndex = 0;
	for (let m = CODE_SPAN.exec(linked); m !== null; m = CODE_SPAN.exec(linked)) {
		out += stripEmphasis(linked.slice(last, m.index)) + m[2].trim();
		last = m.index + m[0].length;
	}
	out += stripEmphasis(linked.slice(last));
	return out.trim();
}

/** Escaped punctuation is parked in the private-use area so no delimiter rule can see it. */
const PARK_BASE = 0xe000;
const PARKED = /[\ue000-\ue07f]/g;

function stripEmphasis(text: string): string {
	return text
		.replace(ESCAPED_PUNCTUATION, (_m, ch: string) => String.fromCharCode(PARK_BASE + ch.charCodeAt(0)))
		.replace(/(\*\*|__|~~|==)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/\*(?=[^\s*])([^*]*?[^\s*])?\*/g, (m: string) => m.slice(1, -1))
		.replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])?_(?![\p{L}\p{N}])/gu, (m: string, before: string) =>
			before + m.slice(before.length + 1, -1),
		)
		.replace(PARKED, (ch) => String.fromCharCode(ch.charCodeAt(0) - PARK_BASE));
}

/** RFC 4180 quoting: quote whenever the field could otherwise be misread. */
export function csvField(value: string, delimiter: string): string {
	const needsQuotes =
		value.includes(delimiter) ||
		value.includes('"') ||
		value.includes("\n") ||
		value.includes("\r") ||
		value !== value.trim();
	if (!needsQuotes) return value;
	return `"${value.split('"').join('""')}"`;
}

export function buildCsv(model: GridModel, options: CsvOptions): string {
	const { rows, cols } = model.usedRange;
	const eol = options.crlf ? "\r\n" : "\n";
	const lines: string[] = [];
	for (let r = 0; r < Math.max(rows, 1); r++) {
		const fields: string[] = [];
		for (let c = 0; c < Math.max(cols, 1); c++) {
			// A formula cell exports its value; the formula is Obsidian-only text (`%%=…%%`).
			const raw = stripFormula(getRaw(model, r, c));
			fields.push(csvField(options.content === "plain" ? plainText(raw) : raw, options.delimiter));
		}
		lines.push(fields.join(options.delimiter));
	}
	const body = lines.join(eol) + eol;
	return options.bom ? "\uFEFF" + body : body;
}

/** UTF-8 bytes, ready for `Vault.createBinary`. */
export function csvBytes(model: GridModel, options: CsvOptions): ArrayBuffer {
	const text = buildCsv(model, options);
	const encoded = new TextEncoder().encode(text);
	// A fresh, exactly-sized buffer: the encoder's view may be a slice of a larger allocation.
	const out = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(out).set(encoded);
	return out;
}
