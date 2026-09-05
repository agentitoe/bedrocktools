import type { ItemData } from './types';
import { getItemName, getTextureFallbacks } from './data';
import { renderModel, canRenderModel } from './canvas-renderer';
import { LRUCache } from './texture-loader';

// Unified bounded render cache (cap 300): layered + 3D model canvases share
// one LRU. Keys are namespaced (`layered:<id>:<size>` vs `<model>:<size>`).
const unifiedRenderCache = new LRUCache<string, HTMLCanvasElement>(300);
// In-flight render dedupe: one promise per cacheKey.
const renderInflight = new Map<string, Promise<void>>();
// Placeholders waiting for an upgrade, registered directly (no global query).
const pendingElements = new Map<string, Set<HTMLImageElement>>();
const flushScheduled = new Set<string>();

const IMAGE_TIMEOUT_MS = 10_000;

function loadImageElement(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`Timed out loading ${url}`));
		}, IMAGE_TIMEOUT_MS);
		img.onload = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(img);
		};
		img.onerror = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Failed to load ${url}`));
		};
		try {
			img.src = url;
		} catch (e) {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		}
	});
}

/**
 * Composite a layered flat item (e.g. potion = tinted liquid + bottle) onto a canvas.
 */
async function createLayeredCanvas(item: ItemData, size: number): Promise<HTMLCanvasElement> {
	const layers = item.layers || [];
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;

	for (const layer of layers) {
		let img: HTMLImageElement;
		try {
			img = await loadImageElement(layer.url);
		} catch {
			continue;
		}

		const tmp = document.createElement('canvas');
		tmp.width = size;
		tmp.height = size;
		const tctx = tmp.getContext('2d')!;
		tctx.imageSmoothingEnabled = false;
		tctx.drawImage(img, 0, 0, size, size);

		if (layer.tint) {
			// Tint like Minecraft: multiply the grayscale layer's RGB, keeping its
			// alpha so the silhouette (and any shading) is preserved.
			const alphaMask = document.createElement('canvas');
			alphaMask.width = size;
			alphaMask.height = size;
			alphaMask.getContext('2d')!.drawImage(tmp, 0, 0);
			tctx.globalCompositeOperation = 'multiply';
			tctx.fillStyle = layer.tint;
			tctx.fillRect(0, 0, size, size);
			tctx.globalCompositeOperation = 'destination-in';
			tctx.drawImage(alphaMask, 0, 0);
		}

		ctx.drawImage(tmp, 0, 0);
	}

	return canvas;
}

// ---- Lazy 3D upgrade: only when the placeholder is actually visible ----

let lazyObserver: IntersectionObserver | null = null;
const observerTargets = new Map<HTMLImageElement, () => void>();

function getLazyObserver(): IntersectionObserver | null {
	if (typeof IntersectionObserver === 'undefined') return null;
	if (lazyObserver) return lazyObserver;
	try {
		lazyObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const el = entry.target as HTMLImageElement;
					const trigger = observerTargets.get(el);
					if (trigger) {
						observerTargets.delete(el);
						lazyObserver?.unobserve(el);
						trigger();
					}
				}
			},
			{ rootMargin: '200px' }
		);
	} catch {
		return null;
	}
	return lazyObserver;
}

function observeLazy(img: HTMLImageElement, trigger: () => void): void {
	const io = getLazyObserver();
	if (!io) {
		// No IntersectionObserver (tests/SSR): upgrade on load like before.
		if (img.complete) trigger();
		else img.addEventListener('load', trigger, { once: true });
		return;
	}
	observerTargets.set(img, trigger);
	io.observe(img);
	// If the image already completed and is in viewport, trigger soon.
	if (img.complete) {
		queueMicrotask(() => {
			if (!observerTargets.has(img)) return;
			// Still let the observer decide; but if already intersecting, fire.
			// Fallback: fire directly when the element is already visible.
			try {
				const r = img.getBoundingClientRect();
				const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
				if (r.top < vh + 200 && r.bottom > -200) {
					observerTargets.delete(img);
					io.unobserve(img);
					trigger();
				}
			} catch {
				// ignore, observer will fire
			}
		});
	}
}

/**
 * Create image tag for an item - uses 3D isometric rendering for block items with models.
 * Dedupes concurrent renders per cacheKey.
 */
async function createItemImage(item: ItemData, size: number = 48): Promise<HTMLCanvasElement | HTMLImageElement> {
	// For layered flat items (potions, tipped arrows), composite the layers.
	if (item.renderAs === 'layered') {
		const cacheKey = `layered:${item.id}:${size}`;
		const hit = unifiedRenderCache.peek(cacheKey);
		if (hit) {
			unifiedRenderCache.get(cacheKey);
			return hit;
		}
		if (!renderInflight.has(cacheKey)) {
			const p = (async (): Promise<void> => {
				try {
					const canvas = await createLayeredCanvas(item, size);
					if (!unifiedRenderCache.peek(cacheKey)) {
						unifiedRenderCache.set(cacheKey, canvas);
						scheduleFlush(cacheKey, size);
					}
				} catch {
					// keep flat placeholder
				}
			})();
			renderInflight.set(cacheKey, p);
			try {
				await p;
			} finally {
				renderInflight.delete(cacheKey);
			}
		} else {
			try {
				await renderInflight.get(cacheKey);
			} catch {
				// ignore
			}
		}
		return createFlatImage(item, size);
	}

	// For block-model items, try to render 3D model
	const modelName = item.renderAs === 'block' ? item.modelName : undefined;
	if (modelName) {
		const cacheKey = `${modelName}:${size}`;

		// Check cache
		const hit = unifiedRenderCache.peek(cacheKey);
		if (hit) {
			unifiedRenderCache.get(cacheKey);
			return hit;
		}

		// Render in background if not already in progress
		if (!renderInflight.has(cacheKey)) {
			const p = (async (): Promise<void> => {
				try {
					const canRender = await canRenderModel(modelName);
					if (canRender) {
						const canvas = await renderModel(modelName, { size });
						if (canvas && !unifiedRenderCache.peek(cacheKey)) {
							unifiedRenderCache.set(cacheKey, canvas);
							scheduleFlush(cacheKey, size);
						}
					}
				} catch (err) {
					console.error(`[createItemImage] render error for ${modelName}:`, err);
				}
			})();
			renderInflight.set(cacheKey, p);
			try {
				await p;
			} finally {
				renderInflight.delete(cacheKey);
			}
		} else {
			try {
				await renderInflight.get(cacheKey);
			} catch {
				// ignore
			}
		}
	}

	// Fallback to flat texture (create img element)
	return createFlatImage(item, size);
}

/** rAF-batched in-place upgrade using directly registered elements (no querySelectorAll). */
function scheduleFlush(cacheKey: string, size: number): void {
	if (flushScheduled.has(cacheKey)) return;
	flushScheduled.add(cacheKey);
	const run = () => {
		flushScheduled.delete(cacheKey);
		updateItemImageInPlace(cacheKey, size);
	};
	if (typeof requestAnimationFrame !== 'undefined') {
		requestAnimationFrame(run);
	} else {
		run();
	}
}

/**
 * Update every placeholder image in-place once its 3D render completes.
 * Uses the directly registered placeholder elements (no global querySelectorAll).
 */
function updateItemImageInPlace(cacheKey: string, size: number): void {
	const canvas = unifiedRenderCache.peek(cacheKey);
	if (!canvas) return;
	const set = pendingElements.get(cacheKey);
	if (!set || set.size === 0) return;
	pendingElements.delete(cacheKey);

	for (const el of set) {
		try {
			// Skip detached or repurposed placeholders.
			if (!el.isConnected) continue;
			if (el.dataset.renderKey !== cacheKey) continue;
			const newCanvas = document.createElement('canvas');
			newCanvas.width = size;
			newCanvas.height = size;
			const newCtx = newCanvas.getContext('2d')!;
			newCtx.imageSmoothingEnabled = false;
			newCtx.drawImage(canvas, 0, 0, size, size);
			newCanvas.style.width = `${size}px`;
			newCanvas.style.height = `${size}px`;
			newCanvas.style.imageRendering = 'pixelated';
			newCanvas.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))';
			el.replaceWith(newCanvas);
		} catch {
			// ignore detached nodes
		}
	}
}

/**
 * Create flat image element (original behavior)
 */
function createFlatImage(item: ItemData, size: number = 48): HTMLImageElement {
	const fallbacks = getTextureFallbacks(item);

	const img = document.createElement('img');
	img.alt = getItemName(item);
	img.loading = 'lazy';
	img.width = size;
	img.height = size;

	// Fall back through candidate textures until one loads (last is an SVG placeholder)
	let fallbackIndex = 0;
	img.onerror = () => {
		fallbackIndex++;
		if (fallbackIndex < fallbacks.length) {
			img.src = fallbacks[fallbackIndex];
		} else {
			img.onerror = null;
		}
	};
	img.src = fallbacks[0];

	return img;
}

/**
 * Synchronous version for immediate rendering (used in grid)
 * Returns canvas if cached, otherwise creates flat image AND triggers async 3D load
 */
export function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
	const clone = document.createElement('canvas');
	clone.width = source.width;
	clone.height = source.height;
	const ctx = clone.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 0, 0);
	return clone;
}

export function createImgTag(item: ItemData, size: number = 48): HTMLCanvasElement | HTMLImageElement {
	// Defer the (async) 3D/layered render until the flat placeholder is near
	// the viewport, so off-screen items don't trigger model/texture fetches.
	// The flat placeholder renders immediately.
	const deferRender = (img: HTMLImageElement, cacheKey: string) => {
		let set = pendingElements.get(cacheKey);
		if (!set) {
			set = new Set<HTMLImageElement>();
			pendingElements.set(cacheKey, set);
		}
		set.add(img);
		observeLazy(img, () => {
			void createItemImage(item, size);
		});
	};

	// For layered items, check the unified render cache
	if (item.renderAs === 'layered') {
		const cacheKey = `layered:${item.id}:${size}`;
		const cached = unifiedRenderCache.peek(cacheKey);
		if (cached) {
			unifiedRenderCache.get(cacheKey);
			return cloneCanvas(cached);
		}
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		deferRender(img, cacheKey);
		return img;
	}

	// For block-model items, check if we have a cached 3D render
	const modelName = item.renderAs === 'block' ? item.modelName : undefined;
	if (modelName) {
		const cacheKey = `${modelName}:${size}`;
		const cached = unifiedRenderCache.peek(cacheKey);
		if (cached) {
			unifiedRenderCache.get(cacheKey);
			return cloneCanvas(cached);
		}
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		deferRender(img, cacheKey);
		return img;
	}

	// Return flat image immediately
	return createFlatImage(item, size);
}
