import { colIndex } from "../model/address";
import { isoFromSerial } from "../model/numbers";
import { createModel, recomputeUsedRange, setRaw, type Align, type GridModel } from "../model/GridModel";
import { shiftFormula } from "./importFormula";

/**
 * CSV and XLSX import.
 *
 * Both readers produce a padded rectangle of cells; `valuesToModel` turns that into a sparse
 * model whose first row is the markdown header. Everything here is pure and synchronous except the
 * XLSX inflate, which uses the web-standard `DecompressionStream` (Electron and Node 22 both have
 * it) — no library, no Node builtin, same reasoning as the hand-written zip writer in `zip.ts`.
 *
 * An XLSX is read whole: every worksheet, and the formula each cell carries. Deciding which of
 * those a table can keep is `importFormula`'s job, not this module's.
 */

export type ImportDelimiter = "," | ";" | "\t";

/* --------------------------------------------------------------------- CSV */

/** Most-to-least preferred when several delimiters are equally consistent: see `detectDelimiter`. */
const DELIMITERS: readonly ImportDelimiter[] = ["\t", ";", ","];
/** Records sampled for delimiter detection. */
const SAMPLE_RECORDS = 20;

/**
 * RFC 4180 CSV into a padded rectangle.
 *
 * A line break inside a quoted field becomes a space, because a GFM cell is a single line. A quote
 * in the middle of an unquoted field is literal, and text after a closing quote is kept rather
 * than rejected — real exports break the RFC in both ways, and dropping data is worse than being
 * lenient. Trailing blank lines are dropped; a blank line in the middle is an empty row.
 */
export function parseCsv(text: string, delimiter?: ImportDelimiter): string[][] {
	const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const delim = delimiter ?? detectDelimiter(src);
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let fieldStart = true;
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i += 2;
				} else {
					inQuotes = false;
					i++;
				}
			} else if (ch === "\r" || ch === "\n") {
				field += " ";
				i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
			} else {
				field += ch;
				i++;
			}
			continue;
		}
		if (ch === '"' && fieldStart) {
			inQuotes = true;
			fieldStart = false;
			i++;
		} else if (ch === delim) {
			row.push(field);
			field = "";
			fieldStart = true;
			i++;
		} else if (ch === "\r" || ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			fieldStart = true;
			i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
		} else {
			field += ch;
			fieldStart = false;
			i++;
		}
	}
	if (!fieldStart || field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	while (rows.length > 0 && rows[rows.length - 1].every((v) => v === "")) rows.pop();
	return padRectangle(rows);
}

/**
 * Picks the delimiter whose per-line count (outside quotes) is the most consistent over the first
 * records. Ties go to tab, then semicolon, then comma: a comma is the one that also turns up inside
 * data — `1,5` is a number in half of Europe — so a file where every line has one semicolon and
 * one comma is far more likely semicolon-separated.
 */
export function detectDelimiter(text: string): ImportDelimiter {
	const counts: number[][] = [];
	let current = [0, 0, 0];
	let inQuotes = false;
	let blank = true;
	for (let i = 0; i < text.length && counts.length < SAMPLE_RECORDS; i++) {
		const ch = text[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			blank = false;
			continue;
		}
		if (inQuotes) continue;
		if (ch === "\n" || ch === "\r") {
			if (!blank) counts.push(current);
			current = [0, 0, 0];
			blank = true;
			continue;
		}
		blank = false;
		const d = DELIMITERS.indexOf(ch as ImportDelimiter);
		if (d !== -1) current[d]++;
	}
	if (!blank && counts.length < SAMPLE_RECORDS) counts.push(current);
	if (counts.length === 0) return ",";

	let best = 2;
	let bestScore = 0;
	for (let d = 0; d < DELIMITERS.length; d++) {
		const perLine = counts.map((c) => c[d]);
		const mode = modeOf(perLine);
		if (mode === 0) continue;
		const score = perLine.filter((n) => n === mode).length / perLine.length;
		if (score > bestScore) {
			best = d;
			bestScore = score;
		}
	}
	return DELIMITERS[best];
}

function modeOf(values: number[]): number {
	const freq = new Map<number, number>();
	let mode = 0;
	let top = 0;
	for (const v of values) {
		const n = (freq.get(v) ?? 0) + 1;
		freq.set(v, n);
		if (n > top || (n === top && v > mode)) {
			mode = v;
			top = n;
		}
	}
	return mode;
}

function padRectangle(rows: string[][]): string[][] {
	const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
	return rows.map((r) => (r.length < width ? r.concat(new Array<string>(width - r.length).fill("")) : r));
}

/* -------------------------------------------------------------------- XLSX */

/** Beyond this the rectangle is more padding than sheet — usually a stray cell far away. */
const MAX_IMPORT_CELLS = 1_000_000;

interface ZipDirEntry {
	name: string;
	method: number;
	compressedSize: number;
	localOffset: number;
}

/** One cell of a worksheet: what it shows, and the formula Excel stored for it. */
export interface SheetCell {
	value: string;
	/**
	 * Excel's A1 formula without the `=`, when the cell has one. It is carried over verbatim: this
	 * module reads the file, `importFormula` decides what the grid can make of it.
	 */
	formula?: string;
}

/** A worksheet as a padded rectangle, with the name the workbook gives it. */
export interface ImportedSheet {
	name: string;
	/** Excel's own `hidden`/`veryHidden`; the import offers such a sheet last, and unchecked. */
	hidden: boolean;
	rows: SheetCell[][];
}

export interface ImportedWorkbook {
	sheets: ImportedSheet[];
}

/**
 * Every worksheet of an XLSX, in workbook order.
 *
 * Shared strings, inline strings, formula string results, booleans (`TRUE`/`FALSE`) and error
 * codes come through as text. Numbers are written as JavaScript's `String(n)`, which is the
 * shortest exact form and never locale-formatted. Dates are numbers in XLSX with only a style to
 * say otherwise, and resolving the style table is out of scope, so a date arrives as its serial
 * number (45000 is 2023-03-15). Line breaks inside a cell become spaces. Fully empty trailing rows
 * and columns are trimmed; leading ones are kept so the layout matches the sheet.
 *
 * Chart sheets, dialog sheets and macro sheets are skipped: they have no grid to import. A sheet
 * whose part is missing from the package is skipped too, rather than guessed at by position.
 */
export async function readXlsxWorkbook(bytes: Uint8Array): Promise<ImportedWorkbook> {
	const entries = readCentralDirectory(bytes);
	const read = async (path: string): Promise<string | null> => {
		const entry = findEntry(entries, path);
		if (entry === null) return null;
		return new TextDecoder().decode(await entryData(bytes, entry));
	};

	const workbook = (await read("xl/workbook.xml")) ?? "";
	const targets = relationshipTargets((await read("xl/_rels/workbook.xml.rels")) ?? "");
	const sharedTarget = targets.find((t) => t.type.endsWith("/sharedStrings"));
	const sharedXml = (await read(sharedTarget === undefined ? "xl/sharedStrings.xml" : resolvePart(sharedTarget.target))) ?? "";
	const shared = sharedStrings(sharedXml);
	const dates = dateStyles((await read("xl/styles.xml")) ?? "");

	const sheets: ImportedSheet[] = [];
	for (const el of elements(workbook, "sheet")) {
		const name = attr(el.attrs, "name") ?? `Sheet${sheets.length + 1}`;
		const state = attr(el.attrs, "state") ?? "visible";
		const rid = attr(el.attrs, "[\\w.-]+:id");
		const target = rid === null ? undefined : targets.find((t) => t.id === rid);
		if (target !== undefined && !target.type.endsWith("/worksheet")) continue;
		const path = target === undefined ? `xl/worksheets/sheet${sheets.length + 1}.xml` : resolvePart(target.target);
		const xml = await read(path);
		if (xml === null) continue;
		sheets.push({ name, hidden: state !== "visible", rows: sheetCells(xml, shared, dates) });
	}
	if (sheets.length === 0) {
		// A package without a usable sheet list still keeps its worksheets under a known folder.
		const parts = entries
			.map((entry) => entry.name)
			.filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
			.sort();
		for (const [index, path] of parts.entries()) {
			const xml = await read(path);
			if (xml === null) continue;
			sheets.push({ name: `Sheet${index + 1}`, hidden: false, rows: sheetCells(xml, shared, dates) });
		}
	}
	if (sheets.length === 0) throw new Error("The workbook has no readable worksheet.");
	return { sheets };
}

/** The first worksheet of an XLSX as a padded rectangle of strings. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
	const workbook = await readXlsxWorkbook(bytes);
	return workbook.sheets[0].rows.map((row) => row.map((cell) => cell.value));
}

function readCentralDirectory(bytes: Uint8Array): ZipDirEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// The end record is 22 bytes plus a comment of up to 64 KiB; scan back for its signature.
	let eocd = -1;
	for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
		if (view.getUint32(at, true) === 0x06054b50) {
			eocd = at;
			break;
		}
	}
	if (eocd === -1) throw new Error("The file is not an XLSX workbook.");
	const count = view.getUint16(eocd + 10, true);
	const dirOffset = view.getUint32(eocd + 16, true);
	if (dirOffset === 0xffffffff || count === 0xffff) throw new Error("ZIP64 workbooks are not supported.");

	const decoder = new TextDecoder();
	const out: ZipDirEntry[] = [];
	let at = dirOffset;
	for (let n = 0; n < count; n++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
			throw new Error("The workbook's ZIP directory is damaged.");
		}
		const nameLen = view.getUint16(at + 28, true);
		const extraLen = view.getUint16(at + 30, true);
		const commentLen = view.getUint16(at + 32, true);
		out.push({
			method: view.getUint16(at + 10, true),
			compressedSize: view.getUint32(at + 20, true),
			localOffset: view.getUint32(at + 42, true),
			name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)),
		});
		at += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

/** Exact match first; part names are case-insensitive in OPC, and some writers act on that. */
function findEntry(entries: ZipDirEntry[], path: string): ZipDirEntry | null {
	const exact = entries.find((e) => e.name === path);
	if (exact !== undefined) return exact;
	const lower = path.toLowerCase();
	return entries.find((e) => e.name.toLowerCase() === lower) ?? null;
}

/**
 * The entry's bytes. Sizes come from the central directory: a local header written in streaming
 * mode carries zeros and puts the real sizes in a data descriptor after the data.
 */
async function entryData(bytes: Uint8Array, entry: ZipDirEntry): Promise<Uint8Array> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const at = entry.localOffset;
	if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) {
		throw new Error("The workbook's ZIP entries are damaged.");
	}
	const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
	const data = bytes.slice(start, start + entry.compressedSize);
	if (entry.method === 0) return data;
	if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Relationship {
	id: string;
	type: string;
	target: string;
}

function relationshipTargets(xml: string): Relationship[] {
	return elements(xml, "Relationship").map((el) => ({
		id: attr(el.attrs, "Id") ?? "",
		type: attr(el.attrs, "Type") ?? "",
		target: attr(el.attrs, "Target") ?? "",
	}));
}

/** Workbook relationship targets are relative to `xl/`, or absolute from the package root. */
function resolvePart(target: string): string {
	const parts = target.startsWith("/") ? [] : ["xl"];
	for (const seg of target.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/");
}

function sharedStrings(xml: string): string[] {
	return elements(xml, "si").map((si) => richText(si.body ?? ""));
}

/** Concatenated text runs, without the phonetic guides (`rPh`) East Asian workbooks carry. */
function richText(xml: string): string {
	const withoutPhonetic = xml.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, "");
	return elements(withoutPhonetic, "t")
		.map((t) => decodeXml(t.body ?? ""))
		.join("");
}

function sheetCells(xml: string, shared: string[], dates: DateStyles): SheetCell[][] {
	interface RawCell {
		row: number;
		col: number;
		value: string;
		formula?: { text: string; kind: string; shared: string | null };
	}
	const raw: RawCell[] = [];
	/** The formula a run of filled cells was copied from, by `si`; see `shiftFormula`. */
	const masters = new Map<string, { text: string; row: number; col: number }>();
	let rows = 0;
	let cols = 0;
	let rowIndex = -1;
	for (const rowEl of elements(xml, "row")) {
		const r = Number.parseInt(attr(rowEl.attrs, "r") ?? "", 10);
		rowIndex = Number.isFinite(r) && r > 0 ? r - 1 : rowIndex + 1;
		let colIndexInRow = -1;
		for (const cell of elements(rowEl.body ?? "", "c")) {
			const ref = /^([A-Za-z]+)(\d+)$/.exec(attr(cell.attrs, "r") ?? "");
			colIndexInRow = ref === null ? colIndexInRow + 1 : colIndex(ref[1]);
			const shown = cellValue(cell.attrs, cell.body ?? "", shared).replace(/\r\n|\r|\n/g, " ");
			// A date is a number with a style; the note gets the date, the formula gets the number.
			const value = dates.isDate(styleIndex(attr(cell.attrs, "s"))) ? isoDateText(shown) : shown;
			const el = elements(cell.body ?? "", "f")[0];
			let formula: RawCell["formula"];
			if (el !== undefined) {
				const kind = attr(el.attrs, "t") ?? "normal";
				// An array or data-table formula is a block with rules of its own, not an A1
				// expression; the cell keeps its value rather than pretending to carry the formula.
				if (kind !== "array" && kind !== "dataTable") {
					formula = { text: (el.body ?? "").trim(), kind, shared: attr(el.attrs, "si") };
				}
			}
			const hasFormula = formula !== undefined && (formula.text !== "" || formula.shared !== null);
			if (value.trim() === "" && !hasFormula) continue;
			raw.push({ row: rowIndex, col: colIndexInRow, value, ...(formula === undefined ? {} : { formula }) });
			rows = Math.max(rows, rowIndex + 1);
			cols = Math.max(cols, colIndexInRow + 1);
		}
	}
	if (rows * cols > MAX_IMPORT_CELLS) throw new Error("The sheet is too large to import as a table.");
	// A filled column is stored once: the first cell holds the formula, the rest say only
	// "shared, si=0". Their own reference is the master's shifted by their offset.
	for (const cell of raw) {
		const f = cell.formula;
		if (f !== undefined && f.kind === "shared" && f.text !== "" && f.shared !== null) {
			masters.set(f.shared, { text: f.text, row: cell.row, col: cell.col });
		}
	}
	const out: SheetCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, (): SheetCell => ({ value: "" })));
	for (const cell of raw) {
		const f = cell.formula;
		let formula: string | undefined;
		if (f !== undefined) {
			if (f.kind === "shared" && f.text === "") {
				const master = f.shared === null ? undefined : masters.get(f.shared);
				if (master !== undefined) formula = shiftFormula(master.text, cell.row - master.row, cell.col - master.col);
			} else if (f.text !== "") {
				formula = f.text;
			}
		}
		out[cell.row][cell.col] = formula === undefined ? { value: cell.value } : { value: cell.value, formula };
	}
	return out;
}

/** A cell's style index, if it has a readable one. */
function styleIndex(style: string | null): number | undefined {
	if (style === null) return undefined;
	const n = Number.parseInt(style, 10);
	return Number.isFinite(n) ? n : undefined;
}

/** The serial a date-styled cell holds, written as the date a person reads. */
function isoDateText(raw: string): string {
	const serial = Number(raw);
	return Number.isFinite(serial) && serial >= 0 ? isoFromSerial(serial) : raw;
}

/**
 * Which cell styles of a workbook show a date.
 *
 * `styles.xml` maps a cell's `s` attribute to an `<xf>`, whose `numFmtId` is either one of Excel's
 * built-in formats or a custom code the workbook carries. Only the question "is this a date?" is
 * answered here — the format itself (a German `TT.MM.JJJJ`, a currency, a percentage) is left
 * where it is, because a markdown cell has one way to say a date and Excel has hundreds.
 */
interface DateStyles {
	isDate(style: number | undefined): boolean;
}

const NO_DATES: DateStyles = { isDate: () => false };

/** Excel's built-in date and time formats. 45–47 are elapsed time, which is a date to us. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(xml: string): DateStyles {
	if (xml === "") return NO_DATES;
	const custom = new Map<number, string>();
	for (const el of elements(xml, "numFmt")) {
		const id = Number.parseInt(attr(el.attrs, "numFmtId") ?? "", 10);
		if (Number.isFinite(id)) custom.set(id, attr(el.attrs, "formatCode") ?? "");
	}
	// `cellXfs` alone: `cellStyleXfs` holds named styles, and their order is not what `s` means.
	const xfs = elements(xml, "cellXfs")[0]?.body ?? "";
	const flags = elements(xfs, "xf").map((xf) => {
		const id = Number.parseInt(attr(xf.attrs, "numFmtId") ?? "0", 10);
		return BUILTIN_DATE_FORMATS.has(id) || isDateFormatCode(custom.get(id) ?? "");
	});
	return { isDate: (style) => style !== undefined && flags[style] === true };
}

/** Whether a custom number format draws a date: `d/m/yyyy`, `[$-409]h:mm`, but not `0.00 "m"`. */
function isDateFormatCode(code: string): boolean {
	const plain = code
		.replace(/"[^"]*"/g, "")
		.replace(/\\./g, "")
		.replace(/\[[^\]]*\]/g, "")
		.toLowerCase();
	return /[ymdhs]/.test(plain);
}

function cellValue(attrs: string, body: string, shared: string[]): string {
	const type = attr(attrs, "t") ?? "n";
	const v = elements(body, "v")[0]?.body;
	const raw = v === undefined || v === null ? "" : decodeXml(v);
	switch (type) {
		case "s":
			return shared[Number.parseInt(raw, 10)] ?? "";
		case "inlineStr": {
			const is = elements(body, "is")[0];
			return is === undefined ? raw : richText(is.body ?? "");
		}
		case "b":
			return raw === "" ? "" : raw === "1" || raw.toLowerCase() === "true" ? "TRUE" : "FALSE";
		case "str":
		case "e":
		case "d":
			return raw;
		default: {
			if (raw.trim() === "") return "";
			const n = Number(raw);
			return Number.isFinite(n) ? String(n) : raw;
		}
	}
}

/* ---------------------------------------------------------------- XML scan */

interface XmlElement {
	attrs: string;
	/** Null for a self-closing element. */
	body: string | null;
}

/**
 * Every `name` element in `xml`, any namespace prefix. A tolerant scan, not a parser: enough for
 * the non-nesting elements of SpreadsheetML (`row`, `c`, `v`, `si`, `t`, `Relationship`), and it
 * runs in plain Node where there is no `DOMParser`. The lookahead keeps `<c>` from matching `<col>`.
 */
function elements(xml: string, name: string): XmlElement[] {
	const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>)`, "g");
	const out: XmlElement[] = [];
	for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
		out.push({ attrs: m[1], body: m[2] ?? null });
	}
	return out;
}

/** `name` is a regex fragment, so a namespaced attribute can be matched with any prefix. */
function attr(attrs: string, name: string): string | null {
	const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
	if (m === null) return null;
	return decodeXml(m[1] ?? m[2] ?? "");
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML entities, numeric references and OOXML's `_xHHHH_` escapes for control characters. */
function decodeXml(s: string): string {
	return s
		.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (m: string, ref: string) => {
			if (ref.startsWith("#x")) return safeCodePoint(Number.parseInt(ref.slice(2), 16)) ?? m;
			if (ref.startsWith("#")) return safeCodePoint(Number.parseInt(ref.slice(1), 10)) ?? m;
			return NAMED_ENTITIES[ref] ?? m;
		})
		.replace(/_x([0-9A-Fa-f]{4})_/g, (m: string, hex: string) => safeCodePoint(Number.parseInt(hex, 16)) ?? m);
}

function safeCodePoint(cp: number): string | null {
	return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
}

/* ------------------------------------------------------------------- model */

/**
 * A model from a rectangle of plain values; the first row becomes the markdown header.
 *
 * Values are trimmed and line breaks flattened (a GFM cell is one line); empties stay absent so
 * the map is sparse. The alignment row pins the full width, so trailing empty header cells do not
 * shrink the table. Values are taken as Markdown as they are — a `*` in the data will render as
 * emphasis, the same as if it had been typed into the grid.
 */
export function valuesToModel(values: string[][]): GridModel {
	const model = createModel();
	let cols = 0;
	values.forEach((row, r) => {
		cols = Math.max(cols, row.length);
		row.forEach((value, c) => setRaw(model, r, c, value.replace(/\r\n|\r|\n/g, " ").trim()));
	});
	model.colAlign = new Array<Align>(cols).fill(null);
	recomputeUsedRange(model);
	return model;
}
