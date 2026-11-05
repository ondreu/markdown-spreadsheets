import { TFile, type Vault } from "obsidian";
import type { NumberParseOptions } from "../model/numbers";
import { formatNumber } from "../model/numbers";
import { applyConditionalFormats } from "../feature/conditional";
import { parseTable } from "../model/parse";
import { serializeTable } from "../model/serialize";
import { conditionalEnabled, formulasEnabled, type MarkdownSpreadsheetsSettings } from "../settings";
import { recalculate } from "../feature/formula";
import { shiftTableRefs, tableIndexMap } from "../feature/workbook";
import { scanTables } from "./scanTables";
import { Writer } from "./Writer";

/**
 * Keeps the numbers in formula cells honest when the note changes outside the grid.
 *
 * A formula cell stores its last computed value as literal text, so the note reads correctly
 * without the plugin — and goes quietly stale the moment something else edits the table: Obsidian
 * Sync delivering a change from a phone, another plugin, a person typing in the source. Opening
 * the grid fixes it; nothing else did. So the plugin watches.
 *
 * Three rules keep it from becoming a hazard:
 *
 * 1. **Only files that actually contain a formula** — one `includes("%%=")` on the cached text.
 * 2. **Never a file that is open.** An open note has an editor buffer that the vault write would
 *    race; an open grid has its own conflict handling. Both are skipped, and the grid recalculates
 *    when it is opened anyway.
 * 3. **A write happens only when a value changed.** `recalculate` reports what it rewrote, and the
 *    table is serialized back only then, so a file that was already right is never touched.
 *
 * The sweep at startup is the same operation over notes recently edited, because the changes that
 * matter most — a phone edit arriving while the desktop was closed — are exactly the ones no event
 * will announce.
 */

const DEBOUNCE_MS = 1200;
const SWEEP_DELAY_MS = 4000;
const SWEEP_CHUNK = 20;
const SWEEP_PAUSE_MS = 120;
/** Older notes are almost never edited from another device; the sweep leaves them alone. */
const SWEEP_MAX_AGE_DAYS = 45;

export class FormulaWatcher {
	private readonly timers = new Map<string, number>();
	/**
	 * The tables each note had the last time it was looked at: headers and height, in order. Only in
	 * memory — the note itself carries no record of what moved, and a restart simply starts over.
	 */
	private readonly structure = new Map<string, string[]>();
	private disposed = false;
	private sweeping = false;

	constructor(
		private readonly vault: Vault,
		private readonly settings: () => MarkdownSpreadsheetsSettings,
		/** A note open in an editor or a grid: not ours to rewrite. */
		private readonly isOpen: (path: string) => boolean,
		/** Obsidian's `Notice` in the app; a no-op in tests, which have no Obsidian. */
		private readonly notify: (message: string) => void = () => {},
	) {}

	/** A note changed on disk. Debounced per path: Sync delivers a burst of events per save. */
	schedule(file: TFile): void {
		if (this.disposed || file.extension !== "md") return;
		// The feature switch comes first: in Markdown-only mode the plugin does not touch values at
		// all, so a background pass would be a write nobody asked for (decision 38).
		if (!formulasEnabled(this.settings())) return;
		if (!this.settings().recalculateInBackground) return;
		// A note open in an editor is not ours to write, but its table order still has to be watched:
		// inserting a table above another silently moves every `Table3!` reference.
		if (this.isOpen(file.path)) {
			void this.watchStructure(file, false);
			return;
		}
		const running = this.timers.get(file.path);
		if (running !== undefined) window.clearTimeout(running);
		const id = window.setTimeout(() => {
			this.timers.delete(file.path);
			void this.run(file);
		}, DEBOUNCE_MS);
		this.timers.set(file.path, id);
	}

	/** Recalculates every table of one note. Returns how many tables needed a write. */
	async run(file: TFile): Promise<number> {
		if (this.disposed || !formulasEnabled(this.settings())) return 0;
		if (!this.settings().recalculateInBackground) return 0;
		await this.watchStructure(file, !this.isOpen(file.path));
		if (this.isOpen(file.path)) return 0;
		let text: string;
		try {
			text = await this.vault.cachedRead(file);
		} catch {
			return 0;
		}
		// `%%=…%%` is a formula, `%%cf…%%` a conditional rule; a note with neither is not ours.
		if (!text.includes("%%=") && !text.includes("%%cf")) return 0;
		const settings = this.settings();
		const numberOpts: NumberParseOptions = { decimalSeparator: settings.decimalSeparator };
		try {
			return await new Writer(this.vault).reformatAll(file, (tableText) => {
				const model = parseTable(tableText);
				const formatted = conditionalEnabled(settings) ? applyConditionalFormats(model, numberOpts) : [];
				const result = recalculate(model, {
					numberOpts,
					// Same shape as the grid's own formatter: whole numbers without decimals, the
					// rest at the setting's precision, in the locale the vault is read in.
					format: (value) =>
						Number.isInteger(value)
							? formatNumber(value, 0, settings.numberLocale)
							: formatNumber(value, settings.defaultDecimals, settings.numberLocale),
				});
				if (result.changed.length === 0 && formatted.length === 0) return tableText;
				return serializeTable(model, { compact: settings.tableStyle === "compact" });
			});
		} catch {
			// A note being written by something else right now is not an error worth a notice; the
			// next event schedules another attempt.
			return 0;
		}
	}

	/** What the tables of a note look like from the outside: headers, then how many lines. */
	private fingerprints(text: string): string[] {
		return scanTables(text).map((region) => `${region.headerCells.join("|")}#${region.text.split("\n").length}`);
	}

	/**
	 * Keeps `TableN!` honest when a table is inserted or removed above another.
	 *
	 * Numbers are what the note says, so inserting a table renumbers everything below it. When the
	 * note is closed the references are rewritten (`allowWrite`); when it is open in an editor they
	 * cannot be, so it says so instead of writing under somebody's caret.
	 */
	private async watchStructure(file: TFile, allowWrite: boolean): Promise<void> {
		let text: string;
		try {
			text = await this.vault.cachedRead(file);
		} catch {
			return;
		}
		const previous = this.structure.get(file.path);
		const current = this.fingerprints(text);
		this.structure.set(file.path, current);
		if (previous === undefined || previous.length === 0 || !text.includes("Table")) return;
		const { map, moved } = tableIndexMap(previous, current);
		if (!moved) return;
		const shifted = shiftTableRefs(text, map);
		if (shifted === text) {
			// Nothing references a table by number, so nothing can be wrong.
			return;
		}
		if (!allowWrite) {
			this.notify(`${file.basename}: a table was added or removed, so the TableN references in its formulas may point at another table. Close the note and let the plugin fix them, or check them by hand.`);
			return;
		}
		try {
			await this.vault.process(file, (data) => shiftTableRefs(data, map));
			this.notify(`Moved the TableN references in ${file.basename} to follow the table they name.`);
		} catch {
			// Written by something else at this instant; the next modify event tries again.
		}
	}

	/** One pass over recently edited notes, after startup. Chunked so the app stays responsive. */
	sweep(): void {
		if (this.disposed || this.sweeping || !this.settings().recalculateInBackground) return;
		this.sweeping = true;
		const cutoff = Date.now() - SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		const files = this.vault.getMarkdownFiles().filter((file) => file.stat.mtime >= cutoff);
		let index = 0;
		const step = (): void => {
			if (this.disposed || !this.settings().recalculateInBackground) {
				this.sweeping = false;
				return;
			}
			const chunk = files.slice(index, index + SWEEP_CHUNK);
			index += SWEEP_CHUNK;
			void Promise.all(chunk.map((file) => this.run(file))).then(() => {
				if (index < files.length) window.setTimeout(step, SWEEP_PAUSE_MS);
				else this.sweeping = false;
			});
		};
		window.setTimeout(step, SWEEP_DELAY_MS);
	}

	dispose(): void {
		this.disposed = true;
		for (const id of this.timers.values()) window.clearTimeout(id);
		this.timers.clear();
	}
}
