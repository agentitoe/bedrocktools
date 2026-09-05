// Canvas Renderer
// Renders Minecraft models to 2D canvas using isometric projection.
// Bounded LRU render cache (cap 300, shared implementation with texture-loader),
// 6-slot render pool; texture fetches reuse the texture pool (cap 6).

import { parseModel } from './model-parser';
import { projectFaces, sortFacesByDepth, fitToCanvas, type ProjectedFace } from './isometric-projector';
import { loadTexture, uvToPixels, LRUCache, type Texture } from './texture-loader';

const renderCache = new LRUCache<string, HTMLCanvasElement>(300);

export interface RenderOptions {
	size?: number;           // Canvas size (default 48)
	padding?: number;        // Padding around model (default 4)
	backgroundColor?: string; // Background color (default 'transparent')
}

// Bound the number of concurrent renders so loading many blocks at once doesn't
// saturate the browser's connection pool (which stalls every other request).
const MAX_CONCURRENT_RENDERS = 6;
let activeRenders = 0;
const renderQueue: Array<() => void> = [];

function pumpRenderQueue(): void {
	while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
		const task = renderQueue.shift()!;
		activeRenders++;
		task();
	}
}

function scheduleRender<T>(task: () => Promise<T>): Promise<T> {
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

/**
 * Render a model to an offscreen canvas
 */
export function renderModel(
	modelName: string,
	options: RenderOptions = {}
): Promise<HTMLCanvasElement | null> {
	const size = options.size || 48;
	const cacheKey = `${modelName}:${size}`;

	// Check cache (peek avoids churn; get refreshes recency on hit)
	const hit = renderCache.peek(cacheKey);
	if (hit) {
		renderCache.get(cacheKey);
		return Promise.resolve(hit);
	}

	return scheduleRender(() => doRenderModel(modelName, options));
}

async function doRenderModel(modelName: string, options: RenderOptions): Promise<HTMLCanvasElement | null> {
	const size = options.size || 48;
	const cacheKey = `${modelName}:${size}`;
	const hit = renderCache.peek(cacheKey);
	if (hit) return hit;

	try {
		// Parse model
		const model = await parseModel(modelName);
		if (!model || model.faces.length === 0) {
			return null;
		}

		// Project to 2D
		const projectedRaw = projectFaces(model.faces);

		// Sort by depth (painter's algorithm)
		const projectedSorted = sortFacesByDepth(projectedRaw);

		// Fit to canvas
		const projected = fitToCanvas(projectedSorted, size, options.padding || 4);

		// Create canvas
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d')!;

		// Disable image smoothing for pixel art
		ctx.imageSmoothingEnabled = false;

		// Draw background if specified
		if (options.backgroundColor && options.backgroundColor !== 'transparent') {
			ctx.fillStyle = options.backgroundColor;
			ctx.fillRect(0, 0, size, size);
		}

		// Load all required textures (deduped + pool-capped inside loadTexture).
		const textureRefs: string[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < projected.length; i++) {
			const r = projected[i].textureRef;
			if (!seen.has(r)) {
				seen.add(r);
				textureRefs.push(r);
			}
		}
		const textures = await Promise.all(
			textureRefs.map((ref) => loadTexture(ref).catch(() => undefined as unknown as Texture))
		);
		const textureMap = new Map<string, Texture | undefined>();
		for (let i = 0; i < textureRefs.length; i++) textureMap.set(textureRefs[i], textures[i]);

		// Draw each face (sync; drawFace no longer async)
		for (let i = 0; i < projected.length; i++) {
			drawFace(ctx, projected[i], textureMap.get(projected[i].textureRef));
		}

		// Cache result (bounded LRU)
		renderCache.set(cacheKey, canvas);
		return canvas;
	} catch (error) {
		// Silently fail, caller will fall back
		console.error(`[renderModel] Failed to render model ${modelName}:`, error);
		return null;
	}
}

/**
 * Minecraft "side" GUI lighting: each face gets a fixed brightness based on
 * its direction. Top is brightest, bottom darkest, north/south in between and
 * east/west darker still. This is what gives inventory blocks their 3D look.
 */
function getFaceShade(normal: { x: number; y: number; z: number }): number {
	if (normal.y > 0.5) return 1.0;   // up
	if (normal.y < -0.5) return 0.5;  // down
	if (Math.abs(normal.z) > 0.5) return 0.8; // north / south
	return 0.6;                        // east / west
}

/**
 * Draw a single face to canvas
 * Uses a quadrilateral draw approach (divide into 2 triangles)
 */
function drawFace(
	ctx: CanvasRenderingContext2D,
	face: ProjectedFace,
	texture: Texture | undefined
): void {
	if (!texture || !texture.loaded || face.vertices.length !== 4) {
		return;
	}

	const v0 = face.vertices[0];
	const v1 = face.vertices[1];
	const v2 = face.vertices[2];
	const v3 = face.vertices[3];
	const uv0 = face.uv[0];
	const uv1 = face.uv[1];
	const uv2 = face.uv[2];
	const uv3 = face.uv[3];
	if (!uv0 || !uv1 || !uv2 || !uv3) return;

	// Convert UV to pixel coordinates (stack values, no array allocs)
	const scaleX = texture.canvas.width / 16;
	const scaleY = texture.canvas.height / 16;
	const p0x = uv0.u * scaleX, p0y = uv0.v * scaleY;
	const p1x = uv1.u * scaleX, p1y = uv1.v * scaleY;
	const p2x = uv2.u * scaleX, p2y = uv2.v * scaleY;
	const p3x = uv3.u * scaleX, p3y = uv3.v * scaleY;

	// Draw face as two triangles using drawImage with clipping
	// Triangle 1: v0, v1, v2
	// Triangle 2: v0, v2, v3

	ctx.save();

	// Triangle 1
	ctx.beginPath();
	ctx.moveTo(v0.x, v0.y);
	ctx.lineTo(v1.x, v1.y);
	ctx.lineTo(v2.x, v2.y);
	ctx.closePath();
	ctx.clip();

	// Map texture to triangle using transform
	drawTexturedTriangleCoords(ctx, texture.canvas,
		p0x, p0y, p1x, p1y, p2x, p2y,
		v0.x, v0.y, v1.x, v1.y, v2.x, v2.y);

	ctx.restore();

	ctx.save();

	// Triangle 2
	ctx.beginPath();
	ctx.moveTo(v0.x, v0.y);
	ctx.lineTo(v2.x, v2.y);
	ctx.lineTo(v3.x, v3.y);
	ctx.closePath();
	ctx.clip();

	drawTexturedTriangleCoords(ctx, texture.canvas,
		p0x, p0y, p2x, p2y, p3x, p3y,
		v0.x, v0.y, v2.x, v2.y, v3.x, v3.y);

	ctx.restore();

	// Apply directional shading (Minecraft side lighting)
	const shade = getFaceShade(face.normal);
	if (shade < 1) {
		ctx.save();
		ctx.beginPath();
		ctx.moveTo(v0.x, v0.y);
		ctx.lineTo(v1.x, v1.y);
		ctx.lineTo(v2.x, v2.y);
		ctx.lineTo(v3.x, v3.y);
		ctx.closePath();
		ctx.fillStyle = `rgba(0, 0, 0, ${(1 - shade).toFixed(3)})`;
		ctx.fill();
		ctx.restore();
	}
}

/**
 * Draw a texture mapped to a triangle (scalar coords, no object allocs).
 * Uses a 2D affine transformation
 */
function drawTexturedTriangleCoords(
	ctx: CanvasRenderingContext2D,
	textureCanvas: HTMLCanvasElement,
	t0x: number, t0y: number,
	t1x: number, t1y: number,
	t2x: number, t2y: number,
	v0x: number, v0y: number,
	v1x: number, v1y: number,
	v2x: number, v2y: number
): void {
	const det = (t1x - t0x) * (t2y - t0y) - (t1y - t0y) * (t2x - t0x);
	if (Math.abs(det) < 0.001) return; // Degenerate triangle

	const a = ((v1x - v0x) * (t2y - t0y) - (v2x - v0x) * (t1y - t0y)) / det;
	const b = ((v2x - v0x) * (t1x - t0x) - (v1x - v0x) * (t2x - t0x)) / det;
	const c = v0x - a * t0x - b * t0y;

	const d = ((v1y - v0y) * (t2y - t0y) - (v2y - v0y) * (t1y - t0y)) / det;
	const e = ((v2y - v0y) * (t1x - t0x) - (v1y - v0y) * (t2x - t0x)) / det;
	const f = v0y - d * t0x - e * t0y;

	ctx.transform(a, d, b, e, c, f);
	ctx.drawImage(textureCanvas, 0, 0);
}

/**
 * Draw a texture mapped to a triangle
 * Uses a 2D affine transformation (object form kept for compat).
 */
function drawTexturedTriangle(
	ctx: CanvasRenderingContext2D,
	textureCanvas: HTMLCanvasElement,
	t0: { x: number; y: number },
	t1: { x: number; y: number },
	t2: { x: number; y: number },
	v0: { x: number; y: number },
	v1: { x: number; y: number },
	v2: { x: number; y: number }
): void {
	drawTexturedTriangleCoords(ctx, textureCanvas,
		t0.x, t0.y, t1.x, t1.y, t2.x, t2.y,
		v0.x, v0.y, v1.x, v1.y, v2.x, v2.y);
}

void uvToPixels;
void drawTexturedTriangle;

/**
 * Render a model and return as data URL for <img> src
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
 * Clear render cache
 */
export function clearRenderCache(): void {
	renderCache.clear();
	renderQueue.length = 0;
}

/**
 * Check if model can be rendered (has been cached or model exists)
 */
export async function canRenderModel(modelName: string): Promise<boolean> {
	const model = await parseModel(modelName);
	return model !== null && model.faces.length > 0;
}
