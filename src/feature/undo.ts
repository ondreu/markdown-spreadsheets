import { cloneModel, type GridModel } from "../model/GridModel";
import type { TableLayout } from "../store/Sidecar";

export interface Snapshot {
	label: string;
	model: GridModel;
	layout: TableLayout;
}

/**
 * Grid-local undo (§13.2).
 *
 * Full snapshots rather than a command log: the target scale is ≤ 500 rows (D8), so a copy of
 * the cell map costs a fraction of a millisecond, and there is no class of operation that can
 * be replayed incorrectly. Layout goes into the snapshot too, because undoing a column delete
 * has to restore the widths it reindexed.
 */
export class UndoStack {
	private past: Snapshot[] = [];
	private future: Snapshot[] = [];

	constructor(private readonly limit = 100) {}

	/** Call *before* mutating, with the state as it is now. */
	push(label: string, model: GridModel, layout: TableLayout): void {
		this.past.push({ label, model: cloneModel(model), layout: cloneLayout(layout) });
		while (this.past.length > this.limit) this.past.shift();
		this.future = [];
	}

	canUndo(): boolean {
		return this.past.length > 0;
	}

	canRedo(): boolean {
		return this.future.length > 0;
	}

	undoLabel(): string | null {
		return this.past.length > 0 ? this.past[this.past.length - 1].label : null;
	}

	redoLabel(): string | null {
		return this.future.length > 0 ? this.future[this.future.length - 1].label : null;
	}

	/** Returns the state to restore, and banks the current state for redo. */
	undo(current: { model: GridModel; layout: TableLayout }): Snapshot | null {
		const previous = this.past.pop();
		if (!previous) return null;
		this.future.push({
			label: previous.label,
			model: cloneModel(current.model),
			layout: cloneLayout(current.layout),
		});
		return previous;
	}

	redo(current: { model: GridModel; layout: TableLayout }): Snapshot | null {
		const next = this.future.pop();
		if (!next) return null;
		this.past.push({
			label: next.label,
			model: cloneModel(current.model),
			layout: cloneLayout(current.layout),
		});
		return next;
	}

	clear(): void {
		this.past = [];
		this.future = [];
	}
}

export function cloneLayout(layout: TableLayout): TableLayout {
	return {
		colWidths: layout.colWidths.slice(),
		rowHeights: Object.assign({}, {}, layout.rowHeights),
		wrapCols: layout.wrapCols.slice(),
		frozenRows: layout.frozenRows,
		frozenCols: layout.frozenCols,
		decimals: layout.decimals,
		...(layout.rowHeightDefault === undefined ? {} : { rowHeightDefault: layout.rowHeightDefault }),
	};
}
