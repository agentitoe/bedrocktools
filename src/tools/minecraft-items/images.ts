import type { ItemData } from './types';
import { getItemName, getTextureFallbacks } from './data';
import { renderModel, canRenderModel } from './canvas-renderer';

// Render cache for 3D models
const modelRenderCache = new Map<string, HTMLCanvasElement>();
const modelLoadingSet = new Set<string>();

// Render cache for layered flat items (potions, tipped arrows, ...)
const layeredRenderCache = new Map<string, HTMLCanvasElement>();
const layeredLoadingSet = new Set<string>();

function loadImageElement(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Failed to load ${url}`));
		img.src = url;
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

/**
 * Create image tag for an item - uses 3D isometric rendering for block items with models
 */
async function createItemImage(item: ItemData, size: number = 48): Promise<HTMLCanvasElement | HTMLImageElement> {
	// For layered flat items (potions, tipped arrows), composite the layers.
	if (item.renderAs === 'layered') {
		const cacheKey = `layered:${item.id}:${size}`;
		if (layeredRenderCache.has(cacheKey)) return layeredRenderCache.get(cacheKey)!;
		if (!layeredLoadingSet.has(cacheKey)) {
			layeredLoadingSet.add(cacheKey);
			try {
				const canvas = await createLayeredCanvas(item, size);
				if (!layeredRenderCache.has(cacheKey)) {
					layeredRenderCache.set(cacheKey, canvas);
					updateItemImageInPlace(cacheKey, size);
				}
			} finally {
				layeredLoadingSet.delete(cacheKey);
			}
		}
		return createFlatImage(item, size);
	}

	// For block-model items, try to render 3D model
	const modelName = item.renderAs === 'block' ? item.modelName : undefined;
	if (modelName) {
		const cacheKey = `${modelName}:${size}`;

		// Check cache
		if (modelRenderCache.has(cacheKey)) {
			return modelRenderCache.get(cacheKey)!;
		}

		// Render in background if not already in progress
		if (!modelLoadingSet.has(cacheKey)) {
			modelLoadingSet.add(cacheKey);
			try {
				const canRender = await canRenderModel(modelName);
				if (canRender) {
					const canvas = await renderModel(modelName, { size });
					if (canvas && !modelRenderCache.has(cacheKey)) {
						modelRenderCache.set(cacheKey, canvas);
						updateItemImageInPlace(cacheKey, size);
					}
				}
			} catch (err) {
				console.error(`[createItemImage] render error for ${modelName}:`, err);
			} finally {
				modelLoadingSet.delete(cacheKey);
			}
		}
	}

	// Fallback to flat texture (create img element)
	return createFlatImage(item, size);
}

/**
 * Update every placeholder image in-place once its 3D render completes.
 * Targets any <img> tagged with data-render-key (grid cards and recipe modal).
 */
function updateItemImageInPlace(cacheKey: string, size: number): void {
	const canvas = modelRenderCache.get(cacheKey) || layeredRenderCache.get(cacheKey);
	if (!canvas) return;

	const placeholders = document.querySelectorAll(`[data-render-key="${cacheKey}"]`);
	for (const el of Array.from(placeholders)) {
		if (!(el instanceof HTMLImageElement)) continue;

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
	// Defer the (async) 3D/layered render until the flat placeholder actually
	// loads, so off-screen items don't trigger model/texture fetches.
	const deferRender = (img: HTMLImageElement) => {
		if (img.complete) {
			void createItemImage(item, size);
		} else {
			img.addEventListener('load', () => void createItemImage(item, size), { once: true });
		}
	};

	// For layered items, check the layered render cache
	if (item.renderAs === 'layered') {
		const cacheKey = `layered:${item.id}:${size}`;
		const cached = layeredRenderCache.get(cacheKey);
		if (cached) return cloneCanvas(cached);
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		deferRender(img);
		return img;
	}

	// For block-model items, check if we have a cached 3D render
	const modelName = item.renderAs === 'block' ? item.modelName : undefined;
	if (modelName) {
		const cacheKey = `${modelName}:${size}`;
		const cached = modelRenderCache.get(cacheKey);
		if (cached) {
			return cloneCanvas(cached);
		}
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		deferRender(img);
		return img;
	}

	// Return flat image immediately
	return createFlatImage(item, size);
}
