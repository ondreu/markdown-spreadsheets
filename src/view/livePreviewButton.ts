import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { editorInfoField, setTooltip, type TFile } from "obsidian";
import { asElement } from "./dom";
import { setIconSafe } from "./icons";

export interface LivePreviewButtonHost {
	enabled(): boolean;
	/** Opens the table whose first line is `line` (0-based) in `text`. */
	open(file: TFile, text: string, line: number): void;
}

/** Obsidian's Live Preview table widget. */
const TABLE_WIDGET = ".cm-embed-block.cm-table-widget";
const BUTTON_CLASS = "mds-lp-table-btn";

/**
 * The edit button on tables in Live Preview.
 *
 * Live Preview does not run Markdown post processors on tables — Obsidian draws them with its own
 * editable widget — so the reading-view button never appeared there, which is where people
 * actually edit. This plugin adds the button to that widget's DOM.
 *
 * It is added on the first hover rather than on every editor update: the widget is redrawn on
 * its own schedule, and hover is the only moment the button is visible anyway. CodeMirror ignores
 * DOM changes inside a widget, and the note's text is never touched. The source line comes from
 * `posAtDOM` on the widget, so the button opens exactly the table it sits on.
 */
export function livePreviewTableButton(host: LivePreviewButtonHost): Extension {
	return ViewPlugin.fromClass(
		class {
			private readonly onOver = (evt: MouseEvent) => this.decorate(evt);

			constructor(private readonly view: EditorView) {
				view.dom.addEventListener("mouseover", this.onOver);
			}

			destroy(): void {
				this.view.dom.removeEventListener("mouseover", this.onOver);
				for (const el of this.view.dom.findAll(`.${BUTTON_CLASS}`)) el.detach();
			}

			private decorate(evt: MouseEvent): void {
				const target = asElement(evt.target);
				const widget = target?.closest(TABLE_WIDGET) ?? null;
				if (widget === null || !widget.instanceOf(HTMLElement)) return;
				const existing = widget.find(`:scope > .${BUTTON_CLASS}`);
				if (!host.enabled()) {
					existing?.detach();
					return;
				}
				if (existing) return;
				const btn = widget.createEl("button", { cls: BUTTON_CLASS, attr: { type: "button" } });
				setIconSafe(btn, "launcher");
				setTooltip(btn, "Open this table as a spreadsheet");
				btn.setAttribute("aria-label", "Open this table as a spreadsheet");
				// The widget edits its cells on press; none of that may start from the button.
				const swallow = (e: Event) => {
					e.preventDefault();
					e.stopPropagation();
				};
				btn.addEventListener("pointerdown", swallow);
				btn.addEventListener("mousedown", swallow);
				btn.addEventListener("click", (e) => {
					swallow(e);
					this.open(widget);
				});
			}

			private open(widget: HTMLElement): void {
				const file = this.view.state.field(editorInfoField, false)?.file;
				if (!file) return;
				const pos = this.view.posAtDOM(widget);
				const doc = this.view.state.doc;
				const line = doc.lineAt(Math.min(pos, doc.length)).number - 1;
				host.open(file, doc.toString(), line);
			}
		},
	);
}
