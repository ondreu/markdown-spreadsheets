import { prepareFuzzySearch, type App, type TFile } from "obsidian";
import { asElement } from "./dom";

/** What a suggestion replaces: `text[from, to)` of the editor's value becomes `insert`. */
export interface Suggestion {
	label: string;
	detail?: string;
	insert: string;
	from: number;
	to: number;
	/** Where the caret goes, relative to `from`. Defaults to the end of `insert`. */
	caret?: number;
	/** Picking it also commits the cell. */
	commits?: boolean;
}

export interface SuggestSource {
	app: App;
	sourcePath: string;
	/** Distinct values of the edited column, most frequent first. */
	columnValues(): string[];
}

const MAX_ITEMS = 40;
const LINK_CONTEXT = /\[\[([^\][|#^]*)$/;
const TAG_CONTEXT = /(^|\s)#([^\s#]*)$/;

/**
 * Suggestions under the cell editor: `[[` links, `#` tags, and values already used in the column —
 * the last one is Excel's AutoComplete, and Alt+Down lists them all like Excel's pick list.
 *
 * Its own small popup rather than Obsidian's `AbstractInputSuggest`: the editor already owns Enter,
 * Tab and the arrows, and the order in which two keyboard handlers see a key decides whether
 * Enter picks a suggestion or commits the cell. Here the editor asks this class first, always.
 */
export class CellSuggest {
	private readonly el: HTMLElement;
	private items: Suggestion[] = [];
	private index = 0;
	private tags: string[] | null = null;
	private files: TFile[] | null = null;
	private forced = false;

	constructor(
		private readonly parent: HTMLElement,
		private readonly input: HTMLTextAreaElement | HTMLInputElement,
		private readonly source: SuggestSource,
	) {
		this.el = parent.createDiv({ cls: "mds-suggest mds-hidden", attr: { role: "listbox" } });
		this.el.addEventListener("mousedown", (evt) => {
			// Keep focus in the editor; the click itself picks.
			evt.preventDefault();
			const item = asElement(evt.target)?.closest(".mds-suggest-item");
			if (!item || !item.instanceOf(HTMLElement)) return;
			this.index = Number.parseInt(item.dataset.index ?? "0", 10);
			this.pick();
		});
	}

	isOpen(): boolean {
		return !this.el.hasClass("mds-hidden");
	}

	destroy(): void {
		this.el.detach();
	}

	/** Alt+Down: every value of the column, whatever is typed. */
	openColumnList(): void {
		this.forced = true;
		this.update();
	}

	close(): void {
		this.forced = false;
		this.items = [];
		this.el.addClass("mds-hidden");
	}

	update(): void {
		const value = this.input.value;
		const caret = this.input.selectionStart ?? value.length;
		const before = value.slice(0, caret);
		this.items = this.linkItems(before, value, caret) ?? this.tagItems(before, caret) ?? this.columnItems(value);
		if (this.items.length === 0) {
			this.el.addClass("mds-hidden");
			return;
		}
		this.index = 0;
		this.render();
	}

	/**
	 * Gives the popup first claim on a key. `"commit"` means a column value was picked with Enter or
	 * Tab, which also finishes the cell — Excel's AutoComplete accepts and commits in one key.
	 */
	handleKey(evt: KeyboardEvent): false | "handled" | "commit" {
		if (!this.isOpen()) return false;
		if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
			const step = evt.key === "ArrowDown" ? 1 : -1;
			this.index = (this.index + step + this.items.length) % this.items.length;
			this.render();
			return "handled";
		}
		if ((evt.key === "Enter" || evt.key === "Tab") && !evt.ctrlKey && !evt.metaKey) {
			const commits = this.items[this.index]?.commits === true;
			this.pick();
			return commits ? "commit" : "handled";
		}
		if (evt.key === "Escape") {
			this.close();
			return "handled";
		}
		return false;
	}

	private pick(): void {
		const item = this.items[this.index];
		if (!item) return;
		const value = this.input.value;
		this.input.value = value.slice(0, item.from) + item.insert + value.slice(item.to);
		const caret = item.from + (item.caret ?? item.insert.length);
		this.input.setSelectionRange(caret, caret);
		this.close();
		this.input.dispatchEvent(new Event("input"));
	}

	private linkItems(before: string, value: string, caret: number): Suggestion[] | null {
		const m = LINK_CONTEXT.exec(before);
		if (!m) return null;
		const query = m[1];
		const from = caret - query.length - 2;
		// Swallow a closing `]]` that is already there, so picking never doubles it.
		const to = value.startsWith("]]", caret) ? caret + 2 : caret;
		this.files ??= this.source.app.vault.getFiles();
		const match = prepareFuzzySearch(query);
		const scored: Array<{ file: TFile; score: number }> = [];
		for (const file of this.files) {
			if (query === "") {
				scored.push({ file, score: file.stat.mtime });
				continue;
			}
			const hit = match(file.extension === "md" ? file.path.slice(0, -3) : file.path);
			if (hit) scored.push({ file, score: hit.score });
		}
		scored.sort((a, b) => b.score - a.score);
		const cache = this.source.app.metadataCache;
		return scored.slice(0, MAX_ITEMS).map(({ file }) => {
			const text = cache.fileToLinktext(file, this.source.sourcePath, true);
			return {
				label: file.extension === "md" ? file.basename : file.name,
				detail: file.parent && !file.parent.isRoot() ? file.parent.path : undefined,
				insert: `[[${text}]]`,
				from,
				to,
			};
		});
	}

	private tagItems(before: string, caret: number): Suggestion[] | null {
		const m = TAG_CONTEXT.exec(before);
		if (!m) return null;
		const query = m[2].toLowerCase();
		const from = caret - m[2].length - 1;
		this.tags ??= this.collectTags();
		return this.tags
			.filter((t) => t.slice(1).toLowerCase().includes(query))
			.slice(0, MAX_ITEMS)
			.map((tag) => ({ label: tag, insert: `${tag} `, from, to: caret }));
	}

	private columnItems(value: string): Suggestion[] {
		const typed = value.trim().toLowerCase();
		if (!this.forced && typed === "") return [];
		const values = this.source.columnValues();
		const hits = this.forced
			? values
			: values.filter((v) => v.toLowerCase().startsWith(typed) && v.toLowerCase() !== typed);
		return hits.slice(0, MAX_ITEMS).map((v) => ({ label: v, insert: v, from: 0, to: value.length, commits: true }));
	}

	private collectTags(): string[] {
		const counts = new Map<string, number>();
		const cache = this.source.app.metadataCache;
		for (const file of this.source.app.vault.getMarkdownFiles()) {
			const meta = cache.getFileCache(file);
			for (const tag of meta?.tags ?? []) counts.set(tag.tag, (counts.get(tag.tag) ?? 0) + 1);
			const fm: unknown = meta?.frontmatter?.tags;
			const list = Array.isArray(fm) ? fm : typeof fm === "string" ? fm.split(/[\s,]+/) : [];
			for (const t of list) {
				if (typeof t !== "string" || t === "") continue;
				const tag = t.startsWith("#") ? t : `#${t}`;
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([tag]) => tag);
	}

	private render(): void {
		this.el.empty();
		this.items.forEach((item, i) => {
			const row = this.el.createDiv({
				cls: "mds-suggest-item",
				attr: { "data-index": String(i), role: "option", "aria-selected": String(i === this.index) },
			});
			row.toggleClass("is-selected", i === this.index);
			row.createSpan({ cls: "mds-suggest-label", text: item.label });
			if (item.detail) row.createSpan({ cls: "mds-suggest-detail", text: item.detail });
		});
		this.el.removeClass("mds-hidden");
		const box = this.input.getBoundingClientRect();
		const parentBox = this.parent.getBoundingClientRect();
		this.el.setCssProps({
			"--mds-suggest-x": `${box.left - parentBox.left}px`,
			"--mds-suggest-y": `${box.bottom - parentBox.top + 2}px`,
		});
		const selected = this.el.children.item(this.index);
		if (selected !== null && selected.instanceOf(HTMLElement)) selected.scrollIntoView({ block: "nearest" });
	}
}
