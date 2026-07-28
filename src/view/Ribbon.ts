import { setIcon, setTooltip } from "obsidian";

export interface RibbonAction {
	id: string;
	label: string;
	icon?: string;
	tooltip?: string;
	/** Rendered greyed out with the tooltip explaining why — D5 forbids silent no-ops. */
	disabled?: boolean;
	/** Renders as a pressed toggle. */
	active?: boolean;
	onClick(): void;
}

export interface RibbonGroup {
	label: string;
	items: RibbonItem[];
}

export type RibbonItem =
	| { kind: "button"; action: RibbonAction }
	| { kind: "number"; id: string; label: string; value: number; min: number; max: number; tooltip?: string; onCommit(value: number): void }
	| { kind: "separator" };

export interface RibbonTab {
	id: string;
	label: string;
	groups: RibbonGroup[];
}

/**
 * The tab strip of §11.
 *
 * Structurally Excel — Home / Data / Table / Export, grouped into labelled sections — but every
 * string is sentence case, because `ui/sentence-case` (§15.2) is not negotiable and Title Case
 * would fail review. Colours and sizes come from Obsidian's CSS variables only; hardcoded ones
 * break in half the themes.
 */
export class Ribbon {
	private containerEl!: HTMLElement;
	private tabStripEl!: HTMLElement;
	private panelEl!: HTMLElement;
	private activeTab = "home";
	private tabs: RibbonTab[] = [];

	constructor(private readonly onTabChange?: (id: string) => void) {}

	mount(parent: HTMLElement): void {
		this.containerEl = parent.createDiv({ cls: "mg-ribbon" });
		this.tabStripEl = this.containerEl.createDiv({ cls: "mg-ribbon-tabs" });
		this.panelEl = this.containerEl.createDiv({ cls: "mg-ribbon-panel" });
	}

	setTabs(tabs: RibbonTab[]): void {
		this.tabs = tabs;
		if (!tabs.some((t) => t.id === this.activeTab)) this.activeTab = tabs[0]?.id ?? "home";
		this.render();
	}

	getActiveTab(): string {
		return this.activeTab;
	}

	private render(): void {
		this.tabStripEl.empty();
		for (const tab of this.tabs) {
			const el = this.tabStripEl.createEl("button", {
				cls: "mg-ribbon-tab",
				text: tab.label,
				attr: { type: "button" },
			});
			el.toggleClass("is-active", tab.id === this.activeTab);
			el.addEventListener("click", () => {
				this.activeTab = tab.id;
				this.render();
				this.onTabChange?.(tab.id);
			});
		}
		this.renderPanel();
	}

	private renderPanel(): void {
		this.panelEl.empty();
		const tab = this.tabs.find((t) => t.id === this.activeTab);
		if (!tab) return;
		for (const group of tab.groups) {
			const groupEl = this.panelEl.createDiv({ cls: "mg-ribbon-group" });
			const itemsEl = groupEl.createDiv({ cls: "mg-ribbon-items" });
			for (const item of group.items) this.renderItem(itemsEl, item);
			groupEl.createDiv({ cls: "mg-ribbon-group-label", text: group.label });
		}
	}

	private renderItem(parent: HTMLElement, item: RibbonItem): void {
		if (item.kind === "separator") {
			parent.createDiv({ cls: "mg-ribbon-sep" });
			return;
		}
		if (item.kind === "number") {
			const wrap = parent.createDiv({ cls: "mg-ribbon-number" });
			wrap.createSpan({ cls: "mg-ribbon-number-label", text: item.label });
			const input = wrap.createEl("input", {
				cls: "mg-ribbon-number-input",
				attr: { type: "number", min: String(item.min), max: String(item.max), value: String(Math.round(item.value)) },
			});
			if (item.tooltip) setTooltip(input, item.tooltip);
			const commit = () => {
				const n = Number.parseInt(input.value, 10);
				if (Number.isFinite(n)) item.onCommit(Math.max(item.min, Math.min(item.max, n)));
			};
			input.addEventListener("change", commit);
			input.addEventListener("keydown", (evt) => {
				evt.stopPropagation();
				if (evt.key === "Enter") commit();
			});
			return;
		}

		const action = item.action;
		const btn = parent.createEl("button", { cls: "mg-ribbon-btn", attr: { type: "button" } });
		if (action.icon) setIcon(btn.createSpan({ cls: "mg-ribbon-btn-icon" }), action.icon);
		btn.createSpan({ cls: "mg-ribbon-btn-label", text: action.label });
		btn.toggleClass("is-active", action.active === true);
		if (action.disabled) {
			btn.setAttribute("disabled", "true");
			btn.addClass("is-disabled");
		}
		if (action.tooltip) setTooltip(btn, action.tooltip);
		btn.addEventListener("click", () => {
			if (action.disabled) return;
			action.onClick();
		});
	}
}
