import type { FormulaFunctionDoc } from "./formula";

/**
 * Turning a function's documentation into a form.
 *
 * The list in `formula.ts` already says what a function takes (`range, condition, sumRange?`);
 * reading that literally is all the argument form needs, and it keeps the dialog from drifting
 * away from the function list the cell editor shows. These two helpers are pure so the form's
 * behaviour — optional arguments, the variadic `…`, trailing blanks — can be tested without a DOM.
 */

export interface FormulaArgSlot {
	label: string;
	optional: boolean;
}

export interface FormulaArgLayout {
	slots: FormulaArgSlot[];
	/** One more group of arguments may follow; the form offers a button for it. */
	variadic: boolean;
	/**
	 * How many arguments one more repetition adds. `SUM(number, …)` adds one; `COUNTIFS(range,
	 * condition, …)` adds a pair, because Excel's *IFS family takes them two at a time and a single
	 * extra field would leave the formula short of the three arguments the parser requires.
	 */
	unit: number;
}

/** `range, condition, sumRange?` → three slots, the last optional. `…` says more may follow. */
export function argumentSlots(doc: FormulaFunctionDoc): FormulaArgLayout {
	const parts = doc.signature
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	const variadic = parts.includes("…") || parts.includes("...");
	const slots = parts
		.filter((part) => part !== "…" && part !== "...")
		.map((part) => ({ label: part.endsWith("?") ? part.slice(0, -1) : part, optional: part.endsWith("?") }));
	const unit = variadic ? Math.min(/IFS$/i.test(doc.name) ? 2 : 1, slots.length) : 0;
	return { slots, variadic, unit };
}

/** The slot an argument index belongs to, cycling through the repeating group. */
export function slotAt(layout: FormulaArgLayout, index: number): FormulaArgSlot {
	const last = layout.slots.length - 1;
	if (index <= last) return layout.slots[index];
	const start = Math.max(0, layout.slots.length - layout.unit);
	return layout.slots[start + ((index - layout.slots.length) % layout.unit)];
}

/**
 * `SUM` and `["B2:B4"]` → `SUM(B2:B4)`.
 *
 * Blank arguments at the end are dropped, because that is what leaving an optional one empty
 * means. A blank *before* a filled one is kept, and the parser then refuses the formula — which is
 * the right answer: there is no way to skip the middle argument of a call.
 */
export function formulaFromArgs(name: string, args: string[]): string {
	const kept = args.map((arg) => arg.trim());
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return `${name}(${kept.join(", ")})`;
}
