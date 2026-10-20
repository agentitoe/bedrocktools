/*
 * Seed Map — map-view.ts
 * Geometry + interaction source of truth (docs section 2, row "map-view").
 * Owns the camera (CameraState), maps world <-> screen, and feeds DOM
 * pointer/wheel events into pan/zoom. The renderer and the tile manager
 * consume snapshots; this module never draws and never talks to the pool.
 *
 * Semantics (documented thresholds live in types.ts):
 *   - blocksPerPixel: world blocks covered by one CSS pixel. Native LOD
 *     scales are 1:1 (bpp 1), 1:4 (bpp 4), 1:256 (bpp 256).
 *   - Zoom clamps to [BPP_MIN=1/8, BPP_MAX=256]. Below 1 the native 1:1
 *     tiles are magnified (<= 8x, capped to keep the interpolation honest);
 *     above 256 the whole map compresses beyond the tile grid's usefulness.
 *   - DPR is capped at 2 (docs risk 6): backing stores are CSS size * dpr,
 *     screens > 2x waste memory without visible sharpening.
 *   - World coordinates clamp to ±WORLD_LIMIT at the edges of the camera.
 */

import {
	WORLD_LIMIT,
	lodScaleFor,
	type CameraState,
	type WorldRect,
} from './types';

export const BPP_MIN = 1 / 8;
export const BPP_MAX = 256;
export const DPR_CAP = 2;

/** Default CSS size before the container reports its own client size. */
const INITIAL_SIZE = { w: 800, h: 600 };

export type ViewEvent = {
	camera: CameraState;
	/** Visible world rectangle (expanded negligibly to cover pixel seams). */
	rect: WorldRect;
	/** Cubiomes LOD scale for the current blocksPerPixel. */
	scale: number;
	cssWidth: number;
	cssHeight: number;
};

export type ViewListener = (event: ViewEvent) => void;

/** Minimal element surface used (structurally satisfies HTMLCanvasElement). */
export type ViewHost = {
	clientWidth: number;
	clientHeight: number;
	style: CSSStyleDeclaration;
	setPointerCapture(pointerId: number): void;
	releasePointerCapture(pointerId: number): void;
	onpointerdown: ((e: { pointerId: number; button: number; clientX: number; clientY: number; isPrimary: boolean; preventDefault(): void }) => void) | null;
	onpointermove: ((e: { pointerId: number; clientX: number; clientY: number; isPrimary: boolean; pointerType: string; buttons: number; preventDefault(): void }) => void) | null;
	onpointerup: ((e: { pointerId: number; isPrimary: boolean; pointercancelled?: boolean; preventDefault(): void }) => void) | null;
	onpointerleave: (() => void) | null;
	onwheel: ((e: WheelLike) => void) | null;
};

export type WheelLike = {
	deltaY: number;
	clientX: number;
	clientY: number;
	preventDefault(): void;
};

type PointerPose = { x: number; y: number };

export class MapView {
	private camera: CameraState;
	private host: ViewHost;
	private cssWidth = INITIAL_SIZE.w;
	private cssHeight = INITIAL_SIZE.h;
	private listeners = new Set<ViewListener>();

	// Input state (Pointer Events: one code path for mouse/touch/pen).
	private pointers = new Map<number, PointerPose>();
	private pinchSpan = 0;

	/** True while a pointer drag is active (cursor:grabbing in mounts). */
	get dragging(): boolean {
		return this.pointers.size > 0;
	}

	constructor(host: ViewHost, initial?: Partial<CameraState>) {
		this.host = host;
		this.camera = {
			cx: initial?.cx ?? 0,
			cz: initial?.cz ?? 0,
			blocksPerPixel: initial?.blocksPerPixel ?? 4,
			dpr: initial?.dpr ?? 1,
		};
		// Honor the container size immediately; attach()/syncSizes() keep it
		// fresh afterwards (ResizeObserver ticks).
		this.cssWidth = Math.max(1, host.clientWidth || INITIAL_SIZE.w);
		this.cssHeight = Math.max(1, host.clientHeight || INITIAL_SIZE.h);
	}

	// ------------------------------------------------------------- attach

	/**
	 * Wires DOM events on the host element and starts emitting view events.
	 * The two-layer canvas stack is the host (events bubble from both).
	 */
	attach(emitInitially = true): () => void {
		const host = this.host;
		host.onpointerdown = (e) => {
			if (e.button !== 0) return;
			host.setPointerCapture(e.pointerId);
			this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (this.pointers.size === 2) this.startPinch();
			e.preventDefault();
		};
		host.onpointermove = (e) => {
			const pose = this.pointers.get(e.pointerId);
			if (!pose) return this.emitHover(e); // hover: nothing to track
			const dx = e.clientX - pose.x;
			const dy = e.clientY - pose.y;
			pose.x = e.clientX;
			pose.y = e.clientY;
			if (this.pointers.size === 1) {
				this.panByPixels(dx, dy);
			} else if (this.pointers.size === 2) {
				this.applyPinch();
			}
			e.preventDefault();
		};
		const release = ({ pointerId }: { pointerId: number }) => {
			if (this.pointers.delete(pointerId)) {
				this.stopPinch();
			}
		};
		host.onpointerup = (e) => {
			release(e);
			try { host.releasePointerCapture(e.pointerId); } catch { /* detached */ }
		};
		host.onpointerleave = () => {
			// Pen/mouse leaving the surface while not capturing ends the drag.
			if (this.pointers.size > 0) for (const id of [...this.pointers.keys()]) release({ pointerId: id });
		};
		host.onwheel = (e) => {
			// Multiplicative zoom, cursor-centered. |deltaY| per notch is
			// 100-ish on Chrome/Firefox; 0.0016/8 ~= 1.14^-1 per notch.
			const factor = Math.pow(2, -e.deltaY * 0.0016);
			this.zoomAt(e.clientX, e.clientY, factor);
			e.preventDefault();
		};
		this.syncSizes();
		if (emitInitially) this.emit();
		let unbound = false;
		return () => {
			if (unbound) return;
			unbound = true;
			host.onpointerdown = null;
			host.onpointermove = null;
			host.onpointerup = null;
			host.onpointerleave = null;
			host.onwheel = null;
		};
	}

	/**
	 * Pulls the container size + devicePixelRatio; the mount code calls this
	 * on ResizeObserver ticks. Transform correctness is size-keyed (the CSS
	 * pixel geometry is what the camera is defined against).
	 */
	syncSizes(): void {
		const w = Math.max(1, this.host.clientWidth || INITIAL_SIZE.w);
		const h = Math.max(1, this.host.clientHeight || INITIAL_SIZE.h);
		const dprCap = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		const dpr = Math.min(DPR_CAP, Math.max(1, Math.round(dprCap) || 1));
		if (w !== this.cssWidth || h !== this.cssHeight || dpr !== this.camera.dpr) {
			this.cssWidth = w;
			this.cssHeight = h;
			this.camera.dpr = dpr;
			this.emit();
		}
	}

	// ------------------------------------------------------------ camera

	getCamera(): CameraState {
		return { ...this.camera };
	}

	/** Programmatic jump (spawn button, structure click in E4/E6). */
	setCenter(cx: number, cz: number): void {
		this.camera.cx = clampWorld(cx);
		this.camera.cz = clampWorld(cz);
		this.emit();
	}

	/** Sets blocks per pixel, zooming freely without a cursor anchor. */
	setBlocksPerPixel(bpp: number): void {
		const clamped = clampBpp(bpp);
		if (clamped === this.camera.blocksPerPixel) return;
		this.camera.blocksPerPixel = clamped;
		this.emit();
	}

	// -------------------------------------------------------- transforms

	/** World blocks -> CSS pixel coordinates relative to the host origin. */
	worldToScreen(wx: number, wz: number): { x: number; y: number } {
		return {
			x: (wx - this.camera.cx) / this.camera.blocksPerPixel + this.cssWidth / 2,
			y: (wz - this.camera.cz) / this.camera.blocksPerPixel + this.cssHeight / 2,
		};
	}

	/**
	 * CSS pixels relative to the host origin -> world blocks. `floor` is NOT
	 * applied: callers pick integer or fractional semantics.
	 */
	screenToWorld(px: number, py: number): { x: number; z: number } {
		return {
			x: (px - this.cssWidth / 2) * this.camera.blocksPerPixel + this.camera.cx,
			z: (py - this.cssHeight / 2) * this.camera.blocksPerPixel + this.camera.cz,
		};
	}

	/** Minecraft chunk coordinates -> world blocks (chunk corner). */
	chunkToWorld(ccx: number, ccz: number): { x: number; z: number } {
		return { x: ccx * 16, z: ccz * 16 };
	}

	/** The visible world rect (what the tile manager trims tiles to). */
	visibleRect(): WorldRect {
		const origin = this.screenToWorld(0, 0);
		return {
			x0: origin.x,
			z0: origin.z,
			w: this.cssWidth * this.camera.blocksPerPixel,
			h: this.cssHeight * this.camera.blocksPerPixel,
		};
	}

	lodScale(): number {
		return lodScaleFor(this.camera.blocksPerPixel);
	}

	// ---------------------------------------------------------- controls

	/** Pans by CSS-pixel deltas (drag). */
	panByPixels(dxPx: number, dyPx: number): void {
		this.camera.cx = clampWorld(this.camera.cx - dxPx * this.camera.blocksPerPixel);
		this.camera.cz = clampWorld(this.camera.cz - dyPx * this.camera.blocksPerPixel);
		this.emit();
	}

	/**
	 * Zooms keeping the world point under (clientX, clientY) fixed —
	 * cursor-centered zoom. Events carry client coords; the host origin is
	 * subtracted via screenToWorld's rect-relative frame.
	 */
	zoomAt(clientX: number, clientY: number, factor: number, hostOrigin?: { x: number; y: number }): void {
		const px = clientX - (hostOrigin?.x ?? 0);
		const py = clientY - (hostOrigin?.y ?? 0);
		const before = this.screenToWorld(px, py);
		const next = clampBpp(this.camera.blocksPerPixel / factor);
		if (next === this.camera.blocksPerPixel) return;
		this.camera.blocksPerPixel = next;
		const after = this.screenToWorld(px, py);
		// Re-anchor the cursor: the shift is the zoom delta in world units.
		this.camera.cx = clampWorld(this.camera.cx + before.x - after.x);
		this.camera.cz = clampWorld(this.camera.cz + before.z - after.z);
		this.emit();
	}

	onViewChange(cb: ViewListener): () => void {
		this.listeners.add(cb);
		return () => void this.listeners.delete(cb);
	}

	// ------------------------------------------------------------ internals

	private startPinch(): void {
		if (this.pointers.size !== 2) return;
		const [a, b] = [...this.pointers.values()];
		this.pinchSpan = Math.hypot(a.x - b.x, a.y - b.y) || 1e-6;
	}

	private applyPinch(): void {
		const [a, b] = [...this.pointers.values()];
		const span = Math.hypot(a.x - b.x, a.y - b.y);
		if (span <= 0 || this.pinchSpan <= 0) return;
		// Scale around the FIRST (stable) pointer so tracking never jumps.
		this.zoomAt(a.x, a.y, span / this.pinchSpan);
		this.pinchSpan = span;
	}

	private stopPinch(): void {
		this.pinchSpan = 0;
	}

	private emitHover(_e: unknown): void {
		// Hover coords are pulled by the status bar (E6) via screenToWorld;
		// no emission here keeps view events strictly camera-keyed.
	}

	private emit(): void {
		const rect = this.visibleRect();
		const camera = { ...this.camera };
		const event: ViewEvent = {
			camera,
			rect,
			scale: this.lodScale(),
			cssWidth: this.cssWidth,
			cssHeight: this.cssHeight,
		};
		for (const cb of this.listeners) cb(event);
	}
}

function clampBpp(bpp: number): number {
	if (!Number.isFinite(bpp)) return BPP_MAX;
	if (bpp < BPP_MIN) return BPP_MIN;
	if (bpp > BPP_MAX) return BPP_MAX;
	return bpp;
}

function clampWorld(v: number): number {
	if (v < -WORLD_LIMIT) return -WORLD_LIMIT;
	if (v > WORLD_LIMIT) return WORLD_LIMIT;
	return v;
}

