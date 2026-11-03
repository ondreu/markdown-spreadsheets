import { setIconSafe, type IconKey } from "./icons";

export interface TouchAction {
	id: string;
	/** Short: it sits under the icon on a button a finger wide. */
	label: string;
	icon: IconKey;
	disabled?: boolean;
	active?: boolean;
	onClick(): void;
}

interface ButtonRef {
	el: HTMLButtonElement;
	iconEl: HTMLElement;
	labelEl: HTMLElement;
	icon: IconKey;
}

/**
 * The action bar of the touch layout (decision 24), under the grid where a thumb reaches it.
 *
 * It carries what a mouse and keyboard did without a toolbar — edit, extend the selection, undo,
 * the clipboard, the context menu — as buttons big enough to hit. Icons have their name written
 * under them, because a touch screen shows no tooltips. The set of buttons is fixed; a refresh
 * only patches their state, so a tap is never lost to a rebuild under the finger.
 */
export class TouchBar {
	private el!: HTMLElement;
	private readonly buttons = new Map<string, ButtonRef>();
	private readonly actions = new Map<string, TouchAction>();

	mount(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: "mds-touchbar", attr: { role: "toolbar", "aria-label": "Grid actions" } });
	}

	update(actions: TouchAction[]): void {
		const structure = actions.map((a) => a.id).join(",");
		if (structure !== Array.from(this.buttons.keys()).join(",")) this.render(actions);
		for (const action of actions) this.patch(action);
	}

	private render(actions: TouchAction[]): void {
		this.el.empty();
		this.buttons.clear();
		for (const action of actions) {
			const btn = this.el.createEl("button", { cls: "mds-touchbar-btn", attr: { type: "button" } });
			// A tap on the bar must not take focus from the cell editor or the grid: the editor would
			// commit on blur before the button decides what to do with it.
			btn.addEventListener("pointerdown", (evt) => evt.preventDefault());
			btn.addEventListener("mousedown", (evt) => evt.preventDefault());
			btn.addEventListener("click", () => {
				const current = this.actions.get(action.id);
				if (current && !current.disabled) current.onClick();
			});
			const iconEl = btn.createSpan({ cls: "mds-touchbar-icon" });
			setIconSafe(iconEl, action.icon);
			const labelEl = btn.createSpan({ cls: "mds-touchbar-label", text: action.label });
			this.buttons.set(action.id, { el: btn, iconEl, labelEl, icon: action.icon });
		}
	}

	private patch(action: TouchAction): void {
		this.actions.set(action.id, action);
		const ref = this.buttons.get(action.id);
		if (!ref) return;
		if (ref.icon !== action.icon) {
			setIconSafe(ref.iconEl, action.icon);
			ref.icon = action.icon;
		}
		if (ref.labelEl.getText() !== action.label) ref.labelEl.setText(action.label);
		ref.el.setAttribute("aria-label", action.label);
		ref.el.toggleClass("is-active", action.active === true);
		ref.el.toggleClass("is-disabled", action.disabled === true);
		ref.el.setAttribute("aria-disabled", String(action.disabled === true));
		ref.el.setAttribute("aria-pressed", String(action.active === true));
	}
}
