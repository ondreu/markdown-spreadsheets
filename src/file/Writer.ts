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

function splitLines(data: string): { lines: string[]; eol: "\n" | "\r\n" } {
	const eol = data.includes("\r\n") ? "\r\n" : "\n";
	return { lines: data.split(/\r?\n/), eol };
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

			const { lines, eol } = splitLines(data);
			const replacement = normalized.split("\n");
			lines.splice(region.startLine, region.endLine - region.startLine + 1, ...replacement);
			const next = lines.join(eol);

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
			const { eol } = splitLines(data);
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
	 * Layer 3 of §7: writes `^<id>` on its own line right after the table.
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
			const { lines, eol } = splitLines(data);
			lines.splice(region.endLine + 1, 0, `^${id}`);
			ok = true;
			return lines.join(eol);
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
