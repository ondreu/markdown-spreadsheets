import { fnv1a } from "../model/hash";
import { headerSignature, isDelimiterRow, splitCells } from "../model/parse";

export interface TableRegion {
	/** 0-based line of the header row. */
	startLine: number;
	/** 0-based line of the last body row, inclusive. */
	endLine: number;
	/** n-th table in the file, 0-based. */
	index: number;
	headerHash: string;
	headerCells: string[];
	colCount: number;
	/** Header row included, matching `GridModel.usedRange.rows`. */
	rowCount: number;
	/** Nearest heading above the table, without the leading `#`s. */
	precedingHeading?: string;
	/** Block ID on the line right after the table, without the `^`. */
	blockId?: string;
	/** The table block itself, newline-joined, without a trailing newline. */
	text: string;
}

const BLOCK_ID = /^\^([a-zA-Z0-9][a-zA-Z0-9-]*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const FENCE = /^\s{0,3}(```+|~~~+)/;

/**
 * Finds every GFM table in a markdown document, working from the text alone.
 *
 * `MetadataCache` would give the same answer most of the time, but the write path has to
 * re-resolve the anchor *inside* `vault.process`, where only the raw string exists and the
 * cache may be a revision behind. One scanner for both paths means the read and the write
 * can never disagree about where the table starts.
 */
export function scanTables(text: string): TableRegion[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const out: TableRegion[] = [];

	let inFence = false;
	let fenceMarker = "";
	let lastHeading: string | undefined;

	// YAML front matter is not markdown; a `|` inside it must never look like a table.
	let i = 0;
	if (lines[0] !== undefined && lines[0].trim() === "---") {
		for (let j = 1; j < lines.length; j++) {
			if (lines[j].trim() === "---") {
				i = j + 1;
				break;
			}
		}
	}

	for (; i < lines.length; i++) {
		const line = lines[i];

		const fence = FENCE.exec(line);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fence[1][0];
			} else if (fence[1][0] === fenceMarker) {
				inFence = false;
			}
			continue;
		}
		if (inFence) continue;

		const heading = HEADING.exec(line);
		if (heading) {
			lastHeading = heading[1].trim();
			continue;
		}

		if (!line.includes("|") || line.trim() === "") continue;
		const next = lines[i + 1];
		if (next === undefined || !isDelimiterRow(next)) continue;
		// The header row itself must not be an alignment row.
		if (isDelimiterRow(line)) continue;

		const startLine = i;
		let endLine = i + 1;
		for (let j = i + 2; j < lines.length; j++) {
			const body = lines[j];
			if (body.trim() === "" || !body.includes("|")) break;
			if (FENCE.test(body)) break;
			endLine = j;
		}

		const headerCells = splitCells(line);
		const region: TableRegion = {
			startLine,
			endLine,
			index: out.length,
			headerHash: fnv1a(headerSignature(line)),
			headerCells,
			colCount: Math.max(headerCells.length, splitCells(next).length),
			rowCount: endLine - startLine, // header + body, alignment row excluded
			text: lines.slice(startLine, endLine + 1).join("\n"),
		};
		if (lastHeading !== undefined) region.precedingHeading = lastHeading;

		const after = lines[endLine + 1];
		if (after !== undefined) {
			const id = BLOCK_ID.exec(after.trim());
			if (id) region.blockId = id[1];
		}

		out.push(region);
		i = endLine;
	}

	return out;
}

/** Short preview used by the "pick the right table" dialog (§7, layer 2). */
export function previewOf(region: TableRegion, maxCols = 4): string {
	const cells = region.headerCells.slice(0, maxCols).map((c) => (c === "" ? "—" : c));
	const more = region.headerCells.length > maxCols ? " …" : "";
	return cells.join(" · ") + more;
}
