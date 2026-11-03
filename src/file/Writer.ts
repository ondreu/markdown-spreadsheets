import type { TFile, Vault } from "obsidian";
import { fnv1a } from "../model/hash";
import { anchorFromRegion, resolveAnchor, type Anchor, type ScoredRegion } from "./AnchorResolver";
import { scanTables, type TableRegion } from "./scanTables";

export type WriteOutcome =
	| { kind: "written"; region: TableRegion; blockText: string; anchor: Anchor }
	/** The region changed under us — the caller must show the banner, never resolve it silently. */
	| { kind: "conflict"; region: TableRegion; currentText: string }
	| { kind: "missing" }
	| { kind: "ambiguous"; candidates: ScoredRegion[] }
	| { kind: "unchanged"; region: TableRegion; anchor: Anchor };

/** Hash of a region's text, normalized so that a pure line-ending change is not a conflict. */
export function regionHash(text: string): string {
	return fnv1a(text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, ""));
}

interface SplitText {
	lines: string[];
	/** `seps[i]` joins `lines[i]` and `lines[i + 1]`, so there is one fewer than there are lines. */
	seps: string[];
}

function splitText(data: string): SplitText {
	const parts = data.split(/(\r?\n)/);
	const lines: string[] = [];
	const seps: string[] = [];
	for (let i = 0; i < parts.length; i++) (i % 2 === 0 ? lines : seps).push(parts[i]);
	return { lines, seps };
}

/** The line ending most of the note uses, for lines that did not exist before. */
function dominantEol(seps: string[]): string {
	let crlf = 0;
	for (const sep of seps) if (sep === "\r\n") crlf++;
	return crlf * 2 > seps.length ? "\r\n" : "\n";
}

/**
 * Replaces `deleteCount` lines at `start` with `insert`, keeping every other line ending exactly
 * as it was.
 *
 * Splitting on `/\r?\n/` and joining with one detected ending used to rewrite the line endings of
 * the whole note whenever it mixed CRLF and LF — a change far outside the table, and one a Git
 * diff shows as every line touched. Only the new lines get an ending chosen here: the one the
 * replaced region used, else the note's dominant one.
 */
export function spliceLines(data: string, start: number, deleteCount: number, insert: string[]): string {
	const { lines, seps } = splitText(data);
	const eol = seps[start] ?? seps[start - 1] ?? dominantEol(seps);
	const end = start + deleteCount;
	const outLines = [...lines.slice(0, start), ...insert, ...lines.slice(end)];
	const outSeps: string[] = seps.slice(0, Math.min(start, seps.length));
	// Appending past the last line needs a separator in front of the new block.
	if (start >= lines.length && insert.length > 0 && lines.length > 0) outSeps.push(eol);
	for (let i = 1; i < insert.length; i++) outSeps.push(eol);
	if (end < lines.length && insert.length > 0) outSeps.push(deleteCount > 0 ? (seps[end - 1] ?? eol) : eol);
	outSeps.push(...seps.slice(end));
	let out = "";
	for (let i = 0; i < outLines.length; i++) out += outLines[i] + (outSeps[i] ?? "");
	return out;
}

/**
 * The only code path that writes into a note.
 *
 * `vault.process` is an atomic read-modify-write; the `read()` + `modify()` pair it replaces
 * loses whatever another writer did in between (§13.1). Everything the write depends on —
 * re-resolving the anchor, hashing the current region — happens *inside* the callback, on the
 * exact string that is about to be replaced.
 */
export class Writer {
	constructor(private readonly vault: Vault) {}

	/**
	 * Replaces the anchored region with `blockText`.
	 *
	 * `expectedHash` is the hash of the region as the grid last saw it. A mismatch means
	 * someone else edited those lines, and the write is abandoned rather than guessed at.
	 */
	async write(file: TFile, anchor: Anchor, blockText: string, expectedHash: string): Promise<WriteOutcome> {
		let outcome: WriteOutcome = { kind: "missing" };

		await this.vault.process(file, (data) => {
			const resolution = resolveAnchor(data, anchor);
			if (resolution.kind === "missing") {
				outcome = { kind: "missing" };
				return data;
			}
			if (resolution.kind === "ambiguous") {
				outcome = { kind: "ambiguous", candidates: resolution.candidates };
				return data;
			}

			const region = resolution.region;
			const currentHash = regionHash(region.text);
			if (currentHash !== expectedHash) {
				outcome = { kind: "conflict", region, currentText: region.text };
				return data;
			}

			const normalized = blockText.replace(/\r\n/g, "\n").replace(/\n+$/, "");
			if (regionHash(normalized) === currentHash) {
				outcome = { kind: "unchanged", region, anchor: anchorFromRegion(file.path, region) };
				return data;
			}

			const replacement = normalized.split("\n");
			const next = spliceLines(data, region.startLine, region.endLine - region.startLine + 1, replacement);

			// Re-scan so the returned anchor describes the table as it now exists on disk.
			const after = scanTables(next);
			const written = after.find((r) => r.startLine === region.startLine) ?? after[region.index] ?? region;
			outcome = {
				kind: "written",
				region: written,
				blockText: normalized,
				anchor: anchorFromRegion(file.path, written),
			};
			return next;
		});

		return outcome;
	}

	/** Recovery action for a vanished anchor: put the table back at the end of the note. */
	async appendTable(file: TFile, blockText: string): Promise<TableRegion | null> {
		let region: TableRegion | null = null;
		await this.vault.process(file, (data) => {
			const eol = dominantEol(splitText(data).seps);
			const body = blockText.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").join(eol);
			const sep = data.length === 0 || data.endsWith(eol + eol) ? "" : data.endsWith(eol) ? eol : eol + eol;
			const next = data + sep + body + eol;
			const tables = scanTables(next);
			region = tables.length > 0 ? tables[tables.length - 1] : null;
			return next;
		});
		return region;
	}

	/**
	 * Layer 3 of §7: writes `^<id>` on its own line after the table.
	 *
	 * Obsidian's documentation asks for a blank line before and after the ID of a structured
	 * block such as a table, so that is what is written; `blockIdAfter` reads it back, and also
	 * reads an ID directly below the table, which is what earlier versions wrote.
	 *
	 * This is the only feature that modifies the note beyond the table itself, so it is never
	 * reached without an explicit confirmation from the user.
	 */
	async addBlockId(file: TFile, anchor: Anchor, id: string): Promise<boolean> {
		let ok = false;
		await this.vault.process(file, (data) => {
			const resolution = resolveAnchor(data, anchor);
			if (resolution.kind !== "resolved") return data;
			const region = resolution.region;
			if (region.blockId !== undefined) {
				ok = true;
				return data;
			}
			const { lines } = splitText(data);
			const following = lines[region.endLine + 1];
			const insert = ["", `^${id}`];
			if (following !== undefined && following.trim() !== "") insert.push("");
			ok = true;
			return spliceLines(data, region.endLine + 1, 0, insert);
		});
		return ok;
	}

	/** Reads the current text of the anchored region without touching the file. */
	async readRegion(file: TFile, anchor: Anchor): Promise<WriteOutcome> {
		const data = await this.vault.cachedRead(file);
		const resolution = resolveAnchor(data, anchor);
		if (resolution.kind === "missing") return { kind: "missing" };
		if (resolution.kind === "ambiguous") return { kind: "ambiguous", candidates: resolution.candidates };
		return {
			kind: "unchanged",
			region: resolution.region,
			anchor: anchorFromRegion(file.path, resolution.region),
		};
	}
}
