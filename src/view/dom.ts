/**
 * Cross-window DOM narrowing.
 *
 * `evt.target` is typed `EventTarget`, which has no `instanceOf`. A plain `instanceof
 * HTMLElement` is wrong in a popped-out window, because that window has its own class
 * identities (`prefer-instanceof`, §15.2) — so narrow through Obsidian's helper instead.
 */

type MaybeNode = (Node & { instanceOf?: unknown }) | null;

export function asElement(target: EventTarget | null): HTMLElement | null {
	const node = target as MaybeNode;
	if (node === null || typeof node.instanceOf !== "function") return null;
	return node.instanceOf(HTMLElement) ? node : null;
}

export function asNode(target: EventTarget | null): Node | null {
	const node = target as MaybeNode;
	if (node === null || typeof node.instanceOf !== "function") return null;
	return node.instanceOf(Node) ? node : null;
}
