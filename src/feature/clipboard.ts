/**
 * TSV is the lingua franca of the system clipboard: Excel, LibreOffice and Google Sheets all
 * read and write it, so a range copied out of the grid pastes into a spreadsheet and back (§9).
 */

/** A cell containing a tab, newline or quote has to be quoted the way Excel quotes it. */
function encodeCell(raw: string): string {
	const flat = raw.replace(/\r?\n/g, " ");
	if (/[\t"\n\r]/.test(flat)) return `"${flat.split('"').join('""')}"`;
	return flat;
}

export function toTsv(values: string[][]): string {
	return values.map((row) => row.map(encodeCell).join("\t")).join("\n");
}

/**
 * Parses clipboard TSV into a rectangle.
 *
 * Quoted fields may contain tabs and newlines, so this is a character scan rather than a
 * split — pasting a multi-line Excel cell must not shear the row apart. The result is padded
 * to a rectangle because the grid has no concept of a ragged range.
 */
export function fromTsv(text: string): string[][] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let i = 0;

	while (i < normalized.length) {
		const ch = normalized[i];
		if (quoted) {
			if (ch === '"') {
				if (normalized[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field === "") {
			quoted = true;
			i++;
			continue;
		}
		if (ch === "\t") {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += ch;
		i++;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	// Trailing newline in the clipboard payload is normal; an empty last row is not data.
	while (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();

	const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
	for (const r of rows) while (r.length < width) r.push("");
	return rows;
}

/** A single-cell paste of multi-line text should not silently become one long line. */
export function looksLikeGrid(text: string): boolean {
	return text.includes("\t") || text.includes("\n");
}
