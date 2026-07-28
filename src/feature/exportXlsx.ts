import { colName } from "../model/address";
import { getRaw, type Align, type GridModel } from "../model/GridModel";
import { parseNumber, type NumberParseOptions } from "../model/numbers";
import type { TableLayout } from "../store/Sidecar";
import { plainText } from "./exportCsv";
import { buildZip, type ZipEntry } from "./zip";

export interface XlsxOptions {
	sheetName: string;
	/** `raw` keeps the markdown text, `plain` exports the display text. */
	content: "raw" | "plain";
	/** Numeric-looking cells become real numbers instead of text. */
	detectNumbers: boolean;
	/** Bold the header row and freeze it, the way a person would do it by hand. */
	styleHeader: boolean;
	numberOpts?: NumberParseOptions;
	layout?: TableLayout;
	defaultColWidth: number;
}

export const DEFAULT_XLSX_OPTIONS: Omit<XlsxOptions, "sheetName"> = {
	content: "raw",
	detectNumbers: true,
	styleHeader: true,
	defaultColWidth: 120,
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** XML 1.0 forbids most control characters outright, so they are dropped, not escaped. */
export function xmlEscape(value: string): string {
	let out = "";
	for (const ch of value) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) continue;
		switch (ch) {
			case "&":
				out += "&amp;";
				break;
			case "<":
				out += "&lt;";
				break;
			case ">":
				out += "&gt;";
				break;
			case '"':
				out += "&quot;";
				break;
			case "'":
				out += "&apos;";
				break;
			default:
				out += ch;
		}
	}
	return out;
}

/** Excel column width is measured in characters of the default font, not pixels. */
function pxToChars(px: number): number {
	return Math.max(2, Math.round(((px - 5) / 7) * 100) / 100);
}

function alignmentIndex(align: Align): number {
	switch (align) {
		case "center":
			return 1;
		case "right":
			return 2;
		default:
			return 0;
	}
}

/**
 * Style table.
 *
 * Markdown can only express alignment (per column), inline emphasis and wrapping, so twelve
 * cell formats cover everything: three alignments × bold/regular × wrap/no-wrap. D1 rules out
 * colours and merges, which is what keeps this table small enough to enumerate.
 */
function stylesXml(): string {
	const alignments = ["general", "center", "right"];
	const xfs: string[] = [];
	for (const wrap of [0, 1]) {
		for (const bold of [0, 1]) {
			for (let a = 0; a < alignments.length; a++) {
				const attrs: string[] = [];
				if (a !== 0) attrs.push(`horizontal="${alignments[a]}"`);
				if (wrap === 1) attrs.push('wrapText="1"');
				const alignEl = attrs.length > 0 ? `<alignment ${attrs.join(" ")}/>` : "";
				const applyAlign = attrs.length > 0 ? ' applyAlignment="1"' : "";
				xfs.push(
					`<xf numFmtId="0" fontId="${bold}" fillId="0" borderId="0" xfId="0" applyFont="1"${applyAlign}>${alignEl}</xf>`,
				);
			}
		}
	}
	return `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

export function styleIndex(align: Align, bold: boolean, wrap: boolean): number {
	return (wrap ? 6 : 0) + (bold ? 3 : 0) + alignmentIndex(align);
}

function sheetXml(model: GridModel, options: XlsxOptions): string {
	const rows = Math.max(model.usedRange.rows, 1);
	const cols = Math.max(model.usedRange.cols, 1);
	const layout = options.layout;

	const colDefs: string[] = [];
	for (let c = 0; c < cols; c++) {
		const px = layout?.colWidths[c];
		const width = pxToChars(px !== undefined && px > 0 ? px : options.defaultColWidth);
		colDefs.push(`<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`);
	}

	const body: string[] = [];
	for (let r = 0; r < rows; r++) {
		const cells: string[] = [];
		for (let c = 0; c < cols; c++) {
			const raw = getRaw(model, r, c);
			if (raw.trim() === "") continue;
			const text = options.content === "plain" ? plainText(raw) : raw;
			const ref = `${colName(c)}${r + 1}`;
			const bold = options.styleHeader && r === 0;
			const style = styleIndex(model.colAlign[c] ?? null, bold, layout?.wrapCols.includes(c) ?? false);
			const num = options.detectNumbers ? parseNumber(text, options.numberOpts) : null;
			if (num !== null) {
				cells.push(`<c r="${ref}" s="${style}"><v>${num}</v></c>`);
			} else {
				cells.push(`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`);
			}
		}
		const px = layout?.rowHeights[String(r)];
		const heightAttr = px !== undefined ? ` ht="${Math.round((px * 0.75 + Number.EPSILON) * 100) / 100}" customHeight="1"` : "";
		body.push(`<row r="${r + 1}"${heightAttr}>${cells.join("")}</row>`);
	}

	const frozenRows = options.styleHeader ? Math.max(1, layout?.frozenRows ?? 1) : (layout?.frozenRows ?? 0);
	const frozenCols = layout?.frozenCols ?? 0;
	const pane =
		frozenRows > 0 || frozenCols > 0
			? `<pane xSplit="${frozenCols}" ySplit="${frozenRows}" topLeftCell="${colName(frozenCols)}${frozenRows + 1}" activePane="bottomRight" state="frozen"/>`
			: "";

	const dimension = `A1:${colName(cols - 1)}${rows}`;
	return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${colDefs.join("")}</cols><sheetData>${body.join("")}</sheetData></worksheet>`;
}

/** Excel rejects sheet names containing these, and silently truncates past 31 characters. */
export function sanitizeSheetName(name: string): string {
	const cleaned = name.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim();
	const bounded = cleaned.length > 31 ? cleaned.slice(0, 31) : cleaned;
	return bounded === "" ? "Sheet1" : bounded;
}

export function buildXlsx(model: GridModel, options: XlsxOptions, at: Date): Uint8Array {
	const encoder = new TextEncoder();
	const sheet = sanitizeSheetName(options.sheetName);

	const files: Array<{ path: string; text: string }> = [
		{
			path: "[Content_Types].xml",
			text: `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
		},
		{
			path: "_rels/.rels",
			text: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		},
		{
			path: "xl/workbook.xml",
			text: `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		},
		{
			path: "xl/_rels/workbook.xml.rels",
			text: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
		},
		{ path: "xl/styles.xml", text: stylesXml() },
		{ path: "xl/worksheets/sheet1.xml", text: sheetXml(model, options) },
	];

	const entries: ZipEntry[] = files.map((f) => ({ path: f.path, data: encoder.encode(f.text) }));
	return buildZip(entries, at);
}

/** Ready for `Vault.createBinary`. */
export function xlsxBuffer(model: GridModel, options: XlsxOptions, at: Date): ArrayBuffer {
	const bytes = buildXlsx(model, options, at);
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}
