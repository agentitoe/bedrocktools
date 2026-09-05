// Item icon rendering for the /give Command Generator.
// Blocks with a model get a proper 3D isometric render (same as the Items &
// Blocks tool); layered items (potions, tipped arrows) are composited; the
// rest fall back to their flat texture.
//
// Performance notes:
// - Render caches are bounded LRUs (cap 300) so long sessions can't grow
//   memory without limit; hits return a cheap canvas clone.
// - `getTextureFallbacks` results are cached per item shape.
// - Layered compositing reuses pooled scratch canvases instead of allocating
//   two canvases per layer.
// - 3D renders are deferred until the flat placeholder actually loads
//   (native `loading="lazy"` keeps off-screen items from fetching anything);
//   when `IntersectionObserver` exists it acts as a second gate.

import type { ItemData } from './types';
import { renderModel } from '../minecraft-items/canvas-renderer';

const PLACEHOLDER_SVG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22 viewBox=%220 0 48 48%22%3E%3Crect fill=%22%23666%22 width=%2248%22 height=%2248%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22 font-family=%22monospace%22%3E?%3C/text%3E%3C/svg%3E";

const CACHE_CAP = 300;

/** Minimal bounded LRU built on `Map` insertion order. */
class LruCache<K, V> {
	private readonly cap: number;
	private readonly map = new Map<K, V>();
	constructor(cap: number) { this.cap = cap; }
	get(key: K): V | undefined {
		const v = this.map.get(key);
		if (v !== undefined) {
			// Refresh recency.
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}
	has(key: K): boolean { return this.map.has(key); }
	set(key: K, value: V): void {
		if (this.map.has(key)) this.map.delete(key);
		else if (this.map.size >= this.cap) {
			// Evict the oldest entry.
			const oldest = this.map.keys().next();
			if (!oldest.done) this.map.delete(oldest.value);
		}
		this.map.set(key, value);
	}
	get size(): number { return this.map.size; }
}

const modelRenderCache = new LruCache<string, HTMLCanvasElement>(CACHE_CAP);
const modelLoadingSet = new Set<string>();
const layeredRenderCache = new LruCache<string, HTMLCanvasElement>(CACHE_CAP);
const layeredLoadingSet = new Set<string>();

// Cache for `getTextureFallbacks` (keyed by item shape, not identity).
const fallbacksCache = new LruCache<string, string[]>(CACHE_CAP);

function fallbacksKey(item: ItemData): string {
	const variants = (item.textureVariants || []).join(',');
	return `${item.textureUrl}|${item.renderAs ?? ''}|${variants}`;
}

/** Candidate texture URLs for an item, last one is a placeholder. */
export function getTextureFallbacks(item: ItemData): string[] {
	const key = fallbacksKey(item);
	const hit = fallbacksCache.get(key);
	if (hit) return hit;
	const baseUrl = item.textureUrl;
	const fallbacks: string[] = [baseUrl];
	const isBlock = item.renderAs === 'block';

	if (isBlock) {
		const isSidePrimary = baseUrl.endsWith('_side.webp');
		if (isSidePrimary) {
			const base = baseUrl.replace(/_side\.webp$/, '');
			fallbacks.push(`${base}_top.webp`);
			fallbacks.push(`${base}_bottom.webp`);
			fallbacks.push(`${base}.webp`);
			for (const v of item.textureVariants || []) {
				if (v !== '_side' && v !== '_top' && v !== '_bottom') fallbacks.push(`${base}${v}.webp`);
			}
		} else {
			const base = baseUrl.replace(/\.webp$/, '');
			fallbacks.push(`${base}_side.webp`);
			fallbacks.push(`${base}_top.webp`);
			fallbacks.push(`${base}_bottom.webp`);
			for (const v of item.textureVariants || []) {
				if (v !== '_side' && v !== '_top' && v !== '_bottom') fallbacks.push(`${base}${v}.webp`);
			}
		}
	} else {
		const base = baseUrl.replace(/\.webp$/, '');
		for (const v of item.textureVariants || []) fallbacks.push(`${base}${v}.webp`);
	}

	fallbacks.push(PLACEHOLDER_SVG);
	fallbacksCache.set(key, fallbacks);
	return fallbacks;
}

function createFlatImage(item: ItemData, size: number): HTMLImageElement {
	const fallbacks = getTextureFallbacks(item);
	const img = document.createElement('img');
	img.alt = item.displayName;
	img.loading = 'lazy';
	img.decoding = 'async';
	img.width = size;
	img.height = size;
	img.style.imageRendering = 'pixelated';

	let index = 0;
	img.onerror = () => {
		index++;
		if (index < fallbacks.length) {
			img.src = fallbacks[index];
		} else {
			img.onerror = null;
		}
	};
	img.src = fallbacks[0];
	return img;
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
	const clone = document.createElement('canvas');
	clone.width = source.width;
	clone.height = source.height;
	clone.style.width = `${source.width}px`;
	clone.style.height = `${source.height}px`;
	clone.style.imageRendering = 'pixelated';
	const ctx = clone.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 0, 0);
	return clone;
}

// Pooled scratch canvases for layered compositing (avoids 2 allocs/layer).
const scratchPool: HTMLCanvasElement[] = [];
function acquireScratch(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
	for (let i = 0; i < scratchPool.length; i++) {
		const c = scratchPool[i];
		if (c.width === size && c.height === size) {
			scratchPool.splice(i, 1);
			const ctx = c.getContext('2d')!;
			ctx.globalCompositeOperation = 'source-over';
			ctx.clearRect(0, 0, size, size);
			return { canvas: c, ctx };
		}
	}
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;
	return { canvas, ctx };
}
function releaseScratch(canvas: HTMLCanvasElement): void {
	if (scratchPool.length < 4) scratchPool.push(canvas);
}

/** Run `fn` once `img` is visible (when IO exists) and loaded. */
function deferRender(img: HTMLImageElement, fn: () => void): void {
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		fn();
	};
	const onLoaded = () => {
		if (typeof IntersectionObserver === 'undefined') {
			start();
			return;
		}
		try {
			const io = new IntersectionObserver((entries, observer) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						observer.disconnect();
						start();
						break;
					}
				}
			}, { rootMargin: '200px' });
			io.observe(img);
			// Fallback: never leave the slot in placeholder state.
			setTimeout(() => { io.disconnect(); start(); }, 4000);
		} catch {
			start();
		}
	};
	if (img.complete) onLoaded();
	else img.addEventListener('load', onLoaded, { once: true });
}

// Placeholders waiting for an upgrade, registered directly (no global query).
const pendingElements = new Map<string, Set<HTMLImageElement>>();
const flushScheduled = new Set<string>();

function updateInPlace(cacheKey: string, size: number): void {
	const canvas = modelRenderCache.get(cacheKey) ?? layeredRenderCache.get(cacheKey);
	if (!canvas) return;
	const set = pendingElements.get(cacheKey);
	if (!set || set.size === 0) return;
	pendingElements.delete(cacheKey);
	for (const el of set) {
		try {
			// Skip detached or repurposed placeholders.
			if (!el.isConnected) continue;
			if (el.dataset.renderKey !== cacheKey) continue;
			const c = document.createElement('canvas');
			c.width = size;
			c.height = size;
			c.style.width = `${size}px`;
			c.style.height = `${size}px`;
			c.style.imageRendering = 'pixelated';
			const ctx = c.getContext('2d')!;
			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(canvas, 0, 0, size, size);
			el.replaceWith(c);
		} catch {
			// ignore detached nodes
		}
	}
}

/** rAF-batched in-place upgrade using directly registered elements (no querySelectorAll). */
function scheduleFlush(cacheKey: string, size: number): void {
	if (flushScheduled.has(cacheKey)) return;
	flushScheduled.add(cacheKey);
	const run = () => {
		flushScheduled.delete(cacheKey);
		updateInPlace(cacheKey, size);
	};
	if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(run);
	else run();
}

/** Register a placeholder so a later render upgrades it without a DOM scan. */
function trackPending(img: HTMLImageElement, cacheKey: string): void {
	let set = pendingElements.get(cacheKey);
	if (!set) {
		set = new Set<HTMLImageElement>();
		pendingElements.set(cacheKey, set);
	}
	set.add(img);
}

function triggerModelRender(modelName: string, size: number): void {
	const cacheKey = `${modelName}:${size}`;
	if (modelRenderCache.has(cacheKey) || modelLoadingSet.has(cacheKey)) return;
	modelLoadingSet.add(cacheKey);
	renderModel(modelName, { size })
		.then((canvas) => {
			if (canvas && !modelRenderCache.has(cacheKey)) {
				modelRenderCache.set(cacheKey, canvas);
				scheduleFlush(cacheKey, size);
			}
		})
		.catch(() => {})
		.finally(() => modelLoadingSet.delete(cacheKey));
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Failed to load ${url}`));
		img.src = url;
	});
}

/** Composite a layered flat item (potion = tinted liquid + bottle) onto a canvas. */
async function createLayeredCanvas(item: ItemData, size: number): Promise<HTMLCanvasElement> {
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;

	for (const layer of item.layers || []) {
		let img: HTMLImageElement;
		try {
			img = await loadImageElement(layer.url);
		} catch {
			continue;
		}

		const tmp = acquireScratch(size);
		tmp.ctx.drawImage(img, 0, 0, size, size);

		if (layer.tint) {
			const mask = acquireScratch(size);
			mask.ctx.drawImage(tmp.canvas, 0, 0);
			tmp.ctx.globalCompositeOperation = 'multiply';
			tmp.ctx.fillStyle = layer.tint;
			tmp.ctx.fillRect(0, 0, size, size);
			tmp.ctx.globalCompositeOperation = 'destination-in';
			tmp.ctx.drawImage(mask.canvas, 0, 0);
			releaseScratch(mask.canvas);
		}

		ctx.drawImage(tmp.canvas, 0, 0);
		releaseScratch(tmp.canvas);
	}

	return canvas;
}

function triggerLayeredRender(item: ItemData, size: number): void {
	const cacheKey = `layered:${item.id}:${size}`;
	if (layeredRenderCache.has(cacheKey) || layeredLoadingSet.has(cacheKey)) return;
	layeredLoadingSet.add(cacheKey);
	createLayeredCanvas(item, size)
		.then((canvas) => {
			if (!layeredRenderCache.has(cacheKey)) {
				layeredRenderCache.set(cacheKey, canvas);
				scheduleFlush(cacheKey, size);
			}
		})
		.catch(() => {})
		.finally(() => layeredLoadingSet.delete(cacheKey));
}

/**
 * Create an image element for an item. Blocks render as a 3D model (flat
 * placeholder first, upgraded in place once the model loads); layered items
 * composite their layers; everything else is a flat texture.
 */
export function createImgTag(item: ItemData, size = 48): HTMLCanvasElement | HTMLImageElement {
	if (item.renderAs === 'layered') {
		const cacheKey = `layered:${item.id}:${size}`;
		const cached = layeredRenderCache.get(cacheKey);
		if (cached) return cloneCanvas(cached);
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		trackPending(img, cacheKey);
		deferRender(img, () => triggerLayeredRender(item, size));
		return img;
	}

	if (item.renderAs === 'block' && item.modelName) {
		const cacheKey = `${item.modelName}:${size}`;
		const cached = modelRenderCache.get(cacheKey);
		if (cached) return cloneCanvas(cached);
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		const modelName = item.modelName;
		trackPending(img, cacheKey);
		deferRender(img, () => triggerModelRender(modelName, size));
		return img;
	}

	return createFlatImage(item, size);
}
