import { setIcon, setTooltip } from "obsidian";

export interface StatusBarModel {
	/** `A1` or `A1:C4`. */
	address: string;
	/** `Sum · Avg · Count` of the selection, empty when there is nothing numeric. */
	aggregate: string;
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

	mount(parent: HTMLElement, onSave: () => void): void {
		this.el = parent.createDiv({ cls: "mg-statusbar" });
		this.addressEl = this.el.createDiv({ cls: "mg-status-address" });
		this.aggregateEl = this.el.createDiv({ cls: "mg-status-aggregate" });
		this.hintEl = this.el.createDiv({ cls: "mg-status-hint" });
		this.usedEl = this.el.createDiv({ cls: "mg-status-used" });
		this.stateEl = this.el.createDiv({ cls: "mg-status-state" });
		this.stateEl.addEventListener("click", onSave);
	}

	update(model: StatusBarModel): void {
		this.addressEl.setText(model.address);
		this.aggregateEl.setText(model.aggregate);
		this.usedEl.setText(model.usedRange);
		this.hintEl.setText(model.hint ?? "");
		this.hintEl.toggleClass("mg-hidden", (model.hint ?? "") === "");

		this.stateEl.empty();
		this.stateEl.toggleClass("is-dirty", model.dirty);
		const icon = this.stateEl.createSpan({ cls: "mg-status-state-icon" });
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
