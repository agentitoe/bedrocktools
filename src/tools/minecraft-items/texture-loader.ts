// Texture Loader
// Loads and caches textures for isometric rendering

export interface Texture {
	image: HTMLImageElement;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	loaded: boolean;
}

const textureCache = new Map<string, Texture>();
const loadingPromises = new Map<string, Promise<Texture>>();

const TEXTURE_BASE = '/textures/block';

/**
 * Load a texture by name (e.g., "oak_planks", "cut_copper")
 * Returns a Texture object with image and offscreen canvas
 */
export async function loadTexture(name: string): Promise<Texture> {
	// Check cache
	if (textureCache.has(name)) {
		const cached = textureCache.get(name)!;
		if (cached.loaded) return cached;
		// If still loading, wait for it
		if (loadingPromises.has(name)) {
			return loadingPromises.get(name)!;
		}
	}

	// Check if already loading
	if (loadingPromises.has(name)) {
		return loadingPromises.get(name)!;
	}

	// Start loading
	const promise = loadTextureInternal(name);
	loadingPromises.set(name, promise);

	try {
		const texture = await promise;
		return texture;
	} finally {
		loadingPromises.delete(name);
	}
}

async function loadTextureInternal(name: string): Promise<Texture> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		// Don't set crossOrigin for same-origin images - it can cause issues
		// if the server doesn't send proper CORS headers

		// Defensive: strip any lingering namespace/folder prefix so we always
		// request the bare file name under /textures/block.
		const cleanName = name.replace(/^minecraft:/, '').replace(/^(block|item)\//, '');

		img.onload = () => {
			// Create offscreen canvas for texture sampling
			const canvas = document.createElement('canvas');
			canvas.width = img.width;
			canvas.height = img.height;
			const ctx = canvas.getContext('2d')!;
			ctx.imageSmoothingEnabled = false; // Pixelated for Minecraft
			ctx.drawImage(img, 0, 0);

			const texture: Texture = {
				image: img,
				canvas,
				ctx,
				loaded: true
			};

			textureCache.set(name, texture);
			resolve(texture);
		};

		img.onerror = () => {
			// Create placeholder texture
			const placeholder = createPlaceholderTexture(name);
			textureCache.set(name, placeholder);
			resolve(placeholder);
		};

		img.src = `${TEXTURE_BASE}/${cleanName}.webp`;
	});
}

/**
 * Create a placeholder texture for missing textures
 */
function createPlaceholderTexture(name: string): Texture {
	const size = 16;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;

	// Checkerboard pattern
	const colors = ['#888', '#666'];
	for (let y = 0; y < size; y += 4) {
		for (let x = 0; x < size; x += 4) {
			const colorIndex = ((x / 4) + (y / 4)) % 2;
			ctx.fillStyle = colors[colorIndex];
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
	img.src = canvas.toDataURL();

	return {
		image: img,
		canvas,
		ctx,
		loaded: true
	};
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
 * Preload multiple textures
 */
export async function preloadTextures(names: string[]): Promise<void> {
	await Promise.all(names.map(name => loadTexture(name).catch(() => {})));
}

/**
 * Clear texture cache
 */
export function clearTextureCache(): void {
	textureCache.clear();
	loadingPromises.clear();
}

/**
 * Check if texture is loaded
 */
export function isTextureLoaded(name: string): boolean {
	const texture = textureCache.get(name);
	return texture?.loaded ?? false;
}

/**
 * Get texture from cache (synchronous, may not be loaded yet)
 */
export function getTexture(name: string): Texture | undefined {
	return textureCache.get(name);
}