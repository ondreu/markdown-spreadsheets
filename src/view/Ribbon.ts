import { setTooltip } from "obsidian";
import { setIconSafe, type IconKey } from "./icons";

export interface RibbonAction {
	id: string;
	label: string;
	icon?: IconKey;
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
	icon?: IconKey;
	groups: RibbonGroup[];
}

export interface RibbonOptions {
	onTabChange?(id: string): void;
	/** Persisted by the caller, so a collapsed toolbar stays collapsed across sessions. */
	onCollapseChange?(collapsed: boolean): void;
	collapsed?: boolean;
	/** Every button as an icon with its label in the tooltip — the compact toolbar. */
	iconsOnly?: boolean;
	/** The touch layout (decision 24). */
	touch?: boolean;
}

interface ButtonRef {
	el: HTMLButtonElement;
	labelEl: HTMLElement | null;
	tooltip: string;
}

/**
 * The tab strip of §11.
 *
 * Structurally Excel — Home / Data / Table / Export, grouped into labelled sections — but the
 * chrome is Obsidian's: a segmented tab control, group names above their actions, dense actions
 * folded into icon clusters, and the whole panel collapsible. Every string is sentence case,
 * because `ui/sentence-case` (§15.2) is not negotiable and Title Case would fail review. Colours
 * and sizes come from Obsidian's CSS variables only; hardcoded ones break in half the themes.
 *
 * The view hands over a fresh description on every selection change. Rebuilding forty buttons
 * and their SVGs for each arrow key was visible as lag and threw away hover and focus, so a
 * description with the same structure only patches state — disabled, pressed, tooltip, value.
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
	private signature = "";
	private readonly buttons = new Map<string, ButtonRef>();
	private readonly numbers = new Map<string, HTMLInputElement>();
	/** The latest description of every action, so click handlers never run a stale closure. */
	private readonly actions = new Map<string, RibbonAction>();
	private readonly numberItems = new Map<string, Extract<RibbonItem, { kind: "number" }>>();

	constructor(private readonly opts: RibbonOptions = {}) {
		this.collapsed = opts.collapsed === true;
	}

	mount(parent: HTMLElement): void {
		this.containerEl = parent.createDiv({ cls: "mds-ribbon" });
		this.containerEl.toggleClass("is-icons-only", this.opts.iconsOnly === true);
		this.barEl = this.containerEl.createDiv({ cls: "mds-ribbon-bar" });
		this.tabStripEl = this.barEl.createDiv({ cls: "mds-ribbon-tabs", attr: { role: "tablist" } });

		this.collapseButtonEl = this.barEl.createEl("button", {
			cls: "mds-ribbon-collapse",
			attr: { type: "button" },
		});
		this.keepFocus(this.collapseButtonEl);
		this.collapseButtonEl.addEventListener("click", () => this.setCollapsed(!this.collapsed));

		this.panelEl = this.containerEl.createDiv({ cls: "mds-ribbon-panel" });
		this.applyCollapsed();
	}

	setTabs(tabs: RibbonTab[]): void {
		this.tabs = tabs;
		if (!tabs.some((t) => t.id === this.activeTab)) this.activeTab = tabs[0]?.id ?? "home";
		const signature = this.signatureOf();
		if (signature === this.signature) {
			this.patch();
			return;
		}
		this.signature = signature;
		this.render();
	}

	getActiveTab(): string {
		return this.activeTab;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	/**
	 * A mouse click on a toolbar button must not take focus away from the grid: the next keystroke
	 * should still type into the selected cell. Keyboard users can still tab to every button.
	 */
	private keepFocus(el: HTMLElement): void {
		el.addEventListener("mousedown", (evt) => evt.preventDefault());
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
		setIconSafe(this.collapseButtonEl, this.collapsed ? "expand" : "collapse");
		setTooltip(this.collapseButtonEl, this.collapsed ? "Show the toolbar" : "Hide the toolbar");
	}

	/** Everything that changes the DOM structure; state that only restyles is left out. */
	private signatureOf(): string {
		const tab = this.tabs.find((t) => t.id === this.activeTab);
		const parts: string[] = [this.activeTab, this.tabs.map((t) => `${t.id}:${t.label}`).join(",")];
		for (const group of tab?.groups ?? []) {
			parts.push(`[${group.label}]`);
			for (const item of group.items) {
				if (item.kind === "separator") parts.push("|");
				else if (item.kind === "number") parts.push(`n:${item.id}`);
				else if (item.kind === "button") parts.push(`b:${item.action.id}:${item.action.label}:${item.action.icon ?? ""}`);
				else parts.push(`c:${item.id}:${item.actions.map((a) => `${a.id}:${a.icon ?? ""}`).join(",")}`);
			}
		}
		return parts.join(";");
	}

	private render(): void {
		this.tabStripEl.empty();
		for (const tab of this.tabs) {
			const el = this.tabStripEl.createEl("button", {
				cls: "mds-ribbon-tab",
				attr: { type: "button", role: "tab", "aria-selected": String(tab.id === this.activeTab) },
			});
			this.keepFocus(el);
			// A narrow touch screen hides the label of every tab but the open one; the name must not
			// go with it. Only there: Obsidian shows an `aria-label` as a hover tooltip on desktop.
			if (this.opts.touch) el.setAttribute("aria-label", tab.label);
			if (tab.icon) setIconSafe(el.createSpan({ cls: "mds-ribbon-tab-icon" }), tab.icon);
			el.createSpan({ cls: "mds-ribbon-tab-label", text: tab.label });
			el.toggleClass("is-active", tab.id === this.activeTab);
			el.addEventListener("click", () => {
				// Clicking any tab while collapsed is the natural way to get the panel back.
				if (this.collapsed) this.setCollapsed(false);
				if (tab.id === this.activeTab) return;
				this.activeTab = tab.id;
				this.signature = this.signatureOf();
				this.render();
				this.opts.onTabChange?.(tab.id);
			});
		}
		this.renderPanel();
	}

	private renderPanel(): void {
		this.panelEl.empty();
		this.buttons.clear();
		this.numbers.clear();
		this.actions.clear();
		this.numberItems.clear();
		const tab = this.tabs.find((t) => t.id === this.activeTab);
		if (!tab) return;
		for (const group of tab.groups) {
			// Label under its actions, the way Office groups read: the eye lands on the buttons first.
			const groupEl = this.panelEl.createDiv({ cls: "mds-ribbon-group" });
			const itemsEl = groupEl.createDiv({ cls: "mds-ribbon-items" });
			for (const item of group.items) this.renderItem(itemsEl, item);
			groupEl.createDiv({ cls: "mds-ribbon-group-label", text: group.label });
		}
	}

	private renderItem(parent: HTMLElement, item: RibbonItem): void {
		if (item.kind === "separator") {
			parent.createDiv({ cls: "mds-ribbon-sep" });
			return;
		}
		if (item.kind === "cluster") {
			const wrap = parent.createDiv({ cls: "mds-ribbon-cluster", attr: { role: "group" } });
			for (const action of item.actions) this.renderButton(wrap, action, true);
			return;
		}
		if (item.kind === "number") {
			this.numberItems.set(item.id, item);
			const wrap = parent.createEl("label", { cls: "mds-ribbon-number" });
			wrap.createSpan({ cls: "mds-ribbon-number-label", text: item.label });
			const input = wrap.createEl("input", {
				cls: "mds-ribbon-number-input",
				attr: { type: "number", min: String(item.min), max: String(item.max), value: String(Math.round(item.value)) },
			});
			if (item.tooltip) setTooltip(input, item.tooltip);
			let committed = input.value;
			// The description as it was when editing began: its `onCommit` targets the selection the
			// number was typed for, even if a refresh replaced it before the field commits.
			let editing: Extract<RibbonItem, { kind: "number" }> | null = null;
			const commit = () => {
				if (input.value === committed) return;
				const current = editing ?? this.numberItems.get(item.id) ?? item;
				const n = Number.parseInt(input.value, 10);
				if (!Number.isFinite(n)) return;
				committed = input.value;
				current.onCommit(Math.max(current.min, Math.min(current.max, n)));
			};
			input.addEventListener("change", commit);
			input.addEventListener("keydown", (evt) => {
				evt.stopPropagation();
				if (evt.key === "Enter") commit();
			});
			input.addEventListener("focus", () => {
				committed = input.value;
				editing = this.numberItems.get(item.id) ?? item;
			});
			input.addEventListener("blur", () => (editing = null));
			this.numbers.set(item.id, input);
			return;
		}
		this.renderButton(parent, item.action, this.opts.iconsOnly === true);
	}

	private renderButton(parent: HTMLElement, action: RibbonAction, iconOnly: boolean): void {
		const btn = parent.createEl("button", { cls: "mds-ribbon-btn", attr: { type: "button" } });
		this.keepFocus(btn);
		if (action.icon) setIconSafe(btn.createSpan({ cls: "mds-ribbon-btn-icon" }), action.icon);
		let labelEl: HTMLElement | null = null;
		if (iconOnly && action.icon !== undefined) {
			btn.addClass("is-icon-only");
		} else {
			labelEl = btn.createSpan({ cls: "mds-ribbon-btn-label", text: action.label });
		}
		btn.addEventListener("click", () => {
			const current = this.actions.get(action.id);
			if (!current || current.disabled) return;
			current.onClick();
		});
		const ref: ButtonRef = { el: btn, labelEl, tooltip: "" };
		this.buttons.set(action.id, ref);
		this.actions.set(action.id, action);
		this.applyState(ref, action, iconOnly);
	}

	private applyState(ref: ButtonRef, action: RibbonAction, iconOnly: boolean): void {
		const btn = ref.el;
		btn.toggleClass("is-active", action.active === true);
		btn.toggleClass("mod-cta", action.primary === true);
		btn.toggleClass("is-disabled", action.disabled === true);
		// `aria-disabled` rather than `disabled`: a disabled button gets no pointer events, so the
		// tooltip that explains *why* it is unavailable (D5) would never show.
		btn.setAttribute("aria-disabled", String(action.disabled === true));
		btn.setAttribute("aria-pressed", String(action.active === true));
		if (iconOnly) btn.setAttribute("aria-label", action.label);
		const tooltip = action.tooltip === undefined ? action.label : `${action.label} — ${action.tooltip}`;
		if (tooltip !== ref.tooltip) {
			setTooltip(btn, tooltip);
			ref.tooltip = tooltip;
		}
	}

	/** Same structure as last time: restyle what is there instead of rebuilding it. */
	private patch(): void {
		const tab = this.tabs.find((t) => t.id === this.activeTab);
		if (!tab) return;
		for (const group of tab.groups) {
			for (const item of group.items) {
				if (item.kind === "button") this.patchAction(item.action, this.opts.iconsOnly === true);
				else if (item.kind === "cluster") for (const action of item.actions) this.patchAction(action, true);
				else if (item.kind === "number") {
					this.numberItems.set(item.id, item);
					const input = this.numbers.get(item.id);
					// Never overwrite what someone is typing.
					if (input && input.ownerDocument.activeElement !== input) input.value = String(Math.round(item.value));
				}
			}
		}
	}

	private patchAction(action: RibbonAction, iconOnly: boolean): void {
		const ref = this.buttons.get(action.id);
		this.actions.set(action.id, action);
		if (!ref) return;
		if (ref.labelEl && ref.labelEl.getText() !== action.label) ref.labelEl.setText(action.label);
		this.applyState(ref, action, iconOnly && action.icon !== undefined);
	}
}
