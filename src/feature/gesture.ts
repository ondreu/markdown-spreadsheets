/**
 * Touch gestures on the grid, as a pure state machine (decision 24).
 *
 * The browser keeps doing what it is good at — a one-finger drag scrolls the grid natively, and
 * it says so by cancelling the pointer. What is left to recognise here is what a mouse expressed
 * with buttons and modifiers:
 *
 * - **tap**: down and up without moving past `slop`, and before the long press fired;
 * - **long press**: still down and still within `slop` after `longPressMs` — the context menu;
 * - **pinch**: two fingers; the scale is the ratio of their distance to the starting distance.
 *
 * A gesture that ever had two fingers on the glass never ends in a tap, and neither does one the
 * browser took over for scrolling. No Obsidian or DOM import, so every rule is unit-tested; the
 * view only feeds it pointer coordinates and timestamps and runs the long-press timer.
 */

export interface GestureOptions {
	/** How far a finger may wander, in px, and still count as holding still. */
	slop: number;
	longPressMs: number;
}

export const DEFAULT_GESTURE: GestureOptions = { slop: 10, longPressMs: 500 };

export type GestureResult = { kind: "tap"; x: number; y: number } | { kind: "pinch"; scale: number } | null;

interface Point {
	x: number;
	y: number;
}

export class GestureTracker {
	private readonly pointers = new Map<number, Point>();
	private start: (Point & { id: number; time: number }) | null = null;
	/** False once the gesture moved, pinched, was cancelled or became a long press. */
	private tappable = false;
	private pinchStart = 0;

	constructor(private readonly opts: GestureOptions = DEFAULT_GESTURE) {}

	/** True while at least one finger is down. */
	isActive(): boolean {
		return this.pointers.size > 0;
	}

	isPinching(): boolean {
		return this.pinchStart > 0;
	}

	down(id: number, x: number, y: number, time: number): void {
		this.pointers.set(id, { x, y });
		if (this.pointers.size === 1) {
			this.start = { id, x, y, time };
			this.tappable = true;
			this.pinchStart = 0;
			return;
		}
		// A second finger: this gesture is a pinch now, never a tap or a long press.
		this.tappable = false;
		if (this.pointers.size === 2) this.pinchStart = this.spread();
	}

	move(id: number, x: number, y: number): GestureResult {
		if (!this.pointers.has(id)) return null;
		this.pointers.set(id, { x, y });
		if (this.start !== null && id === this.start.id && this.tappable) {
			if (Math.hypot(x - this.start.x, y - this.start.y) > this.opts.slop) this.tappable = false;
		}
		if (this.pointers.size === 2 && this.pinchStart > 0) {
			const now = this.spread();
			if (now > 0) return { kind: "pinch", scale: now / this.pinchStart };
		}
		return null;
	}

	up(id: number, x: number, y: number): GestureResult {
		if (!this.pointers.has(id)) return null;
		this.pointers.delete(id);
		const wasTap = this.tappable && this.start !== null && id === this.start.id && this.pointers.size === 0;
		if (wasTap && this.start !== null && Math.hypot(x - this.start.x, y - this.start.y) > this.opts.slop) {
			this.reset();
			return null;
		}
		if (this.pointers.size < 2) this.pinchStart = 0;
		if (this.pointers.size === 0) this.reset();
		return wasTap ? { kind: "tap", x, y } : null;
	}

	/** The browser took the pointer over — it is scrolling. Nothing this gesture does counts. */
	cancel(id: number): void {
		if (!this.pointers.has(id)) return;
		this.pointers.delete(id);
		this.tappable = false;
		if (this.pointers.size < 2) this.pinchStart = 0;
		if (this.pointers.size === 0) this.reset();
	}

	/**
	 * Called by the long-press timer. Returns where to open the menu when the finger is still down
	 * and still, and consumes the gesture so lifting the finger is not also a tap.
	 */
	longPress(time: number): Point | null {
		if (!this.tappable || this.start === null || this.pointers.size !== 1) return null;
		if (time - this.start.time < this.opts.longPressMs) return null;
		this.tappable = false;
		const at = this.pointers.get(this.start.id);
		return at ? { x: at.x, y: at.y } : null;
	}

	private spread(): number {
		const [a, b] = Array.from(this.pointers.values());
		if (a === undefined || b === undefined) return 0;
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	private reset(): void {
		this.start = null;
		this.tappable = false;
		this.pinchStart = 0;
	}
}
