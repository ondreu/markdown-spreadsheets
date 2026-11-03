import { setIcon, setTooltip } from "obsidian";

export interface StatusBarModel {
	/** `A1` or `A1:C4`. */
	address: string;
	/** `Sum · Avg · Count` of the selection, empty when there is nothing numeric. */
	aggregate: string;
	/** The same figures as separate, clickable values — the ones chosen in the settings. */
	stats?: Array<{ label: string; value: string }>;
	usedRange: string;
	dirty: boolean;
	saveMode: "auto" | "manual";
	/** Extra note, e.g. an active filter or a fallback geometry mode. */
	hint?: string;
}

/**
 * Footer of the grid tab: address, selection aggregate, used range and save state.
 *
 * Lives inside the view rather than only in Obsidian's status bar, so it stays visible and
 * correct with several grids open and in a popped-out window. The plugin mirrors the aggregate
 * into the app status bar as well (§12).
 */
export class StatusBar {
	private el!: HTMLElement;
	private addressEl!: HTMLElement;
	private aggregateEl!: HTMLElement;
	private usedEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private stateEl!: HTMLElement;

	private onCopy: (text: string) => void = () => undefined;

	mount(parent: HTMLElement, onSave: () => void, onCopy?: (text: string) => void): void {
		if (onCopy) this.onCopy = onCopy;
		this.el = parent.createDiv({ cls: "mds-statusbar" });
		this.addressEl = this.el.createDiv({ cls: "mds-status-address" });
		this.aggregateEl = this.el.createDiv({ cls: "mds-status-aggregate" });
		this.hintEl = this.el.createDiv({ cls: "mds-status-hint" });
		this.usedEl = this.el.createDiv({ cls: "mds-status-used" });
		this.stateEl = this.el.createDiv({ cls: "mds-status-state" });
		this.stateEl.addEventListener("click", onSave);
	}

	update(model: StatusBarModel): void {
		this.addressEl.setText(model.address);
		this.aggregateEl.empty();
		if (model.stats && model.stats.length > 0) {
			for (const stat of model.stats) {
				const el = this.aggregateEl.createSpan({ cls: "mds-status-stat" });
				el.createSpan({ cls: "mds-status-stat-label", text: `${stat.label} ` });
				el.createSpan({ cls: "mds-status-stat-value", text: stat.value });
				setTooltip(el, "Click to copy");
				el.addEventListener("click", () => this.onCopy(stat.value));
			}
		} else {
			this.aggregateEl.setText(model.aggregate);
		}
		this.usedEl.setText(model.usedRange);
		this.hintEl.setText(model.hint ?? "");
		this.hintEl.toggleClass("mds-hidden", (model.hint ?? "") === "");

		this.stateEl.empty();
		this.stateEl.toggleClass("is-dirty", model.dirty);
		const icon = this.stateEl.createSpan({ cls: "mds-status-state-icon" });
		if (model.dirty) {
			setIcon(icon, model.saveMode === "manual" ? "save" : "loader");
			this.stateEl.createSpan({ text: model.saveMode === "manual" ? "Unsaved" : "Saving…" });
			setTooltip(this.stateEl, model.saveMode === "manual" ? "Click to write the table back to the note" : "Writing back shortly");
		} else {
			setIcon(icon, "check");
			this.stateEl.createSpan({ text: "Saved" });
			setTooltip(this.stateEl, "The note matches the grid");
		}
	}
}
