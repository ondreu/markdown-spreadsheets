import { describe, expect, it } from "vitest";
import { GestureTracker } from "../src/feature/gesture";
import { resolveTouchLayout } from "../src/settings";

const opts = { slop: 10, longPressMs: 500 };

describe("GestureTracker", () => {
	it("recognises a tap", () => {
		const g = new GestureTracker(opts);
		g.down(1, 100, 100, 0);
		expect(g.move(1, 104, 103)).toBeNull();
		expect(g.up(1, 104, 103)).toEqual({ kind: "tap", x: 104, y: 103 });
		expect(g.isActive()).toBe(false);
	});

	it("a finger that moved past the slop is a scroll, not a tap", () => {
		const g = new GestureTracker(opts);
		g.down(1, 100, 100, 0);
		g.move(1, 100, 130);
		g.move(1, 100, 101);
		expect(g.up(1, 100, 101)).toBeNull();
	});

	it("an up far from the down is not a tap even without moves in between", () => {
		const g = new GestureTracker(opts);
		g.down(1, 100, 100, 0);
		expect(g.up(1, 160, 100)).toBeNull();
	});

	it("a cancelled pointer — the browser scrolling — never taps", () => {
		const g = new GestureTracker(opts);
		g.down(1, 100, 100, 0);
		g.cancel(1);
		expect(g.isActive()).toBe(false);
		expect(g.up(1, 100, 100)).toBeNull();
	});

	it("a long press fires once, after the delay, and swallows the tap", () => {
		const g = new GestureTracker(opts);
		g.down(1, 50, 60, 1000);
		expect(g.longPress(1200)).toBeNull();
		expect(g.longPress(1500)).toEqual({ x: 50, y: 60 });
		expect(g.longPress(1600)).toBeNull();
		expect(g.up(1, 50, 60)).toBeNull();
	});

	it("no long press after the finger moved", () => {
		const g = new GestureTracker(opts);
		g.down(1, 50, 60, 0);
		g.move(1, 90, 60);
		expect(g.longPress(800)).toBeNull();
	});

	it("two fingers pinch, and lifting them is not a tap", () => {
		const g = new GestureTracker(opts);
		g.down(1, 100, 100, 0);
		g.down(2, 200, 100, 10);
		expect(g.isPinching()).toBe(true);
		expect(g.move(2, 300, 100)).toEqual({ kind: "pinch", scale: 2 });
		expect(g.move(1, 200, 100)).toEqual({ kind: "pinch", scale: 1 });
		expect(g.longPress(2000)).toBeNull();
		expect(g.up(2, 300, 100)).toBeNull();
		expect(g.isPinching()).toBe(false);
		expect(g.up(1, 200, 100)).toBeNull();
		expect(g.isActive()).toBe(false);
	});

	it("starts clean after a pinch", () => {
		const g = new GestureTracker(opts);
		g.down(1, 0, 0, 0);
		g.down(2, 10, 0, 0);
		g.up(1, 0, 0);
		g.up(2, 10, 0);
		g.down(3, 40, 40, 100);
		expect(g.up(3, 40, 40)).toEqual({ kind: "tap", x: 40, y: 40 });
	});

	it("ignores pointers it never saw go down", () => {
		const g = new GestureTracker(opts);
		expect(g.move(7, 1, 1)).toBeNull();
		expect(g.up(7, 1, 1)).toBeNull();
		g.cancel(7);
		expect(g.isActive()).toBe(false);
	});
});

describe("resolveTouchLayout", () => {
	it("follows the platform when automatic", () => {
		expect(resolveTouchLayout("auto", true)).toBe(true);
		expect(resolveTouchLayout("auto", false)).toBe(false);
	});

	it("an explicit choice wins over the platform", () => {
		expect(resolveTouchLayout("on", false)).toBe(true);
		expect(resolveTouchLayout("off", true)).toBe(false);
	});
});
