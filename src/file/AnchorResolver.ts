import { scanTables, type TableRegion } from "./scanTables";

export interface Anchor {
	path: string;
	/** n-th table in the file, 0-based. */
	tableIndex: number;
	headerHash: string;
	colCount: number;
	rowCount: number;
	precedingHeading?: string;
	/** Set only once the user opted in to layer 3 (§7). */
	blockId?: string;
}

export type Resolution =
	| { kind: "resolved"; region: TableRegion; score: number }
	| { kind: "ambiguous"; candidates: ScoredRegion[] }
	| { kind: "missing" };

export interface ScoredRegion {
	region: TableRegion;
	score: number;
}

/** Minimum lead over the runner-up before a match is taken without asking (§7). */
export const DECISIVE_MARGIN = 30;

export function anchorKey(anchor: Anchor): string {
	return `${anchor.path}::t${anchor.tableIndex}::${anchor.headerHash}`;
}

export function anchorFromRegion(path: string, region: TableRegion): Anchor {
	const anchor: Anchor = {
		path,
		tableIndex: region.index,
		headerHash: region.headerHash,
		colCount: region.colCount,
		rowCount: region.rowCount,
	};
	if (region.precedingHeading !== undefined) anchor.precedingHeading = region.precedingHeading;
	if (region.blockId !== undefined) anchor.blockId = region.blockId;
	return anchor;
}

/**
 * Scores one candidate against the anchor.
 *
 * Weights come straight from §7: header hash dominates, the preceding heading is the next
 * strongest signal, and positional distance is only a tie-breaker so that inserting a table
 * above the target does not move the match.
 */
export function scoreRegion(anchor: Anchor, region: TableRegion): number {
	// An explicit block ID is an exact identity; nothing else can outrank it.
	if (anchor.blockId !== undefined && region.blockId === anchor.blockId) return 1000;

	let score = 0;
	if (region.headerHash === anchor.headerHash) score += 100;
	if (
		anchor.precedingHeading !== undefined &&
		region.precedingHeading !== undefined &&
		region.precedingHeading === anchor.precedingHeading
	) {
		score += 40;
	}
	if (region.colCount === anchor.colCount) score += 20;

	const rowDelta = Math.abs(region.rowCount - anchor.rowCount);
	score += Math.max(0, 10 - rowDelta);

	score -= 5 * Math.abs(region.index - anchor.tableIndex);
	return score;
}

/**
 * Locates the anchored table in `text`.
 *
 * Layer 1 (a single table in the file) short-circuits everything, because it is both the
 * common case and the only unambiguous one. Otherwise all tables are scored and the winner
 * is accepted only with a clear lead — anything closer goes to the user.
 */
export function resolveAnchor(text: string, anchor: Anchor): Resolution {
	const regions = scanTables(text);
	if (regions.length === 0) return { kind: "missing" };
	if (regions.length === 1) return { kind: "resolved", region: regions[0], score: Number.POSITIVE_INFINITY };

	const scored: ScoredRegion[] = regions
		.map((region) => ({ region, score: scoreRegion(anchor, region) }))
		.sort((a, b) => b.score - a.score);

	const best = scored[0];
	const runnerUp = scored[1];
	if (best.score - runnerUp.score >= DECISIVE_MARGIN) {
		return { kind: "resolved", region: best.region, score: best.score };
	}
	return { kind: "ambiguous", candidates: scored };
}

/** Finds the table containing `line`, used when opening from the editor cursor. */
export function regionAtLine(text: string, line: number): TableRegion | null {
	for (const region of scanTables(text)) {
		if (line >= region.startLine && line <= region.endLine) return region;
	}
	return null;
}

/** Generates a short, collision-unlikely block ID for layer 3. */
export function newBlockId(): string {
	const rand = Math.floor(Math.random() * 0xfffff)
		.toString(16)
		.padStart(5, "0");
	return `grid-${rand}`;
}
