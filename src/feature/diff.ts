import { splitCells } from "../model/parse";

/**
 * Line diff and version labels for the restore and conflict dialogs.
 *
 * No dependency and no Obsidian import, so it is unit-testable: the regions being compared are
 * two serializations of the same table, which means they share long identical runs. Trimming the
 * common prefix and suffix first keeps the LCS table small enough to compute outright.
 */

export type DiffKind = "same" | "add" | "remove";

export interface DiffLine {
	kind: DiffKind;
	text: string;
	/** 1-based line number in the left-hand text, absent for an added line. */
	left?: number;
	/** 1-based line number in the right-hand text, absent for a removed line. */
	right?: number;
}

export interface DiffStats {
	added: number;
	removed: number;
}

/** Above this many differing lines on either side the LCS is skipped for a block replace. */
const LCS_LIMIT = 600;

function splitLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
	return normalized === "" ? [] : normalized.split("\n");
}

/**
 * Unified diff of two texts, oldest (`left`) against newest (`right`).
 *
 * `left` is the version being compared *from* — in the restore dialog that is what the grid holds
 * now, so a `remove` is a line the restore would drop.
 */
export function diffLines(left: string, right: string): DiffLine[] {
	const a = splitLines(left);
	const b = splitLines(right);

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const out: DiffLine[] = [];
	for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i], left: i + 1, right: i + 1 });

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const middle =
		midA.length > LCS_LIMIT || midB.length > LCS_LIMIT
			? blockReplace(midA, midB, start)
			: lcsDiff(midA, midB, start);
	out.push(...middle);

	for (let i = endA; i < a.length; i++) {
		out.push({ kind: "same", text: a[i], left: i + 1, right: i + 1 + (b.length - a.length) });
	}
	return out;
}

function blockReplace(a: string[], b: string[], offset: number): DiffLine[] {
	const out: DiffLine[] = [];
	for (let i = 0; i < a.length; i++) out.push({ kind: "remove", text: a[i], left: offset + i + 1 });
	for (let i = 0; i < b.length; i++) out.push({ kind: "add", text: b[i], right: offset + i + 1 });
	return out;
}

function lcsDiff(a: string[], b: string[], offset: number): DiffLine[] {
	const rows = a.length;
	const cols = b.length;
	// table[i][j] = length of the longest common subsequence of a[i..] and b[j..].
	const table: number[][] = [];
	for (let i = 0; i <= rows; i++) table.push(new Array<number>(cols + 1).fill(0));
	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < cols) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i], left: offset + i + 1, right: offset + j + 1 });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			out.push({ kind: "remove", text: a[i], left: offset + i + 1 });
			i++;
		} else {
			out.push({ kind: "add", text: b[j], right: offset + j + 1 });
			j++;
		}
	}
	while (i < rows) {
		out.push({ kind: "remove", text: a[i], left: offset + i + 1 });
		i++;
	}
	while (j < cols) {
		out.push({ kind: "add", text: b[j], right: offset + j + 1 });
		j++;
	}
	return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.kind === "add") added++;
		else if (line.kind === "remove") removed++;
	}
	return { added, removed };
}

/** "12 lines added, 3 removed" — the one-line summary above a diff. */
export function describeDiff(stats: DiffStats): string {
	if (stats.added === 0 && stats.removed === 0) return "Identical to what the grid holds now";
	const parts: string[] = [];
	if (stats.added > 0) parts.push(`${stats.added} ${stats.added === 1 ? "line" : "lines"} added`);
	if (stats.removed > 0) parts.push(`${stats.removed} ${stats.removed === 1 ? "line" : "lines"} removed`);
	return parts.join(", ");
}

/** "3 hours ago" — the timestamp alone makes two versions from one session hard to tell apart. */
export function relativeTime(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "Just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	const days = Math.round(hours / 24);
	return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Rows × columns of a serialized region, so a version's size is visible before restoring it. */
export function tableShape(text: string): string {
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	const rows = Math.max(0, lines.length - 1);
	const cols = lines.length === 0 ? 0 : Math.max(0, splitCells(lines[0]).length);
	return `${rows} × ${cols}`;
}
