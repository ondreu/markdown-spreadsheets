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
	/** Draws attention to the one action the current state calls for, such as an unsaved grid. */
	primary?: boolean;
	onClick(): void;
}

export interface RibbonGroup {
	label: string;
	items: RibbonItem[];
}

export type RibbonItem =
	| { kind: "button"; action: RibbonAction }
	/**
	 * A run of related actions as one segmented control of icons — alignment, emphasis, freeze.
	 * Each label lives in the tooltip, which is what keeps the ribbon readable at a glance rather
	 * than a wall of text buttons.
	 */
	| { kind: "cluster"; id: string; actions: RibbonAction[] }
	| { kind: "number"; id: string; label: string; value: number; min: number; max: number; tooltip?: string; onCommit(value: number): void }
	| { kind: "separator" };

export interface RibbonTab {
	id: string;
	label: string;
	icon?: string;
	groups: RibbonGroup[];
}

export interface RibbonOptions {
	onTabChange?(id: string): void;
	/** Persisted by the caller, so a collapsed toolbar stays collapsed across sessions. */
	onCollapseChange?(collapsed: boolean): void;
	collapsed?: boolean;
}

/**
 * The tab strip of §11.
 *
 * Structurally Excel — Home / Data / Table / Export, grouped into labelled sections — but the
 * chrome is Obsidian's: a segmented tab control, group names above their actions, dense actions
 * folded into icon clusters, and the whole panel collapsible. Every string is sentence case,
 * because `ui/sentence-case` (§15.2) is not negotiable and Title Case would fail review. Colours
 * and sizes come from Obsidian's CSS variables only; hardcoded ones break in half the themes.
 */
export class Ribbon {
	private containerEl!: HTMLElement;
	private barEl!: HTMLElement;
	private tabStripEl!: HTMLElement;
	private panelEl!: HTMLElement;
	private collapseButtonEl!: HTMLElement;
	private activeTab = "home";
	private tabs: RibbonTab[] = [];
	private collapsed: boolean;

	constructor(private readonly opts: RibbonOptions = {}) {
		this.collapsed = opts.collapsed === true;
	}

	mount(parent: HTMLElement): void {
		this.containerEl = parent.createDiv({ cls: "mds-ribbon" });
		this.barEl = this.containerEl.createDiv({ cls: "mds-ribbon-bar" });
		this.tabStripEl = this.barEl.createDiv({ cls: "mds-ribbon-tabs" });

		this.collapseButtonEl = this.barEl.createEl("button", {
			cls: "mds-ribbon-collapse",
			attr: { type: "button" },
		});
		this.collapseButtonEl.addEventListener("click", () => this.setCollapsed(!this.collapsed));

		this.panelEl = this.containerEl.createDiv({ cls: "mds-ribbon-panel" });
		this.applyCollapsed();
	}

	setTabs(tabs: RibbonTab[]): void {
		this.tabs = tabs;
		if (!tabs.some((t) => t.id === this.activeTab)) this.activeTab = tabs[0]?.id ?? "home";
		this.render();
	}

	getActiveTab(): string {
		return this.activeTab;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	private setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		this.applyCollapsed();
		this.opts.onCollapseChange?.(collapsed);
	}

	private applyCollapsed(): void {
		this.containerEl.toggleClass("is-collapsed", this.collapsed);
		this.panelEl.toggleClass("mds-hidden", this.collapsed);
		setIcon(this.collapseButtonEl, this.collapsed ? "chevron-down" : "chevron-up");
		setTooltip(this.collapseButtonEl, this.collapsed ? "Show the toolbar" : "Hide the toolbar");
	}

	private render(): void {
		this.tabStripEl.empty();
		for (const tab of this.tabs) {
			const el = this.tabStripEl.createEl("button", { cls: "mds-ribbon-tab", attr: { type: "button" } });
			if (tab.icon) setIcon(el.createSpan({ cls: "mds-ribbon-tab-icon" }), tab.icon);
			el.createSpan({ cls: "mds-ribbon-tab-label", text: tab.label });
			el.toggleClass("is-active", tab.id === this.activeTab);
			el.addEventListener("click", () => {
				// Clicking the active tab while collapsed is the natural way to get the panel back.
				if (tab.id === this.activeTab && this.collapsed) {
					this.setCollapsed(false);
					return;
				}
				this.activeTab = tab.id;
				this.render();
				this.opts.onTabChange?.(tab.id);
			});
		}
		this.renderPanel();
	}

	private renderPanel(): void {
		this.panelEl.empty();
		const tab = this.tabs.find((t) => t.id === this.activeTab);
		if (!tab) return;
		for (const group of tab.groups) {
			const groupEl = this.panelEl.createDiv({ cls: "mds-ribbon-group" });
			groupEl.createDiv({ cls: "mds-ribbon-group-label", text: group.label });
			const itemsEl = groupEl.createDiv({ cls: "mds-ribbon-items" });
			for (const item of group.items) this.renderItem(itemsEl, item);
		}
	}

	private renderItem(parent: HTMLElement, item: RibbonItem): void {
		if (item.kind === "separator") {
			parent.createDiv({ cls: "mds-ribbon-sep" });
			return;
		}
		if (item.kind === "cluster") {
			const wrap = parent.createDiv({ cls: "mds-ribbon-cluster" });
			for (const action of item.actions) this.renderButton(wrap, action, true);
			return;
		}
		if (item.kind === "number") {
			const wrap = parent.createDiv({ cls: "mds-ribbon-number" });
			wrap.createSpan({ cls: "mds-ribbon-number-label", text: item.label });
			const input = wrap.createEl("input", {
				cls: "mds-ribbon-number-input",
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
		this.renderButton(parent, item.action, false);
	}

	private renderButton(parent: HTMLElement, action: RibbonAction, iconOnly: boolean): void {
		const btn = parent.createEl("button", { cls: "mds-ribbon-btn", attr: { type: "button" } });
		if (action.icon) setIcon(btn.createSpan({ cls: "mds-ribbon-btn-icon" }), action.icon);
		if (iconOnly && action.icon !== undefined) {
			btn.addClass("is-icon-only");
			// The name has to stay reachable when it is not on screen.
			btn.setAttribute("aria-label", action.label);
		} else {
			btn.createSpan({ cls: "mds-ribbon-btn-label", text: action.label });
		}
		btn.toggleClass("is-active", action.active === true);
		btn.toggleClass("mod-cta", action.primary === true);
		if (action.disabled) {
			btn.setAttribute("disabled", "true");
			btn.addClass("is-disabled");
		}
		setTooltip(btn, action.tooltip === undefined ? action.label : `${action.label} — ${action.tooltip}`);
		btn.addEventListener("click", () => {
			if (action.disabled) return;
			action.onClick();
		});
	}
}
