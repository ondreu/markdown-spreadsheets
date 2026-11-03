import { parseCsv, readXlsx } from "./importTable";

/**
 * Reads a CSV, TSV or Excel file into a rectangle of cell values, choosing by extension. Text is
 * decoded as UTF-8 (a BOM is dropped by `parseCsv`); a `.tsv` is always tab-separated, anything
 * else lets the delimiter be detected.
 */
export async function readTableFile(name: string, data: ArrayBuffer): Promise<string[][]> {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	if (ext === "xlsx") return readXlsx(new Uint8Array(data));
	const text = new TextDecoder("utf-8").decode(data);
	return parseCsv(text, ext === "tsv" ? "\t" : undefined);
}
