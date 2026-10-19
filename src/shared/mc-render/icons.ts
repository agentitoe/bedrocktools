// Client-side icon factory.
//
// The UI never renders geometry when it does not have to: if the build-time
// baker produced an atlas (`public/data/icons/atlas-*.webp` + `index.json`) the
// icon is a plain `<img>` with `object-position` pointing at the right tile, so
// a 1769-item grid costs one JSON request and zero canvases.
//
// When an item has no baked entry (stale atlas, custom resource pack, hot
// reload), this module falls back to rendering it here, reusing the shared
// geometry core and the reference behaviour of
// `src/tools/minecraft-items/images.ts`: a flat placeholder goes out
// immediately, the real icon is rendered asynchronously and swapped in place
// through `data-render-key`.

import { resolveModelFaces } from './model-resolver';
import { drawLayeredTile, rasterize } from './rasterizer';
import type { FaceGeometry, RawModel, TextureTile } from './types';

/** Where the icon atlas index lives. */
export const ICON_MANIFEST_URL = '/data/icons/index.json';

/** Where the combined block-model bundle lives (parent chain resolution). */
export const MODEL_BUNDLE_URL = '/data/models/all.json';

/** Where block texture names are served from. */
const TEXTURE_BASE = '/textures/block';

/** Tile size of the textures block models sample from (0..16 tile space). */
const TEXTURE_TILE = 16;

/**
 * How many renders may be in flight at once. Loading a grid triggers hundreds
 * of icon renders; capping them keeps the browser's connection pool free for
 * everything else (the reason `canvas-renderer.ts` bounded this too).
 */
const MAX_CONCURRENT_RENDERS = 6;

export interface IconItem {
	id: number;
	renderAs?: string;
	modelName?: string;
	textureUrl?: string;
	layers?: Array<{ url: string; tint?: string }>;
}

export interface IconAtlasSize {
	url: string;
	tile: number;
	cols: number;
	rows: number;
	frames: Record<string, [number, number]>;
}

export interface IconManifest {
	tiles: number[];
	sizes: Record<string, IconAtlasSize>;
}

/* ------------------------------------------------------------------------- */
/* Module state                                                              */
/* ------------------------------------------------------------------------- */

let manifestPromise: Promise<IconManifest | null> | null = null;
let loadedManifest: IconManifest | null = null;

let modelBundlePromise: Promise<Record<string, RawModel>> | null = null;

/** Rendered canvas per `m:<model>:<size>` (block models). */
const modelRenderCache = new Map<string, HTMLCanvasElement>();

/** Rendered canvas per `item:<id>:<size>` (layered flat items). */
const layeredRenderCache = new Map<string, HTMLCanvasElement>();

/** Keys currently being rendered, so a grid of 64 identical blocks renders once. */
const renderInFlight = new Set<string>();

/** Tiles per texture reference, awaited by both render paths. */
const textureTilePromises = new Map<string, Promise<TextureTile>>();

const renderQueue: Array<() => void> = [];
let activeRenders = 0;

/* ------------------------------------------------------------------------- */
/* Manifest                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Load the icon atlas index. The fetch is memoized (a single request however
 * many times the UI asks) and a failure resolves to `null`, so a missing or
 * stale atlas degrades to the client-side renderer instead of an error.
 */
export async function loadIconManifest(): Promise<IconManifest | null> {
	manifestPromise ??= fetchIconManifest().then((manifest) => {
		loadedManifest = manifest;
		return manifest;
	});
	return manifestPromise;
}

/** Forget the memoized index (hot reload / tests). */
export function clearIconManifest(): void {
	manifestPromise = null;
	loadedManifest = null;
}

async function fetchIconManifest(): Promise<IconManifest | null> {
	try {
		const response = await fetch(ICON_MANIFEST_URL);
		if (!response.ok) return null;
		return parseManifest(await response.json());
	} catch {
		return null;
	}
}

/** Manifest keys that may identify this item: the flat sprite and its model alias. */
function iconKeys(item: IconItem): string[] {
	const keys = [String(item.id)];
	if (typeof item.modelName === 'string' && item.modelName.length > 0) {
		keys.push(`m:${item.modelName}`);
	}
	return keys;
}

interface AtlasFrame {
	atlas: IconAtlasSize;
	x: number;
	y: number;
}

/**
 * Pick the frame to draw for `keys`. Atlases are ranked by how well they match
 * the requested size: the smallest tile that is at least as large as the icon
 * wins, and when nothing is large enough the biggest atlas is used (a slightly
 * oversized tile still looks right, a shrunken one does not).
 */
function findAtlasFrame(manifest: IconManifest, keys: string[], size: number): AtlasFrame | null {
	const ranked = rankAtlases(Object.values(manifest.sizes), size);
	for (const atlas of ranked) {
		for (const key of keys) {
			const frame = atlas.frames[key];
			if (frame !== undefined) return { atlas, x: frame[0], y: frame[1] };
		}
	}
	return null;
}

function rankAtlases(sizes: IconAtlasSize[], size: number): IconAtlasSize[] {
	const sorted = [...sizes].sort((left, right) => left.tile - right.tile);
	return [...sorted.filter((atlas) => atlas.tile >= size), ...sorted.filter((atlas) => atlas.tile < size).reverse()];
}

function parseManifest(raw: unknown): IconManifest | null {
	if (!isRecord(raw)) return null;

	const tiles = Array.isArray(raw.tiles)
		? [...new Set(raw.tiles.filter((tile): tile is number => typeof tile === 'number' && tile > 0))].sort(
				(a, b) => a - b
			)
		: [];

	const sizes: Record<string, IconAtlasSize> = {};
	if (isRecord(raw.sizes)) {
		for (const [key, value] of Object.entries(raw.sizes)) {
			const atlas = parseAtlasSize(value);
			if (atlas !== null) sizes[key] = atlas;
		}
	}

	// An index without a single usable atlas is worse than no index: the caller
	// would keep refreshing a sprite it can never draw.
	return Object.keys(sizes).length > 0 ? { tiles, sizes } : null;
}

function parseAtlasSize(raw: unknown): IconAtlasSize | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.url !== 'string' || raw.url.length === 0) return null;
	if (typeof raw.tile !== 'number' || !(raw.tile > 0)) return null;
	if (typeof raw.cols !== 'number' || typeof raw.rows !== 'number') return null;

	const frames: Record<string, [number, number]> = {};
	if (isRecord(raw.frames)) {
		for (const [key, value] of Object.entries(raw.frames)) {
			if (!Array.isArray(value) || value.length < 2) continue;
			const [x, y] = value;
			if (typeof x !== 'number' || typeof y !== 'number') continue;
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			frames[key] = [x, y];
		}
	}

	return { url: raw.url, tile: raw.tile, cols: raw.cols, rows: raw.rows, frames };
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Is this item already baked at this size? Pure lookup against the manifest
 * that is loaded *now*: nothing is fetched, so the answer is simply "not yet"
 * until {@link loadIconManifest} resolves.
 */
export function hasBakedIcon(item: IconItem, size: number): boolean {
	if (loadedManifest === null || assertSize(size) <= 0) return false;
	return findAtlasFrame(loadedManifest, iconKeys(item), size) !== null;
}

/**
 * The icon for an item at a given pixel size: an atlas sprite when one exists,
 * otherwise a flat placeholder that upgrades in place once the model or the
 * layered composite finishes rendering.
 */
export function createIconElement(item: IconItem, size: number): HTMLImageElement | HTMLCanvasElement {
	assertSize(size);
	if (!isRecord(item)) throw new TypeError('createIconElement: item must be an object');

	// Kick off the index fetch; until it lands the fallback keeps the UI warm.
	void loadIconManifest();

	if (loadedManifest !== null) {
		const frame = findAtlasFrame(loadedManifest, iconKeys(item), size);
		if (frame !== null) return createAtlasSprite(frame, item, size);
	}

	return createFallbackElement(item, size);
}

/**
 * The styles every icon element carries: exact pixel layout, nearest-neighbour
 * upscaling and the soft drop shadow the grids are designed around.
 */
export function applyIconStyles(el: HTMLImageElement | HTMLCanvasElement, size: number): void {
	el.style.width = `${size}px`;
	el.style.height = `${size}px`;
	el.style.imageRendering = 'pixelated';
	el.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))';
}

/**
 * Load one block texture as a `TextureTile`.
 *
 * The reference must be either a bare texture name (`oak_log_top`, resolved
 * under `/textures/block`) or a URL as the item data stores it. Spritesheets
 * (16×N, N > 16) are cropped to their first 16×16 frame, which is the fix for
 * bug 1 of the plan: a 16×128 animated texture used to squashed the whole sheet
 * onto the face.
 */
export function loadTextureTile(reference: string): Promise<TextureTile> {
	const cached = textureTilePromises.get(reference);
	if (cached !== undefined) return cached;

	const promise = loadTextureTileInternal(reference).catch(() => createPlaceholderTile());
	textureTilePromises.set(reference, promise);
	return promise;
}

/** Forget every cached texture tile (resource-pack swap / tests). */
export function clearTextureTiles(): void {
	textureTilePromises.clear();
}

/* ------------------------------------------------------------------------- */
/* Atlas sprite                                                              */
/* ------------------------------------------------------------------------- */

function createAtlasSprite(frame: AtlasFrame, item: IconItem, size: number): HTMLImageElement {
	const img = document.createElement('img');
	img.src = frame.atlas.url;
	img.alt = iconLabel(item);
	img.width = size;
	img.height = size;
	img.style.objectFit = 'none';
	img.style.objectPosition = `-${frame.x}px -${frame.y}px`;
	applyIconStyles(img, size);
	return img;
}

/* ------------------------------------------------------------------------- */
/* Fallback rendering                                                        */
/* ------------------------------------------------------------------------- */

function createFallbackElement(item: IconItem, size: number): HTMLImageElement | HTMLCanvasElement {
	if (item.renderAs === 'layered') {
		const key = iconCacheKey('item', item.id, size);
		const cached = layeredRenderCache.get(key);
		if (cached !== undefined) return cloneCanvas(cached);

		const img = createPlaceholderImage(item, size);
		img.dataset.renderKey = key;
		deferRender(img, () => renderLayered(item, key, size));
		return img;
	}

	const modelName = item.renderAs === 'block' ? item.modelName : undefined;
	if (typeof modelName === 'string' && modelName.length > 0) {
		const key = iconCacheKey('m', modelName, size);
		const cached = modelRenderCache.get(key);
		if (cached !== undefined) return cloneCanvas(cached);

		const img = createPlaceholderImage(item, size);
		img.dataset.renderKey = key;
		deferRender(img, () => renderBlockModel(modelName, key, size));
		return img;
	}

	return createPlaceholderImage(item, size);
}

/**
 * Flat `<img>` placeholder, matching `createFlatImage` in the old renderer:
 * `textureUrl` (plus the configured fallbacks), lazy loading and the icon
 * styles, so the grid looks identical before and after the upgrade.
 */
function createPlaceholderImage(item: IconItem, size: number): HTMLImageElement {
	const img = document.createElement('img');
	img.alt = iconLabel(item);
	img.loading = 'lazy';
	img.width = size;
	img.height = size;
	if (typeof item.textureUrl === 'string' && item.textureUrl.length > 0) {
		img.src = item.textureUrl;
	}
	applyIconStyles(img, size);
	return img;
}

/**
 * Delay the (async) render until the placeholder is on screen, so off-grid
 * items never fetch a model. Errors are swallowed: the placeholder is already a
 * serviceable icon.
 */
function deferRender(img: HTMLImageElement, render: () => void): void {
	if (img.complete) {
		render();
		return;
	}
	img.addEventListener('load', render, { once: true });
}

/** Cache key used both to store the render and to find it in the DOM. */
function iconCacheKey(kind: 'item' | 'm', name: string | number, size: number): string {
	return kind === 'm' ? `m:${name}:${size}` : `item:${name}:${size}`;
}

function iconLabel(item: IconItem): string {
	if (typeof item.modelName === 'string' && item.modelName.length > 0) return item.modelName;
	return `item ${item.id}`;
}

async function renderBlockModel(modelName: string, key: string, size: number): Promise<void> {
	if (modelRenderCache.has(key) || renderInFlight.has(key)) return;
	renderInFlight.add(key);

	await enqueueRender(async () => {
		try {
			const faces = resolveModelFaces(await loadModelBundle(), modelName);
			const canvas = faces === null ? null : await paintRaster(faces, size);
			if (canvas !== null && !modelRenderCache.has(key)) {
				modelRenderCache.set(key, canvas);
				replaceInPlace(key, size, modelRenderCache);
			}
		} catch (error) {
			console.error(`[icons] render error for model ${modelName}:`, error);
		}
	});

	renderInFlight.delete(key);
}

async function renderLayered(item: IconItem, key: string, size: number): Promise<void> {
	if (layeredRenderCache.has(key) || renderInFlight.has(key)) return;
	renderInFlight.add(key);

	await enqueueRender(async () => {
		try {
			const canvas = await paintLayers(item, size);
			if (canvas !== null && !layeredRenderCache.has(key)) {
				layeredRenderCache.set(key, canvas);
				replaceInPlace(key, size, layeredRenderCache);
			}
		} catch (error) {
			console.error(`[icons] layered render error for item ${item.id}:`, error);
		}
	});

	renderInFlight.delete(key);
}

async function paintRaster(faces: FaceGeometry[] | null, size: number): Promise<HTMLCanvasElement | null> {
	if (faces === null || faces.length === 0) return null;

	const names = [...new Set(faces.map((face) => face.texture))];
	const tiles = await Promise.all(names.map((name) => loadTextureTile(name)));
	const textures = new Map<string, TextureTile>();
	names.forEach((name, index) => textures.set(name, tiles[index]));

	return paint(size, (ctx) => rasterize(ctx, faces, textures, { size }));
}

async function paintLayers(item: IconItem, size: number): Promise<HTMLCanvasElement | null> {
	const layers = item.layers ?? [];
	if (layers.length === 0) return null;

	const tiles: Array<{ tex: TextureTile; tint?: string }> = [];
	for (const layer of layers) {
		try {
			tiles.push({ tex: await loadTextureTile(layer.url), tint: layer.tint });
		} catch {
			// One unreadable layer is not a reason to lose the whole icon.
		}
	}
	if (tiles.length === 0) return null;

	return paint(size, (ctx) => drawLayeredTile(ctx, tiles, size));
}

/** A fresh size×size canvas with the raster primitives `rasterize` needs. */
function paint(size: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (ctx === null) throw new Error('icons: 2D canvas context unavailable');
	ctx.imageSmoothingEnabled = false;
	draw(ctx);
	return canvas;
}

/**
 * Swap every placeholder that waits on `key` for the rendered canvas — the
 * in-place upgrade `updateItemImageInPlace` performed, so the grid, the recipe
 * modal and any other consumer see their icon replaced without a re-render.
 */
function replaceInPlace(key: string, size: number, cache: Map<string, HTMLCanvasElement>): void {
	const canvas = cache.get(key);
	if (canvas === undefined) return;

	const selector = `[data-render-key="${key.replace(/(["\\])/g, '\\$1')}"]`;
	for (const element of Array.from(document.querySelectorAll(selector))) {
		if (!(element instanceof HTMLImageElement)) continue;

		const target = document.createElement('canvas');
		target.width = size;
		target.height = size;
		const ctx = target.getContext('2d');
		if (ctx === null) continue;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(canvas, 0, 0, size, size);
		applyIconStyles(target, size);

		element.replaceWith(target);
	}
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
	const clone = document.createElement('canvas');
	clone.width = source.width;
	clone.height = source.height;
	const ctx = clone.getContext('2d');
	if (ctx === null) return source;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 0, 0);
	applyIconStyles(clone, source.width);
	return clone;
}

/* ------------------------------------------------------------------------- */
/* Textures                                                                   */
/* ------------------------------------------------------------------------- */

/** Resolve a texture reference to a URL: bare name → `/textures/block`, else as-is. */
function textureUrl(reference: string): string {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/|\.)/i.test(reference) || reference.includes('/')) return reference;
	const name = reference.replace(/^minecraft:/, '').replace(/^(block|item)\//, '');
	return `${TEXTURE_BASE}/${name}.webp`;
}

async function loadTextureTileInternal(reference: string): Promise<TextureTile> {
	const image = await loadImage(textureUrl(reference));
	const width = image.naturalWidth || image.width;
	const height = image.naturalHeight || image.height;
	if (!(width > 0) || !(height > 0)) return createPlaceholderTile();

	// Animated block textures are 16×N sprite sheets: sample the first frame.
	if (width === TEXTURE_TILE && height > TEXTURE_TILE && height % TEXTURE_TILE === 0) {
		const canvas = document.createElement('canvas');
		canvas.width = TEXTURE_TILE;
		canvas.height = TEXTURE_TILE;
		const ctx = canvas.getContext('2d');
		if (ctx === null) return { width, height, image };
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(image, 0, 0, TEXTURE_TILE, TEXTURE_TILE, 0, 0, TEXTURE_TILE, TEXTURE_TILE);
		return { width: TEXTURE_TILE, height: TEXTURE_TILE, image: canvas };
	}

	return { width, height, image };
}

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Failed to load ${url}`));
		img.src = url;
	});
}

/** Checkerboard tile used when a texture is missing, so holes stay visible. */
function createPlaceholderTile(): TextureTile {
	const canvas = document.createElement('canvas');
	canvas.width = TEXTURE_TILE;
	canvas.height = TEXTURE_TILE;
	const ctx = canvas.getContext('2d');

	if (ctx !== null) {
		ctx.imageSmoothingEnabled = false;
		ctx.fillStyle = '#888888';
		ctx.fillRect(0, 0, TEXTURE_TILE, TEXTURE_TILE);
		ctx.fillStyle = '#666666';
		for (let y = 0; y < TEXTURE_TILE; y += 4) {
			for (let x = (y / 4) % 2 === 0 ? 0 : 4; x < TEXTURE_TILE; x += 8) {
				ctx.fillRect(x, y, 4, 4);
			}
		}
	}

	return { width: TEXTURE_TILE, height: TEXTURE_TILE, image: canvas };
}

/* ------------------------------------------------------------------------- */
/* Model bundle                                                               */
/* ------------------------------------------------------------------------- */

async function loadModelBundle(): Promise<Record<string, RawModel>> {
	modelBundlePromise ??= (async () => {
		try {
			const response = await fetch(MODEL_BUNDLE_URL);
			if (!response.ok) return {};
			const raw: unknown = await response.json();
			const bundle: Record<string, RawModel> = {};
			if (isRecord(raw)) {
				for (const [name, value] of Object.entries(raw)) {
					if (isRecord(value)) bundle[name] = toRawModel(value);
				}
			}
			return bundle;
		} catch {
			return {};
		}
	})();
	return modelBundlePromise;
}

/** Copy only the fields the resolver reads, so nothing else leaks downstream. */
function toRawModel(value: Record<string, unknown>): RawModel {
	return {
		parent: typeof value.parent === 'string' ? value.parent : undefined,
		textures: isRecord(value.textures) ? value.textures : undefined,
		elements: Array.isArray(value.elements) ? value.elements : undefined,
		display: isRecord(value.display) ? value.display : undefined
	};
}

/* ------------------------------------------------------------------------- */
/* Render queue                                                              */
/* ------------------------------------------------------------------------- */

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		renderQueue.push(() => {
			task()
				.then(resolve, reject)
				.finally(() => {
					activeRenders--;
					pumpRenderQueue();
				});
		});
		pumpRenderQueue();
	});
}

function pumpRenderQueue(): void {
	while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
		const task = renderQueue.shift();
		if (task === undefined) break;
		activeRenders++;
		task();
	}
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function assertSize(size: number): number {
	if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
		throw new TypeError(`createIconElement: size must be a positive finite number, got ${String(size)}`);
	}
	return size;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
