// Item icon rendering for the /give Command Generator.
//
// All rendering lives in the shared core (`src/shared/mc-render`): blocks with a
// model get an isometric render (atlas sprite first, client-side fallback
// otherwise), layered items composite their layers and the rest show their flat
// texture. Everything is cached inside the shared module; what stays here is the
// tool's own texture fallback chain.

import type { ItemData } from './types';
import { createIconElement } from '../../shared/mc-render/icons';
import { attachTextureFallbacks } from '../../shared/mc-render/texture-fallbacks';

const PLACEHOLDER_SVG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22 viewBox=%220 0 48 48%22%3E%3Crect fill=%22%2366%22 width=%2248%22 height=%2248%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22 font-family=%22monospace%22%3E?%3C/text%3E%3C/svg%3E";

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

/**
 * Create an image element for an item. Blocks render as a 3D model (flat
 * placeholder first, upgraded in place once the model loads); layered items
 * composite their layers; everything else is a flat texture.
 */
export function createImgTag(item: ItemData, size = 48): HTMLCanvasElement | HTMLImageElement {
	const icon = createIconElement(item, size);
	if (icon instanceof HTMLImageElement) icon.alt = item.displayName;
	attachTextureFallbacks(icon, getTextureFallbacks(item));
	return icon;
}
