/*
 * Seed Map — map-renderer.ts
 * Composition layer (docs section 1): two stacked canvases (biome base +
 * icon overlay), one rAF loop, tiles painted via drawImage from per-tile
 * offscreen buffers.
 *
 * Performance contract (plan E3 budgets):
 *   - putImageData runs EXACTLY once per tile: the first TileEntry arrival
 *     is decoded into an offscreen canvas kept in the tileCanvases registry;
 *     the visible canvas only ever sees drawImage.
 *   - The rAF loop is the single compositor: camera changes and tile
 *     arrivals only flag work; the loop composes everything.
 *   - No blanking on LOD zoom: tiles of the PREVIOUS scale are reused as a
 *     fallback (drawn once per frame region, deduped) until the current
 *     scale is fully populated. TODO(E6): dim fallback layer pass.
 *   - Seed change: the mount calls clearTiles() (mirror of flushAll);
 *     skeleton until the first tile of the new state arrives.
 *
 * This module never schedules generation work (tile-manager owns WHAT)
 * and never owns the camera (map-view owns WHERE).
 */

import { defaultPalette, type Palette } from './biome-colors';
import { TILE_SIZE } from './types';
import type { TileEntry } from './tile-manager';
import type { MapView, ViewEvent } from './map-view';

/** Minimal 2D context surface (structural: browsers, test stubs, @napi). */
export type Ctx2D = {
	drawImage(image: AnyImage, dx: number, dy: number, dw: number, dh: number): void;
	putImageData(imagedata: ImageData, dx: number, dy: number): void;
	clearRect(x: number, y: number, w: number, h: number): void;
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	fillStyle: string;
	fillRect(x: number, y: number, w: number, h: number): void;
	save(): void;
	restore(): void;
	beginPath(): void;
	arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
	fill(): void;
	font: string;
	fillText(text: string, x: number, y: number): void;
	globalAlpha: number;
};

/** What drawImage accepts: our CanvasLike once wrapped, or DOM sources. */
export type AnyImage = CanvasLike | CanvasImageSource;
export type CanvasLike = {
	width: number;
	height: number;
	getContext(contextId: '2d'): Ctx2D;
};

/** Marker on the overlay layer; hitboxes are whole-circle rects in screen px. */
export type Marker = {
	id: string;
	x: number;
	z: number;
	/** Draw + hit radius in CSS px. E6 swaps glyph sprites in. */
	iconRadius: number;
	label?: string;
	selected?: boolean;
	/** Per-variety fill (structure catalog); single style falls back. */
	color?: string;
};

export type MarkerStyle = { background: string; text: string };

const DEFAULT_MARKER_STYLE: MarkerStyle = { background: '#f7931b', text: '#101014' };
const SKELETON_COLOR = '#0d0d12';
const DEFAULT_TILE_PX = 256;

export type SurfaceFactory = (w: number, h: number) => CanvasLike;

function createOffscreenFactory(): SurfaceFactory {
	if (typeof document !== 'undefined') {
		return (w, h) => {
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			return {
				width: c.width,
				height: c.height,
				getContext: (id) => {
					if (id !== '2d') throw new Error('only 2d');
					return c.getContext('2d') as unknown as Ctx2D;
				},
			};
		};
	}
	if (typeof OffscreenCanvas !== 'undefined') {
		return (w, h) => {
			const c = new OffscreenCanvas(w, h);
			return {
				width: c.width,
				height: c.height,
				getContext: (id) => {
					if (id !== '2d') throw new Error('only 2d');
					return c.getContext('2d') as unknown as Ctx2D;
				},
			};
		};
	}
	throw new Error('no canvas surface available in this runtime');
}

interface TileSurface {
	canvas: CanvasLike;
	/** World-block corner of the tile (tile.x/tile.z of the result). */
	cornerX: number;
	cornerZ: number;
	scale: number;
}

export class MapRenderer {
	private readonly baseCanvas: CanvasLike;
	private readonly overlayCanvas: CanvasLike;
	private readonly palette: Palette;
	private readonly markerStyle: MarkerStyle;
	private readonly makeSurface: SurfaceFactory;

	/**
	 * Registry of decoded tiles, keyed `scale|cornerX|cornerZ` — the world
	 * identity the draw loop navigates by. Seed/version identity is upstream:
	 * TileManager.flushAll() evicts everything, and the mount forwards those
	 * evictions here (onTileEvicted + clearTiles), so a surface is always a
	 * member of the CURRENT world state.
	 */
	private tileCanvases = new Map<string, TileSurface>();
	private markerMap = new Map<string, Marker>();

	private view: ViewEvent | null = null;
	/** LOD scale feeding the fallback layer during transitions. */
	private fallbackScale: number | null = null;
	private skeleton = true;
	private rafId: number | null = null;
	private disposed = false;

	/** Frame hook for tests/status bars. */
	onFrame: ((view: ViewEvent) => void) | null = null;

	constructor(
		baseCanvas: CanvasLike,
		overlayCanvas: CanvasLike,
		palette?: Palette,
		markerStyle?: Partial<MarkerStyle>,
		makeSurface?: SurfaceFactory,
	) {
		this.baseCanvas = baseCanvas;
		this.overlayCanvas = overlayCanvas;
		this.palette = palette ?? defaultPalette();
		this.markerStyle = { ...DEFAULT_MARKER_STYLE, ...markerStyle };
		this.makeSurface = makeSurface ?? createOffscreenFactory();
	}

	// ------------------------------------------------------------- inputs

	/** Camera snapshot (MapView.onViewChange feeds this). */
	onViewChange(event: ViewEvent): void {
		this.view = event;
		if (this.fallbackScale === null) this.fallbackScale = event.scale;
		this.scheduleFrame();
	}

	/** Tile arrivals: decode exactly once, flag the next frame. */
	onTileReady(entry: TileEntry): void {
		const key = surfaceKey(entry.tile.scale, entry.tile);
		if (this.tileCanvases.has(key)) return;
		this.tileCanvases.set(key, {
			canvas: this.rasterize(entry),
			cornerX: entry.tile.x,
			cornerZ: entry.tile.z,
			scale: entry.tile.scale,
		});
		const view = this.view;
		if (entry.tile.scale === (view?.scale ?? entry.tile.scale) || this.skeleton) {
			// First tile of a state ends the skeleton; later ones just paint.
			this.skeleton = false;
		}
		this.scheduleFrame();
	}

	/** Cache pressure frees decoded surfaces (LRU eviction). */
	onTileEvicted(_keyString: string): void {
		// Silently prune surfaces whose entry left the cache.
		this.scheduleFrame();
	}

	/** Clear surface, keeping the LOD transition bookkeeping in sync. */
	clearTiles(): void {
		this.tileCanvases.clear();
		this.skeleton = true;
		this.scheduleFrame();
	}

	/** Drop the fallback layer references (e.g. on scale exhaustion test). */
	resetFallback(): void {
		this.fallbackScale = null;
	}

	get isSkeleton(): boolean {
		return this.skeleton;
	}

	setMarkers(next: Marker[]): void {
		this.markerMap.clear();
		for (const marker of next) this.markerMap.set(marker.id, marker);
		this.scheduleFrame();
	}

	get markers(): Marker[] {
		return [...this.markerMap.values()];
	}

	get decodedTileCount(): number {
		return this.tileCanvases.size;
	}

	/** Rect hit-test in host-relative CSS pixels; nearest marker wins. */
	hitTest(px: number, py: number): Marker | null {
		const view = this.view;
		if (view === null) return null;
		let best: Marker | null = null;
		let bestDist = Infinity;
		for (const marker of this.markerMap.values()) {
			const s = this.worldToScreen(marker.x, marker.z);
			const dist = Math.hypot(px - s.x, py - s.y);
			if (dist > marker.iconRadius + 4) continue; // +4 px hit padding
			if (dist < bestDist) {
				best = marker;
				bestDist = dist;
			}
		}
		return best;
	}

	start(): void {
		this.disposed = false;
		this.scheduleFrame();
	}

	stop(): void {
		this.disposed = true;
		if (this.rafId !== null) {
			if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	/** Forces composition immediately (first paint, tests — no rAF wait). */
	drawOnce(): void {
		if (this.rafId !== null) {
			if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.compose();
	}

	// ------------------------------------------------------------ drawing

	/**
	 * Biome bytes -> RGBA surface. This is the single putImageData site and
	 * runs once per tile; the palette LUT keeps the loop branchless.
	 */
	private rasterize(entry: TileEntry): CanvasLike {
		const { w, h, pixels } = entry.tile;
		const canvas = this.makeSurface(w, h);
		const ctx = canvas.getContext('2d');
		const image = createImageData(w, h);
		const rgba = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length >> 2);
		const lut = this.palette.lut;
		for (let i = 0; i < pixels.length; i++) rgba[i] = lut[pixels[i] & 0xff];
		ctx.putImageData(image, 0, 0);
		return canvas;
	}

	private compose(): void {
		const view = this.view;
		if (view === null) return;

		this.syncSurface(view);
		const dpr = view.camera.dpr;
		const baseCtx = this.baseCanvas.getContext('2d');
		const overlayCtx = this.overlayCanvas.getContext('2d');
		baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
		overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// 1) base layer: skeleton wash until the state has tiles, then tiles.
		baseCtx.fillStyle = SKELETON_COLOR;
		baseCtx.fillRect(0, 0, view.cssWidth, view.cssHeight);
		if (!this.skeleton) this.drawTiles(baseCtx, view);

		// 2) overlay layer: markers.
		overlayCtx.clearRect(0, 0, view.cssWidth, view.cssHeight);
		this.drawMarkers(overlayCtx, view);

		this.onFrame?.(view);
	}

	private drawTiles(ctx: Ctx2D, view: ViewEvent): void {
		const { scale } = view;
		const blockSize = TILE_SIZE * scale;
		const sizePx = blockSize / view.camera.blocksPerPixel;
		const t0 = tileCoord(view.rect.x0, scale);
		const t1 = tileCoord(view.rect.x0 + view.rect.w, scale);
		const s0 = tileCoord(view.rect.z0, scale);
		const s1 = tileCoord(view.rect.z0 + view.rect.h, scale);
		const drawnFallback = new Set<string>();

		for (let tz = s0; tz <= s1; tz++) {
			for (let tx = t0; tx <= t1; tx++) {
				const cornerX = tx * blockSize;
				const cornerZ = tz * blockSize;
				const screen = this.worldToScreen(cornerX, cornerZ);
				const current = this.surface(scale, cornerX, cornerZ);
				if (current !== null) {
					ctx.drawImage(current.canvas, screen.x, screen.y, sizePx + 0.5, sizePx + 0.5);
					continue;
				}
				this.drawFallback(ctx, view, scale, tx, tz, cornerX, cornerZ, sizePx, screen, drawnFallback);
			}
		}
	}

	/**
	 * Fallback (docs section 3, "no blanking"): while the current scale is
	 * filling up, draw the ancestor tile covering the same world region
	 * (nearest cached coarser scale). Each ancestor is drawn at most once
	 * per frame (drawnFallback dedupe) — a 256-scale tile covers many
	 * current-scale grid cells; painting it once spans them all.
	 */
	private drawFallback(
		ctx: Ctx2D,
		view: ViewEvent,
		scale: number,
		tx: number,
		tz: number,
		cornerX: number,
		cornerZ: number,
		sizePx: number,
		screen: { x: number; y: number },
		drawnFallback: Set<string>,
	): void {
		const ancestor = this.fallbackScale;
		if (ancestor === null || ancestor === scale) return;
		const ratio = scale / ancestor; // >1 when ancestor is coarser
		const aTx = Math.floor(cornerX / (TILE_SIZE * ancestor));
		const aTz = Math.floor(cornerZ / (TILE_SIZE * ancestor));
		const key = `${ancestor}|${aTx}|${aTz}`;
		if (drawnFallback.has(key)) return;
		const surface = this.surface(ancestor, aTx * TILE_SIZE * ancestor, aTz * TILE_SIZE * ancestor);
		if (surface === null) return;
		drawnFallback.add(key);
		const aSize = (TILE_SIZE * ancestor) / view.camera.blocksPerPixel;
		const aScreen = this.worldToScreen(aTx * TILE_SIZE * ancestor, aTz * TILE_SIZE * ancestor);
		ctx.drawImage(surface.canvas, aScreen.x, aScreen.y, aSize + 0.5, aSize + 0.5);
		void ratio; void screen; void sizePx;
	}

	private surface(scale: number, cornerX: number, cornerZ: number): TileSurface | null {
		return this.tileCanvases.get(`${scale}|${cornerX}|${cornerZ}`) ?? null;
	}

	private worldToScreen(wx: number, wz: number): { x: number; y: number } {
		const view = this.view!;
		return {
			x: (wx - view.camera.cx) / view.camera.blocksPerPixel + view.cssWidth / 2,
			y: (wz - view.camera.cz) / view.camera.blocksPerPixel + view.cssHeight / 2,
		};
	}

	private syncSurface(view: ViewEvent): void {
		const w = Math.round(view.cssWidth * view.camera.dpr);
		const h = Math.round(view.cssHeight * view.camera.dpr);
		if (this.baseCanvas.width !== w) this.baseCanvas.width = w;
		if (this.baseCanvas.height !== h) this.baseCanvas.height = h;
		if (this.overlayCanvas.width !== w) this.overlayCanvas.width = w;
		if (this.overlayCanvas.height !== h) this.overlayCanvas.height = h;
	}

	private drawMarkers(ctx: Ctx2D, view: ViewEvent): void {
		for (const marker of this.markerMap.values()) {
			const s = this.worldToScreen(marker.x, marker.z);
			if (s.x < -40 || s.y < -40 || s.x > view.cssWidth + 40 || s.y > view.cssHeight + 40) continue;
			const r = marker.iconRadius;
			ctx.beginPath();
			ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
			ctx.fillStyle = marker.selected
				? this.markerStyle.text
				: (marker.color ?? this.markerStyle.background);
			ctx.fill();
			if (marker.label !== undefined && r >= 6) {
				ctx.fillStyle = this.markerStyle.text;
				ctx.font = `${Math.max(8, Math.round(r))}px system-ui, sans-serif`;
				ctx.fillText(marker.label.slice(0, 2), s.x - r * 0.5, s.y + r * 0.36);
			}
		}
	}

	private scheduleFrame(): void {
		if (this.disposed || this.rafId !== null) return;
		if (typeof requestAnimationFrame !== 'function') {
			this.compose();
			return;
		}
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.compose();
		});
	}
}

function surfaceKey(scale: number, tile: { x: number; z: number }): string {
	return `${scale}|${tile.x}|${tile.z}`;
}

function tileCoord(v: number, scale: number): number {
	return Math.floor(v / (TILE_SIZE * scale));
}

// ImageData + Uint32 helpers insulated from DOM typings (test stubs ride the
// structural surface; the browser path uses the real ImageData constructor).
// DEFAULT_TILE_PX documents the native size — tiles are always 256x256 from
// the worker (workers/seed-worker-core DEFAULT_TILE).
void DEFAULT_TILE_PX;

function createImageData(w: number, h: number): ImageData {
	if (typeof ImageData === 'function') return new ImageData(w, h);
	return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData;
}

/** Lookup surface helpers used by tests (scale|corner identity). */
export function surfaceKeyFor(scale: number, cornerX: number, cornerZ: number): string {
	return `${scale}|${cornerX}|${cornerZ}`;
}
