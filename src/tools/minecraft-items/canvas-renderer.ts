// Canvas renderer — compatibility shim over the shared render core.
//
// This file used to carry the whole pipeline (model parser, texture loader,
// isometric projector plus its own concurrency queue). All of that now lives in
// `src/shared/mc-render`, so what is left is the adapter that turns "a model
// name" into "a canvas": fetch the model bundle, resolve it to faces, load the
// textures those faces sample and let `rasterize` paint them.

import { resolveModelFaces } from '../../shared/mc-render/model-resolver';
import { rasterize } from '../../shared/mc-render/rasterizer';
import {
	MODEL_BUNDLE_URL,
	clearIconManifest,
	clearTextureTiles,
	loadTextureTile
} from '../../shared/mc-render/icons';
import type { RawModel, TextureTile } from '../../shared/mc-render/types';

export interface RenderOptions {
	size?: number;            // Canvas size (default 48)
	padding?: number;         // Padding around the model (shared core default: 2)
	backgroundColor?: string; // Background color (default 'transparent')
}

/**
 * The combined block-model bundle, one memoized request shared by every render.
 *
 * `icons.ts` keeps its own copy of this load private; the shim therefore reads
 * the very same URL it exports (`MODEL_BUNDLE_URL`) so both paths always see the
 * same models. The resolver validates every field at runtime, so the raw JSON
 * can be handed over as-is.
 */
let modelBundlePromise: Promise<Record<string, RawModel>> | null = null;

function loadModelBundle(): Promise<Record<string, RawModel>> {
	modelBundlePromise ??= (async () => {
		try {
			const response = await fetch(MODEL_BUNDLE_URL);
			if (!response.ok) return {};
			const raw: unknown = await response.json();
			return isRecord(raw) ? (raw as Record<string, RawModel>) : {};
		} catch {
			return {};
		}
	})();
	return modelBundlePromise;
}

/**
 * Render a model to an offscreen canvas. Resolves to `null` when the model is
 * missing or unusable, so callers keep their flat texture as the fallback.
 */
export function renderModel(
	modelName: string,
	options: RenderOptions = {}
): Promise<HTMLCanvasElement | null> {
	return renderToCanvas(modelName, options.size ?? 48, options.padding, options.backgroundColor);
}

async function renderToCanvas(
	modelName: string,
	size: number,
	padding: number | undefined,
	backgroundColor: string | undefined
): Promise<HTMLCanvasElement | null> {
	try {
		const faces = resolveModelFaces(await loadModelBundle(), modelName);
		if (faces === null) return null;

		const names = [...new Set(faces.map((face) => face.texture))];
		const tiles = await Promise.all(names.map((name) => loadTextureTile(name)));
		const textures = new Map<string, TextureTile>();
		names.forEach((name, index) => textures.set(name, tiles[index]));

		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		if (ctx === null) return null;

		ctx.imageSmoothingEnabled = false;
		if (backgroundColor !== undefined && backgroundColor !== 'transparent') {
			ctx.fillStyle = backgroundColor;
			ctx.fillRect(0, 0, size, size);
		}

		rasterize(ctx, faces, textures, { size, padding });
		return canvas;
	} catch (error) {
		console.error(`[renderModel] Failed to render model ${modelName}:`, error);
		return null;
	}
}

/**
 * Render a model and return it as a data URL for an `<img>` src.
 */
export async function renderModelToDataURL(
	modelName: string,
	options: RenderOptions = {}
): Promise<string | null> {
	const canvas = await renderModel(modelName, options);
	if (!canvas) return null;
	return canvas.toDataURL('image/png');
}

/**
 * Forget every memoized render input (atlas index, texture tiles and model
 * bundle), which is what a resource-pack swap or a test needs.
 */
export function clearRenderCache(): void {
	clearIconManifest();
	clearTextureTiles();
	modelBundlePromise = null;
}

/**
 * Whether a model resolves to at least one drawable face.
 */
export async function canRenderModel(modelName: string): Promise<boolean> {
	try {
		return resolveModelFaces(await loadModelBundle(), modelName) !== null;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
