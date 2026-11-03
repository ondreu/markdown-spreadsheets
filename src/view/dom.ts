/**
 * Cross-window DOM narrowing.
 *
 * `evt.target` is typed `EventTarget`, which has no `instanceOf`. A plain `instanceof
 * HTMLElement` is wrong in a popped-out window, because that window has its own class
 * identities (`prefer-instanceof`, §15.2) — so narrow through Obsidian's helper instead.
 */

type MaybeNode = (Node & { instanceOf?: unknown }) | null;

/**
 * The HTML element an event happened on. A click on an icon lands on its `<svg>` or `<path>`,
 * which is not an `HTMLElement` — returning null there made every click on an icon inside the
 * grid (the filter arrow in a column header, an icon in a rendered cell) do nothing. Such a
 * target resolves to its nearest HTML ancestor instead.
 */
export function asElement(target: EventTarget | null): HTMLElement | null {
	let node = target as MaybeNode;
	if (node === null || typeof node.instanceOf !== "function") return null;
	while (node !== null && !node.instanceOf(HTMLElement)) node = node.parentNode;
	return node !== null && node.instanceOf(HTMLElement) ? node : null;
}

export function asNode(target: EventTarget | null): Node | null {
	const node = target as MaybeNode;
	if (node === null || typeof node.instanceOf !== "function") return null;
	return node.instanceOf(Node) ? node : null;
}
