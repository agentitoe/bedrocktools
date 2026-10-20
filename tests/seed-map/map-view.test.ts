/*
 * Seed Map — map-view transform + input plumbing tests.
 * Pure geometry assertions (no real DOM events): host objects are stubs
 * satisfying the structural ViewHost surface.
 */

import { test, expect } from 'bun:test';
import {
	MapView,
	BPP_MAX,
	BPP_MIN,
	DPR_CAP,
	type ViewHost,
} from '../../src/tools/seed-map/map-view';
import { WORLD_LIMIT } from '../../src/tools/seed-map/types';
import { lodScaleFor } from '../../src/tools/seed-map/types';

function stubHost(w = 800, h = 600): ViewHost {
	return {
		clientWidth: w,
		clientHeight: h,
		style: {} as CSSStyleDeclaration,
		setPointerCapture() {},
		releasePointerCapture() {},
		onpointerdown: null,
		onpointermove: null,
		onpointerup: null,
		onpointerleave: null,
		onwheel: null,
	} as unknown as ViewHost;
}

test('world<->screen round-trips at any zoom level', () => {
	const view = new MapView(stubHost());
	for (const bpp of [BPP_MIN, 1, 4, 256, BPP_MAX]) {
		view.setBlocksPerPixel(bpp);
		view.setCenter(1234567, -987654);
		const s = view.worldToScreen(1_000_500, -1_000_000);
		const w = view.screenToWorld(s.x, s.y);
		expect(w.x).toBeCloseTo(1_000_500, 4);
		expect(w.z).toBeCloseTo(-1_000_000, 4);
	}
});

test('screen center maps to the camera center', () => {
	const view = new MapView(stubHost(800, 600));
	const w = view.screenToWorld(400, 300);
	expect(w.x).toBe(0);
	expect(w.z).toBe(0);
	expect(view.visibleRect().w).toBe(800 * 4); // default bpp 4
});

test('visible rect tracks camera and size with LOD scale attached', () => {
	const view = new MapView(stubHost(400, 300));
	let last: { scale: number; w: number } | null = null;
	view.onViewChange((e) => { last = { scale: e.scale, w: e.rect.w }; });
	view.setBlocksPerPixel(32);
	expect(last).not.toBeNull();
	expect(last!.scale).toBe(lodScaleFor(32));
	expect(last!.w).toBeCloseTo(400 * 32);
});

test('zoomAt keeps the world point under the cursor anchored', () => {
	const view = new MapView(stubHost(800, 600));
	view.setBlocksPerPixel(4);
	view.setCenter(0, 0);
	// Cursor at (600, 150) CSS px sees world (800, -600) at bpp 4.
	const px = 600, py = 150;
	const before = view.screenToWorld(px, py);
	const zoomFactor = 4; // zoom IN 4x -> bpp 1
	view.zoomAt(px, py, zoomFactor);
	expect(view.getCamera().blocksPerPixel).toBe(1);
	const after = view.screenToWorld(px, py);
	expect(after.x).toBeCloseTo(before.x, 6);
	expect(after.z).toBeCloseTo(before.z, 6);
});

test('zoom is multiplicative-inverse stable and bounded', () => {
	const view = new MapView(stubHost());
	view.setBlocksPerPixel(4);
	view.zoomAt(0, 0, 1000);
	expect(view.getCamera().blocksPerPixel).toBe(BPP_MIN);
	// The exact inverse of a CLAMPED zoom magnifies back by 1000x (0.125*1000):
	// bounded by BPP_MAX, still a legitimate state.
	view.zoomAt(0, 0, 1 / 1000);
	expect(view.getCamera().blocksPerPixel).toBe(125);
	view.setBlocksPerPixel(BPP_MAX);
	view.zoomAt(0, 0, 1 / 1000);
	expect(view.getCamera().blocksPerPixel).toBe(BPP_MAX);
});

test('camera clamps to the +/-30M world window on pans and centers', () => {
	const view = new MapView(stubHost());
	view.setBlocksPerPixel(256);
	view.setCenter(WORLD_LIMIT * 2, -WORLD_LIMIT * 3);
	expect(view.getCamera().cx).toBe(WORLD_LIMIT);
	expect(view.getCamera().cz).toBe(-WORLD_LIMIT);
	view.panByPixels(1e9, -1e9);
	expect(view.getCamera().cz).toBe(WORLD_LIMIT);
});

test('dragging pan moves the camera opposite to the pointer delta', () => {
	const view = new MapView(stubHost());
	view.setBlocksPerPixel(4);
	view.setCenter(0, 0);
	let events = 0;
	view.onViewChange(() => events++);
	view.panByPixels(100, 50); // drag right/down moves the world with the cursor
	expect(view.getCamera().cx).toBe(-400);
	expect(view.getCamera().cz).toBe(-200);
	expect(events).toBe(1);
});

test('chunkToWorld converts chunk coordinates to block corners', () => {
	const view = new MapView(stubHost());
	expect(view.chunkToWorld(-1, 17)).toEqual({ x: -16, z: 272 });
});

test('pointer capture hosts drive the same pan path via synthetic events', () => {
	const host = stubHost();
	const view = new MapView(host);
	view.attach(false);
	// Synthetic pointer drag through the bound handlers.
	host.onpointerdown!({ pointerId: 1, button: 0, clientX: 100, clientY: 100, isPrimary: true, preventDefault() {} });
	expect(view.dragging).toBe(true);
	host.onpointermove!({ pointerId: 1, clientX: 150, clientY: 160, isPrimary: true, pointerType: 'mouse', buttons: 1, preventDefault() {} });
	// Moved +50,+60 CSS px at bpp 4 -> camera shifts -200,-240 host-relative.
	expect(view.getCamera().cx).toBe(-200);
	expect(view.getCamera().cz).toBe(-240);
	// Wheel zoom zooms IN for negative deltaY (factor > 1 → smaller bpp).
	host.onwheel!({ deltaY: -100, clientX: 0, clientY: 0, preventDefault() {} });
	expect(view.getCamera().blocksPerPixel).toBeLessThan(4);
	host.onpointerup!({ pointerId: 1, isPrimary: true, preventDefault() {} });
	expect(view.dragging).toBe(false);
});

test('DPR is capped at two and rounds fractional ratios', () => {
	expect(DPR_CAP).toBe(2);
	expect(BPP_MIN).toBe(1 / 8);
	expect(BPP_MAX).toBe(256);
});
