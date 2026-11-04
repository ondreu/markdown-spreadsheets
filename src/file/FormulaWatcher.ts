import { TFile, type Vault } from "obsidian";
import type { NumberParseOptions } from "../model/numbers";
import { formatNumber } from "../model/numbers";
import { parseTable } from "../model/parse";
import { serializeTable } from "../model/serialize";
import type { MarkdownSpreadsheetsSettings } from "../settings";
import { recalculate } from "../feature/formula";
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
	private disposed = false;
	private sweeping = false;

	constructor(
		private readonly vault: Vault,
		private readonly settings: () => MarkdownSpreadsheetsSettings,
		/** A note open in an editor or a grid: not ours to rewrite. */
		private readonly isOpen: (path: string) => boolean,
	) {}

	/** A note changed on disk. Debounced per path: Sync delivers a burst of events per save. */
	schedule(file: TFile): void {
		if (this.disposed || file.extension !== "md") return;
		if (!this.settings().recalculateInBackground || this.isOpen(file.path)) return;
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
		if (this.disposed || this.isOpen(file.path) || !this.settings().recalculateInBackground) return 0;
		let text: string;
		try {
			text = await this.vault.cachedRead(file);
		} catch {
			return 0;
		}
		if (!text.includes("%%=")) return 0;
		const settings = this.settings();
		const numberOpts: NumberParseOptions = { decimalSeparator: settings.decimalSeparator };
		try {
			return await new Writer(this.vault).reformatAll(file, (tableText) => {
				const model = parseTable(tableText);
				const result = recalculate(model, {
					numberOpts,
					// Same shape as the grid's own formatter: whole numbers without decimals, the
					// rest at the setting's precision, in the locale the vault is read in.
					format: (value) =>
						Number.isInteger(value)
							? formatNumber(value, 0, settings.numberLocale)
							: formatNumber(value, settings.defaultDecimals, settings.numberLocale),
				});
				if (result.changed.length === 0) return tableText;
				return serializeTable(model, { compact: settings.tableStyle === "compact" });
			});
		} catch {
			// A note being written by something else right now is not an error worth a notice; the
			// next event schedules another attempt.
			return 0;
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
