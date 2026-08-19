// Item icon rendering for the /give Command Generator.
// Blocks with a model get a proper 3D isometric render (same as the Items &
// Blocks tool); layered items (potions, tipped arrows) are composited; the
// rest fall back to their flat texture. Everything is cached.

import type { ItemData } from './types';
import { renderModel } from '../minecraft-items/canvas-renderer';

const PLACEHOLDER_SVG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22 viewBox=%220 0 48 48%22%3E%3Crect fill=%22%23666%22 width=%2248%22 height=%2248%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22 font-family=%22monospace%22%3E?%3C/text%3E%3C/svg%3E";

const modelRenderCache = new Map<string, HTMLCanvasElement>();
const modelLoadingSet = new Set<string>();
const layeredRenderCache = new Map<string, HTMLCanvasElement>();
const layeredLoadingSet = new Set<string>();

/** Candidate texture URLs for an item, last one is a placeholder. */
export function getTextureFallbacks(item: ItemData): string[] {
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
	return fallbacks;
}

function createFlatImage(item: ItemData, size: number): HTMLImageElement {
	const fallbacks = getTextureFallbacks(item);
	const img = document.createElement('img');
	img.alt = item.displayName;
	img.loading = 'lazy';
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
	const ctx = clone.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 0, 0);
	return clone;
}

function updateInPlace(cacheKey: string, size: number): void {
	const canvas = modelRenderCache.get(cacheKey) || layeredRenderCache.get(cacheKey);
	if (!canvas) return;
	document.querySelectorAll(`[data-render-key="${cacheKey}"]`).forEach((el) => {
		if (!(el instanceof HTMLImageElement)) return;
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
	});
}

function triggerModelRender(modelName: string, size: number): void {
	const cacheKey = `${modelName}:${size}`;
	if (modelRenderCache.has(cacheKey) || modelLoadingSet.has(cacheKey)) return;
	modelLoadingSet.add(cacheKey);
	renderModel(modelName, { size })
		.then((canvas) => {
			if (canvas && !modelRenderCache.has(cacheKey)) {
				modelRenderCache.set(cacheKey, canvas);
				updateInPlace(cacheKey, size);
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

		const tmp = document.createElement('canvas');
		tmp.width = size;
		tmp.height = size;
		const tctx = tmp.getContext('2d')!;
		tctx.imageSmoothingEnabled = false;
		tctx.drawImage(img, 0, 0, size, size);

		if (layer.tint) {
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

function triggerLayeredRender(item: ItemData, size: number): void {
	const cacheKey = `layered:${item.id}:${size}`;
	if (layeredRenderCache.has(cacheKey) || layeredLoadingSet.has(cacheKey)) return;
	layeredLoadingSet.add(cacheKey);
	createLayeredCanvas(item, size)
		.then((canvas) => {
			if (!layeredRenderCache.has(cacheKey)) {
				layeredRenderCache.set(cacheKey, canvas);
				updateInPlace(cacheKey, size);
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
	const deferRender = (img: HTMLImageElement, fn: () => void) => {
		if (img.complete) fn();
		else img.addEventListener('load', () => fn(), { once: true });
	};

	if (item.renderAs === 'layered') {
		const cacheKey = `layered:${item.id}:${size}`;
		const cached = layeredRenderCache.get(cacheKey);
		if (cached) return cloneCanvas(cached);
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		deferRender(img, () => triggerLayeredRender(item, size));
		return img;
	}

	if (item.renderAs === 'block' && item.modelName) {
		const cacheKey = `${item.modelName}:${size}`;
		const cached = modelRenderCache.get(cacheKey);
		if (cached) return cloneCanvas(cached);
		const img = createFlatImage(item, size);
		img.dataset.renderKey = cacheKey;
		deferRender(img, () => triggerModelRender(item.modelName!, size));
		return img;
	}

	return createFlatImage(item, size);
}
