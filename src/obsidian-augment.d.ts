/**
 * Obsidian attaches its DOM helpers to every window it owns, including popped-out ones, but
 * only declares them as ambient globals. Going through `someEl.ownerDocument.win` is what
 * `prefer-create-el` asks for and what actually works across windows, so the per-window form
 * needs a declaration.
 */
import "obsidian";

declare global {
	interface Window {
		createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
		createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
		createEl<K extends keyof HTMLElementTagNameMap>(
			tag: K,
			o?: DomElementInfo | string,
			callback?: (el: HTMLElementTagNameMap[K]) => void,
		): HTMLElementTagNameMap[K];
		createFragment(callback?: (el: DocumentFragment) => void): DocumentFragment;
	}
}
