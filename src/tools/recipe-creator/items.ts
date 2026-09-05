import type { AnyItem, CustomItemData, ItemData } from './types';
import {
	allItems,
	customItems,
	currentLang,
	allocateCustomId,
	registerCustomItem,
	indexedGetById,
	vanillaGetByName,
	customGetByIdentifier,
} from './state';
import { titleCase } from './util';
import { renderModel } from '../minecraft-items/canvas-renderer';

// ---- Item rendering (reuses minecraft-items models + textures) ----

const CACHE_CAP = 300;

/** Minimal bounded LRU built on `Map` insertion order. */
class LruCache<K, V> {
	private readonly cap: number;
	private readonly map = new Map<K, V>();
	constructor(cap: number) { this.cap = cap; }
	get(key: K): V | undefined {
		const v = this.map.get(key);
		if (v !== undefined) {
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}
	has(key: K): boolean { return this.map.has(key); }
	set(key: K, value: V): void {
		if (this.map.has(key)) this.map.delete(key);
		else if (this.map.size >= this.cap) {
			const oldest = this.map.keys().next();
			if (!oldest.done) this.map.delete(oldest.value);
		}
		this.map.set(key, value);
	}
}

const modelRenderCache = new LruCache<string, HTMLCanvasElement>(CACHE_CAP);
const modelLoadingSet = new Set<string>();

const PLACEHOLDER_SVG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22 viewBox=%220 0 48 48%22%3E%3Crect fill=%22%23666%22 width=%2248%22 height=%2248%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22 font-family=%22monospace%22%3E?%3C/text%3E%3C/svg%3E";

// Cache for `getItemName` (keyed by id + language; display names are static).
const nameCache = new LruCache<string, string>(2000);

export function getItemName(item: AnyItem): string {
	const key = `${item.id}:${currentLang}`;
	const hit = nameCache.get(key);
	if (hit !== undefined) return hit;
	const name = currentLang === 'es' && item.displayNameEs ? item.displayNameEs : item.displayName;
	nameCache.set(key, name);
	return name;
}

export function getItemById(id: number | null): AnyItem | undefined {
	if (id == null) return undefined;
	const fast = indexedGetById(id);
	if (fast !== undefined) return fast;
	// Fallback for items registered outside the index (defensive; same result).
	if (id >= 0) return allItems.find((i) => i.id === id);
	return customItems.find((i) => i.id === id);
}

export function getItemIdentifier(item: AnyItem): string {
	if ('name' in item) return 'minecraft:' + item.name;
	return item.identifier;
}

/** Resolve a full identifier ("minecraft:stone" or "mypack:thing") to an AnyItem. */
export function findItemByIdentifier(identifier: string): AnyItem | undefined {
	if (!identifier) return undefined;
	const lower = identifier.toLowerCase();
	if (lower.startsWith('minecraft:')) {
		return vanillaGetByName(lower.slice('minecraft:'.length));
	}
	return customGetByIdentifier(identifier);
}

/** Get an existing custom item, or register a new one (negative id, no collision with vanilla). */
export function getOrCreateCustomItem(identifier: string, kind: 'item' | 'block', textureUrl?: string): CustomItemData {
	const existing = customGetByIdentifier(identifier);
	if (existing) {
		if (textureUrl && !existing.textureUrl) existing.textureUrl = textureUrl;
		if (existing.kind === 'item' && kind === 'block') existing.kind = 'block';
		return existing;
	}
	const fallback = identifier.split(':').pop() || identifier;
	const item: CustomItemData = {
		id: allocateCustomId(),
		identifier,
		displayName: titleCase(fallback.replace(/[_-]/g, ' ')),
		kind,
		textureUrl
	};
	registerCustomItem(item);
	return item;
}

/** Resolve an identifier string to a numeric item id (creating a custom entry for unknown ids). */
export function resolveItemId(identifier: string): number {
	const existing = findItemByIdentifier(identifier);
	if (existing) return existing.id;
	return getOrCreateCustomItem(identifier, 'item').id;
}

/** Extract an item identifier from a value that may be a plain string or an { "item" / "id" / "name" } object. */
export function extractItemIdentifier(value: any): string | null {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		if (typeof value.id === 'string') return value.id;
		if (typeof value.item === 'string') return value.item;
		if (typeof value.name === 'string') return value.name;
	}
	return null;
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

function createFlatImage(item: AnyItem, size: number): HTMLImageElement {
	const img = document.createElement('img');
	img.alt = getItemName(item);
	img.loading = 'lazy';
	img.decoding = 'async';
	img.width = size;
	img.height = size;
	img.style.imageRendering = 'pixelated';
	img.onerror = () => {
		img.onerror = null;
		img.src = PLACEHOLDER_SVG;
	};
	img.src = (item as ItemData).textureUrl || (item as CustomItemData).textureUrl || PLACEHOLDER_SVG;
	return img;
}

// Placeholders waiting for an upgrade, registered directly (no global query).
const pendingElements = new Map<string, Set<HTMLImageElement>>();
const flushScheduled = new Set<string>();

function updateInPlace(cacheKey: string, size: number): void {
	const canvas = modelRenderCache.get(cacheKey);
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

/** Defer the 3D render until the placeholder is loaded and visible. */
function deferModelRender(img: HTMLImageElement, modelName: string, size: number): void {
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		triggerModelRender(modelName, size);
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
			setTimeout(() => { io.disconnect(); start(); }, 4000);
		} catch {
			start();
		}
	};
	// Defer the 3D render until the flat texture actually loads (browsers
	// lazy-load images), so off-screen items don't fetch models/textures.
	if (img.complete) {
		onLoaded();
	} else {
		img.addEventListener('load', onLoaded, { once: true });
	}
}

export function createImgTag(item: AnyItem, size = 48): HTMLCanvasElement | HTMLImageElement {
	if ('modelName' in item && item.renderAs === 'block' && item.modelName) {
		const modelName = item.modelName;
		const cacheKey = `${modelName}:${size}`;
		const cached = modelRenderCache.get(cacheKey);
		if (cached) return cloneCanvas(cached);

		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		trackPending(img, cacheKey);
		deferModelRender(img, modelName, size);
		return img;
	}
	return createFlatImage(item, size);
}
