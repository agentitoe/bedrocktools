// Item icons for the Items & Blocks tool.
//
// The rendering itself lives in the shared core (`src/shared/mc-render`):
// `createIconElement` returns a baked atlas sprite whenever the build produced
// one and otherwise falls back to the client-side renderer (same geometry, same
// shading, same in-place upgrade through `data-render-key`). What stays here is
// tool-specific glue: the localized `alt` text and the texture fallback chain
// declared in `./data`.

import type { ItemData } from './types';
import { getItemName, getTextureFallbacks } from './data';
import { attachTextureFallbacks } from '../../shared/mc-render/texture-fallbacks';
import { createIconElement } from '../../shared/mc-render/icons';

/** Copy a rendered canvas, so a caller can never mutate a shared cache entry. */
export function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
	const clone = document.createElement('canvas');
	clone.width = source.width;
	clone.height = source.height;
	const ctx = clone.getContext('2d');
	if (ctx === null) return source;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 0, 0);
	return clone;
}

/**
 * The icon for an item at a given pixel size: an atlas sprite, the flat
 * texture, or a placeholder that upgrades in place once the model renders.
 */
export function createImgTag(item: ItemData, size: number = 48): HTMLCanvasElement | HTMLImageElement {
	// `ItemData` is structurally an `IconItem`; the shared factory only reads the
	// render-relevant fields (id, renderAs, modelName, textureUrl, layers).
	const icon = createIconElement(item, size);
	if (icon instanceof HTMLImageElement) icon.alt = getItemName(item);
	attachTextureFallbacks(icon, getTextureFallbacks(item));
	return icon;
}
