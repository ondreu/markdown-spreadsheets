import { getRaw, type GridModel } from "../model/GridModel";
import { stripInlineMarkdown } from "../model/numbers";
import type { CsvDelimiter } from "../settings";

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

/** Best-effort plain text of a cell: the display text of links, without inline wrappers. */
export function plainText(raw: string): string {
	const linked = raw
		.replace(WIKILINK, (_m, target: string, alias?: string) => (alias === undefined ? target : alias))
		.replace(MDLINK, (_m, label: string) => label);
	return stripInlineMarkdown(linked);
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
			const raw = getRaw(model, r, c);
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
