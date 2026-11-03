// Minimal stand-in for the parts of the Obsidian API GridHost touches, for a headless browser.
type Info = { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null>; type?: string } | string;

function apply(el: HTMLElement, o?: Info): void {
	if (o === undefined) return;
	if (typeof o === "string") { el.className = o; return; }
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null) el.setAttribute(k, String(v));
	if (o.type) el.setAttribute("type", o.type);
}
const P = HTMLElement.prototype as any;
const E = Element.prototype as any;
const N = Node.prototype as any;
P.createEl = function (tag: string, o?: Info) { const el = document.createElement(tag); apply(el, o); this.appendChild(el); return el; };
P.createDiv = function (o?: Info) { return this.createEl("div", o); };
P.createSpan = function (o?: Info) { return this.createEl("span", o); };
DocumentFragment.prototype.append; 
(window as any).createEl = (tag: string, o?: Info) => { const el = document.createElement(tag); apply(el, o); return el; };
(window as any).createDiv = (o?: Info) => (window as any).createEl("div", o);
(window as any).createSpan = (o?: Info) => (window as any).createEl("span", o);
(window as any).createFragment = () => document.createDocumentFragment();
Object.defineProperty(Document.prototype, "win", { get() { return this.defaultView; } });
N.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
N.detach = function () { this.parentNode?.removeChild(this); };
N.instanceOf = function (type: any) { return this instanceof type; };
E.addClass = function (...c: string[]) { this.classList.add(...c); };
E.addClasses = function (c: string[]) { this.classList.add(...c); };
E.removeClass = function (...c: string[]) { this.classList.remove(...c); };
E.removeClasses = function (c: string[]) { this.classList.remove(...c); };
E.toggleClass = function (c: string, v: boolean) { this.classList.toggle(c, v); };
E.hasClass = function (c: string) { return this.classList.contains(c); };
E.setText = function (t: string) { this.textContent = t; };
E.getText = function () { return this.textContent ?? ""; };
E.find = function (s: string) { return this.querySelector(s); };
E.findAll = function (s: string) { return Array.from(this.querySelectorAll(s)); };
P.setCssProps = function (props: Record<string, string>) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); };
P.setCssStyles = function (props: Record<string, string>) { Object.assign(this.style, props); };

export class Component { load() {} unload() {} addChild<T>(c: T) { return c; } register() {} }
export class Menu {
	items: Array<{ title: string; disabled: boolean; cb: () => void }> = [];
	addItem(fn: (i: any) => void) {
		const item: any = { title: "", disabled: false, cb: () => {} };
		const api = { setTitle(t: string) { item.title = t; return api; }, setIcon() { return api; }, setDisabled(d: boolean) { item.disabled = d; return api; }, onClick(cb: () => void) { item.cb = cb; return api; } };
		fn(api); this.items.push(item); return this;
	}
	addSeparator() { return this; }
	showAtMouseEvent() { (window as any).lastMenu = this; }
}
export const MarkdownRenderer = {
	async render(_app: unknown, md: string, el: HTMLElement) {
		// Tiny renderer: emphasis, code, links — enough to see rendered mode work.
		let html = md.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		html = html.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>")
			.replace(/(^|\W)_([^_]+)_(?!\w)/g, "$1<em>$2</em>")
			.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => `<a class="internal-link" data-href="${t}" href="${t}">${a ?? t}</a>`);
		html = html.replace(/%%[\s\S]*?%%/g, "");
		await new Promise((r) => setTimeout(r, 5));
		el.innerHTML = `<p>${html}</p>`;
	},
};
const LUCIDE = (window as any).LUCIDE as Record<string, string> | undefined;
export function getIcon(name: string): SVGSVGElement | null {
	if (!LUCIDE) return name.length > 0 ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : null;
	const svg = LUCIDE[name];
	if (!svg) return null;
	const holder = document.createElement("div");
	holder.innerHTML = svg;
	const el = holder.firstElementChild as SVGSVGElement;
	el.classList.add("svg-icon");
	return el;
}
export function setIcon(el: HTMLElement, name: string) { el.textContent = ""; el.setAttribute("data-icon", name); const svg = getIcon(name); if (svg && LUCIDE) el.appendChild(svg); }
export function setTooltip(el: HTMLElement, t: string) { el.setAttribute("aria-label", t); }
export type App = unknown;

export const moment = () => ({ format: (f: string) => (f.includes("H") ? "14:30" : "2026-11-03") });
export function prepareFuzzySearch(q: string) {
	const ql = q.toLowerCase();
	return (t: string) => (t.toLowerCase().includes(ql) ? { score: -t.length, matches: [] } : null);
}
export function normalizePath(p: string) { return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }
export class TFile { path = ""; name = ""; basename = ""; extension = "md"; parent: any = null; stat = { mtime: 0 }; }
export class Notice { constructor(m: string) { (window as any).notices = [...((window as any).notices ?? []), m]; } }
export class Scope { register() { return {}; } constructor(_p?: unknown) {} }
export class ItemView extends Component {
	app: any; leaf: any; containerEl: HTMLElement; contentEl: HTMLElement; scope: any = null; navigation = false;
	constructor(leaf: any) { super(); this.leaf = leaf; this.app = leaf.app; this.containerEl = document.getElementById("view")!; this.contentEl = this.containerEl.createDiv({ cls: "view-content" }); }
	registerEvent() {}
	registerDomEvent(el: HTMLElement, type: string, cb: any) { el.addEventListener(type, cb); }
	async setState() {}
}
export class Modal { app: any; contentEl = document.createElement("div"); titleEl = document.createElement("div"); modalEl = document.createElement("div"); constructor(app: any) { this.app = app; } open() {} close() {} }
export class FuzzySuggestModal<T> extends Modal { setPlaceholder() {} }
export class Setting { constructor(_el: HTMLElement) {} setName() { return this; } setDesc() { return this; } setHeading() { return this; } addButton() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addSlider() { return this; } }
export class PluginSettingTab {}
export class Plugin {}
export class MarkdownView {}
export const editorInfoField = {};
