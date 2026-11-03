import { colName } from "../model/address";
import type { Align } from "../model/GridModel";

/**
 * HTML and JSON exports. Both produce text for the clipboard or a file outside the note — the note
 * itself never receives HTML (D1).
 */

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * A `<table>` with the first row as `<thead>`. Cell text goes through `plain` (markdown to plain
 * text) and is then escaped, so a cell can never inject markup into whatever the HTML is pasted
 * into. Alignment is the one piece of formatting GFM has, and it carries over as `text-align`.
 */
export function toHtmlTable(values: string[][], align: Align[], plain: (raw: string) => string): string {
	if (values.length === 0) return "";
	const width = values.reduce((w, row) => Math.max(w, row.length), 0);
	const row = (cells: string[], tag: "th" | "td"): string => {
		const out: string[] = [];
		for (let c = 0; c < width; c++) {
			const a = align[c] ?? null;
			const style = a ? ` style="text-align:${a}"` : "";
			out.push(`<${tag}${style}>${escapeHtml(plain(cells[c] ?? ""))}</${tag}>`);
		}
		return `<tr>${out.join("")}</tr>`;
	};
	const lines = ["<table>", "<thead>", row(values[0], "th"), "</thead>"];
	if (values.length > 1) {
		lines.push("<tbody>");
		for (const cells of values.slice(1)) lines.push(row(cells, "td"));
		lines.push("</tbody>");
	}
	lines.push("</table>");
	return lines.join("\n");
}

/**
 * An array of objects keyed by the header row. An empty header falls back to the column letter and
 * a repeated name gets a numeric suffix (`Name`, `Name 2`), because JSON keys must be unique and a
 * silently overwritten key is a lost column.
 */
export function toJson(values: string[][]): string {
	if (values.length === 0) return "[]";
	const width = values.reduce((w, row) => Math.max(w, row.length), 0);
	const used = new Set<string>();
	const keys: string[] = [];
	for (let c = 0; c < width; c++) {
		const base = (values[0][c] ?? "").trim() || colName(c);
		let key = base;
		for (let n = 2; used.has(key); n++) key = `${base} ${n}`;
		used.add(key);
		keys.push(key);
	}
	const rows = values.slice(1).map((cells) => {
		const obj: Record<string, string> = {};
		keys.forEach((key, c) => {
			obj[key] = cells[c] ?? "";
		});
		return obj;
	});
	return JSON.stringify(rows, null, "\t");
}
