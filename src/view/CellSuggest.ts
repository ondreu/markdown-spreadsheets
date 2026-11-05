import { prepareFuzzySearch, type App, type TFile } from "obsidian";
import { FORMULA_FUNCTIONS } from "../feature/formula";
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
	/** A function suggestion: the arguments as they read, and one line about it. */
	signature?: string;
	summary?: string;
}

export interface SuggestSource {
	app: App;
	sourcePath: string;
	/** Distinct values of the edited column, most frequent first. */
	columnValues(): string[];
	/**
	 * Whether an empty query lists every function. True in the cell editor, where the list is a way
	 * to browse; false in the formula bar, where it would cover the cells the person is about to
	 * point at — after `=SUM(` nothing has been typed, and the next click belongs to the grid.
	 */
	browseAll?: boolean;
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
	/** What a function list is filtering on, so the list can show which letters matched. */
	private typed = "";
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

	/** The note a `[[` suggestion links from; the view can be pointed at another one. */
	setSourcePath(path: string): void {
		this.source.sourcePath = path;
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
		this.items =
			this.formulaItems(before, caret) ??
			this.linkItems(before, value, caret) ??
			this.tagItems(before, caret) ??
			this.columnItems(value);
		if (this.items.length === 0) {
			// Empty the list as well as hiding it: leftover rows stay readable to a screen reader
			// and to anything counting items in the DOM.
			this.el.empty();
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

	/**
	 * Function names inside a formula. A formula is the one place where a bare word is a name, so
	 * this looks only there, only at the start of a word, and never inside a string literal —
	 * `="SUM"` is text, not a call.
	 *
	 * Picking one writes the name and its opening parenthesis and leaves the caret between them,
	 * so the next thing typed is the first argument.
	 */
	private formulaItems(before: string, caret: number): Suggestion[] | null {
		const trimmed = before.trimStart();
		if (!trimmed.startsWith("=") || trimmed.startsWith("==")) return null;
		// An odd number of quotes before the caret means the caret is inside a string.
		let quotes = 0;
		for (const ch of before) if (ch === '"') quotes++;
		if (quotes % 2 === 1) return null;
		const m = /(^|[^A-Za-z0-9_$])([A-Za-z]*)$/.exec(before);
		if (m === null) return null;
		const query = m[2];
		const from = caret - query.length;
		// With nothing typed, a name only makes sense where a value starts: after `=`, `(`, `,`
		// or an operator. After a digit or a reference it is an argument being completed, not a
		// function about to be named. Where browsing is off, an empty query lists nothing at all.
		if (query === "") {
			if (this.source.browseAll === false) return null;
			if (from > 0 && !/[=(,;+\-*/^&<>]/.test(before[from - 1])) return null;
		}
		const lower = query.toLowerCase();
		const starts = FORMULA_FUNCTIONS.filter((f) => f.name.toLowerCase().startsWith(lower));
		const inside =
			lower === ""
				? []
				: FORMULA_FUNCTIONS.filter((f) => !f.name.toLowerCase().startsWith(lower) && f.name.toLowerCase().includes(lower));
		const hits = [...starts, ...inside].slice(0, 12);
		if (hits.length === 0) return null;
		this.typed = query;
		return hits.map((f) => {
			const insert = f.signature === "" ? `${f.name}()` : `${f.name}(`;
			return {
				label: f.name,
				insert,
				from,
				to: caret,
				caret: insert.length - (f.signature === "" ? 1 : 0),
				signature: f.signature,
				summary: f.summary,
			};
		});
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
		this.typed = "";
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
			if (item.signature !== undefined) {
				row.addClass("is-function");
				const head = row.createDiv({ cls: "mds-suggest-head" });
				const typedLength = item.label.toLowerCase().startsWith(this.typed.toLowerCase()) ? this.typed.length : 0;
				// One run of text, not two elements: the name has to read and measure as one word.
				const name = head.createSpan({ cls: "mds-suggest-name" });
				if (typedLength > 0) name.createSpan({ cls: "is-match", text: item.label.slice(0, typedLength) });
				name.appendText(item.label.slice(typedLength));
				if (item.signature !== "") head.createSpan({ cls: "mds-suggest-signature", text: `(${item.signature})` });
				else head.createSpan({ cls: "mds-suggest-signature", text: "()" });
				row.createDiv({ cls: "mds-suggest-summary", text: item.summary ?? "" });
				return;
			}
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
