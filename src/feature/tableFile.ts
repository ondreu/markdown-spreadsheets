import { parseCsv, readXlsxWorkbook, type ImportedSheet } from "./importTable";

/** A file read for import: one sheet for delimited text, every worksheet for a workbook. */
export interface TableBook {
	sheets: ImportedSheet[];
}

/**
 * Reads a CSV, TSV or Excel file into sheets of cells.
 *
 * Text is decoded as UTF-8 (a BOM is dropped by `parseCsv`); a `.tsv` is always tab-separated,
 * anything else lets the delimiter be detected. A delimited file is one sheet, named after the
 * file, so the same import path serves both and the dialog never has to ask about a CSV.
 */
export async function readTableBook(name: string, data: ArrayBuffer): Promise<TableBook> {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	if (ext === "xlsx") return readXlsxWorkbook(new Uint8Array(data));
	const text = new TextDecoder("utf-8").decode(data);
	const rows = parseCsv(text, ext === "tsv" ? "\t" : undefined).map((row) => row.map((value) => ({ value })));
	return { sheets: [{ name: name.replace(/\.[^.]+$/, ""), hidden: false, rows }] };
}
