// Texture Loader
// Loads and caches textures for isometric rendering.
// Bounded LRU (cap 300), 6-slot concurrency pool for fetches, 10s Image timeout.

export interface Texture {
	image: HTMLImageElement;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	loaded: boolean;
}

/** Minimal insertion-order LRU shared by texture / render caches. */
export class LRUCache<K, V> {
	private map = new Map<K, V>();
	constructor(private cap: number = 300) {}
	get(key: K): V | undefined {
		const v = this.map.get(key);
		if (v === undefined) return undefined;
		// Refresh recency.
		this.map.delete(key);
		this.map.set(key, v);
		return v;
	}
	peek(key: K): V | undefined {
		return this.map.get(key);
	}
	set(key: K, value: V): void {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.cap) {
			const oldest = this.map.keys().next();
			if (!oldest.done) this.map.delete(oldest.value);
		}
	}
	has(key: K): boolean {
		return this.map.has(key);
	}
	delete(key: K): boolean {
		return this.map.delete(key);
	}
	clear(): void {
		this.map.clear();
	}
	get size(): number {
		return this.map.size;
	}
}

/** Shared bounded texture cache (cap 300). Imported by canvas-renderer/images. */
export const sharedTextureCache = new LRUCache<string, Texture>(300);
const textureCache: LRUCache<string, Texture> = sharedTextureCache;
const loadingPromises = new Map<string, Promise<Texture>>();

const TEXTURE_BASE = '/textures/block';
const IMAGE_TIMEOUT_MS = 10_000;

// Precompiled prefix patterns (avoid re-compiling per texture).
const MC_PREFIX_RE = /^minecraft:/;
const BLOCK_ITEM_DIR_RE = /^(block|item)\//;

// ---- Concurrency pool for texture fetches (6 slots) ----

const MAX_CONCURRENT_TEXTURES = 6;
let activeTextures = 0;
const textureQueue: Array<() => void> = [];

function pumpTextureQueue(): void {
	while (activeTextures < MAX_CONCURRENT_TEXTURES && textureQueue.length > 0) {
		const task = textureQueue.shift()!;
		activeTextures++;
		task();
	}
}

function scheduleTexture<T>(task: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		textureQueue.push(() => {
			task().then(resolve, reject).finally(() => {
				activeTextures--;
				pumpTextureQueue();
			});
		});
		pumpTextureQueue();
	});
}

/**
 * Load a texture by name (e.g., "oak_planks", "cut_copper")
 * Returns a Texture object with image and offscreen canvas
 */
export async function loadTexture(name: string): Promise<Texture> {
	// Check cache (peek avoids recency churn on hot path; get refreshes).
	const cached = textureCache.peek(name);
	if (cached && cached.loaded) {
		// Refresh recency on hit.
		textureCache.get(name);
		return cached;
	}
	// Dedupe inflight: concurrent callers share one promise.
	const inflight = loadingPromises.get(name);
	if (inflight) return inflight;

	const promise = scheduleTexture(() => loadTextureInternal(name));
	loadingPromises.set(name, promise);
	try {
		return await promise;
	} finally {
		loadingPromises.delete(name);
	}
}

function loadTextureInternal(name: string): Promise<Texture> {
	return new Promise((resolve) => {
		const img = new Image();
		// Don't set crossOrigin for same-origin images - it can cause issues
		// if the server doesn't send proper CORS headers

		// Defensive: strip any lingering namespace/folder prefix so we always
		// request the bare file name under /textures/block.
		const cleanName = name.replace(MC_PREFIX_RE, '').replace(BLOCK_ITEM_DIR_RE, '');

		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			// Timeout fallback: resolve with placeholder so renders never hang.
			resolve(cacheAndReturn(name, createPlaceholderTexture(name)));
		}, IMAGE_TIMEOUT_MS);

		const finish = (tex: Texture) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(cacheAndReturn(name, tex));
		};

		img.onload = () => {
			// Create offscreen canvas for texture sampling
			const canvas = document.createElement('canvas');
			canvas.width = img.width || 16;
			canvas.height = img.height || 16;
			const ctx = canvas.getContext('2d')!;
			ctx.imageSmoothingEnabled = false; // Pixelated for Minecraft
			try {
				ctx.drawImage(img, 0, 0);
			} catch {
				finish(createPlaceholderTexture(name));
				return;
			}
			finish({ image: img, canvas, ctx, loaded: true });
		};

		img.onerror = () => {
			finish(createPlaceholderTexture(name));
		};

		try {
			img.src = `${TEXTURE_BASE}/${cleanName}.webp`;
		} catch {
			finish(createPlaceholderTexture(name));
		}
	});
}

function cacheAndReturn(name: string, tex: Texture): Texture {
	textureCache.set(name, tex);
	return tex;
}

/**
 * Create a placeholder texture for missing textures
 */
function createPlaceholderTexture(_name: string): Texture {
	const size = 16;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;

	// Checkerboard pattern
	ctx.fillStyle = '#888';
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = '#666';
	for (let y = 0; y < size; y += 8) {
		for (let x = ((y / 4) % 2 === 0 ? 4 : 0); x < size; x += 8) {
			ctx.fillRect(x, y, 4, 4);
		}
	}

	// Add label
	ctx.fillStyle = 'rgba(0,0,0,0.7)';
	ctx.fillRect(0, size - 8, size, 8);
	ctx.fillStyle = '#fff';
	ctx.font = '6px monospace';
	ctx.textAlign = 'center';
	ctx.fillText('?', size / 2, size - 2);

	const img = new Image();
	try {
		img.src = canvas.toDataURL();
	} catch {
		// ignore
	}

	return { image: img, canvas, ctx, loaded: true };
}

/**
 * Get UV pixel coordinates from 0-16 UV space
 * Minecraft UVs are 0-16, texture is typically 16x16
 */
export function uvToPixels(texture: Texture, uv: { u: number; v: number }): { x: number; y: number } {
	const scaleX = texture.canvas.width / 16;
	const scaleY = texture.canvas.height / 16;
	return {
		x: uv.u * scaleX,
		y: uv.v * scaleY
	};
}

/**
 * Preload multiple textures (concurrency still capped at 6 by the pool).
 */
export async function preloadTextures(names: string[]): Promise<void> {
	await Promise.all(names.map((name) => loadTexture(name).catch(() => undefined)));
}

/**
 * Clear texture cache
 */
export function clearTextureCache(): void {
	textureCache.clear();
	loadingPromises.clear();
	textureQueue.length = 0;
}

/**
 * Check if texture is loaded
 */
export function isTextureLoaded(name: string): boolean {
	const texture = textureCache.peek(name);
	return texture?.loaded ?? false;
}

/**
 * Get texture from cache (synchronous, may not be loaded yet)
 */
export function getTexture(name: string): Texture | undefined {
	return textureCache.peek(name);
}
