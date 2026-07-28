import { getRaw, type Align, type GridModel } from "./GridModel";

/** Widest column the serializer will pad to. Longer cells are written in full, unpadded. */
export const MAX_PAD_WIDTH = 60;
/** `:-:` needs three dashes worth of room, so no column is ever narrower. */
const MIN_PAD_WIDTH = 3;

/**
 * Display width in monospace columns. CJK, fullwidth forms and emoji occupy two cells,
 * so counting UTF-16 code units alone would misalign the pipes for those tables.
 */
export function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0) ?? 0;
		w += isWide(cp) ? 2 : 1;
	}
	return w;
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
		(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compatibility
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
		(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

/**
 * Escapes a cell for the table body.
 *
 * Only `|` is escaped — see `unescapePipes` for why the other backslash sequences are
 * left alone. Newlines cannot exist in a GFM cell (§3), so they collapse to spaces.
 */
export function escapeCell(raw: string): string {
	return raw.replace(/\r?\n/g, " ").split("|").join("\\|");
}

function pad(text: string, width: number, align: Align): string {
	const missing = width - displayWidth(text);
	if (missing <= 0) return text;
	if (align === "right") return " ".repeat(missing) + text;
	if (align === "center") {
		const left = Math.floor(missing / 2);
		return " ".repeat(left) + text + " ".repeat(missing - left);
	}
	return text + " ".repeat(missing);
}

function delimiterCell(width: number, align: Align): string {
	switch (align) {
		case "left":
			return ":" + "-".repeat(width - 1);
		case "right":
			return "-".repeat(width - 1) + ":";
		case "center":
			return ":" + "-".repeat(width - 2) + ":";
		default:
			return "-".repeat(width);
	}
}

/**
 * GridModel -> strictly valid GFM.
 *
 * Writes exactly the used range, escapes pipes, re-aligns the columns to the widest cell
 * (capped at `MAX_PAD_WIDTH`), emits the alignment row from `colAlign`, leaves no trailing
 * whitespace and terminates with a newline (§6).
 *
 * The one-space padding around every cell is load-bearing: it guarantees a cell ending in
 * a backslash can never swallow the closing pipe on re-read.
 */
export function serializeTable(model: GridModel): string {
	const cols = Math.max(model.usedRange.cols, 1);
	// A GFM table is header + alignment row at minimum.
	const rows = Math.max(model.usedRange.rows, 1);

	const matrix: string[][] = [];
	for (let r = 0; r < rows; r++) {
		const row: string[] = [];
		for (let c = 0; c < cols; c++) row.push(escapeCell(getRaw(model, r, c)));
		matrix.push(row);
	}

	const widths: number[] = [];
	for (let c = 0; c < cols; c++) {
		let w = MIN_PAD_WIDTH;
		for (let r = 0; r < rows; r++) w = Math.max(w, displayWidth(matrix[r][c]));
		widths.push(Math.min(w, MAX_PAD_WIDTH));
	}

	const out: string[] = [];
	const alignFor = (c: number): Align => model.colAlign[c] ?? null;

	out.push("| " + matrix[0].map((cell, c) => pad(cell, widths[c], alignFor(c))).join(" | ") + " |");
	out.push("| " + widths.map((w, c) => delimiterCell(w, alignFor(c))).join(" | ") + " |");
	for (let r = 1; r < rows; r++) {
		out.push("| " + matrix[r].map((cell, c) => pad(cell, widths[c], alignFor(c))).join(" | ") + " |");
	}

	// Padding can leave spaces before the closing pipe, which is fine, but never at EOL.
	return out.map((l) => l.replace(/[ \t]+$/, "")).join("\n") + "\n";
}
