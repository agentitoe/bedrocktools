// Canvas Renderer
// Renders Minecraft models to 2D canvas using isometric projection

import { parseModel } from './model-parser';
import { projectFaces, sortFacesByDepth, fitToCanvas, ProjectedFace } from './isometric-projector';
import { loadTexture, uvToPixels, Texture } from './texture-loader';

const renderCache = new Map<string, HTMLCanvasElement>();

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
	const cacheKey = `${modelName}:${options.size || 48}`;

	// Check cache
	if (renderCache.has(cacheKey)) {
		return Promise.resolve(renderCache.get(cacheKey)!);
	}

	return scheduleRender(() => doRenderModel(modelName, options));
}

async function doRenderModel(modelName: string, options: RenderOptions): Promise<HTMLCanvasElement | null> {
	const cacheKey = `${modelName}:${options.size || 48}`;
	if (renderCache.has(cacheKey)) return renderCache.get(cacheKey)!;

	try {
		// Parse model
		const model = await parseModel(modelName);
		if (!model || model.faces.length === 0) {
			console.warn(`[renderModel] No model or faces for ${modelName}`);
			return null;
		}

		// Project to 2D
		let projected = projectFaces(model.faces);

		// Sort by depth (painter's algorithm)
		projected = sortFacesByDepth(projected);

		// Fit to canvas
		projected = fitToCanvas(projected, options.size || 48, options.padding || 4);

		// Create canvas
		const size = options.size || 48;
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

		// Load all required textures
		const textureRefs = [...new Set(projected.map(f => f.textureRef))];
		const texturePromises = textureRefs.map(ref => loadTexture(ref));
		const textures = await Promise.all(texturePromises);
		const textureMap = new Map(textureRefs.map((ref, i) => [ref, textures[i]]));

		// Draw each face
		for (const face of projected) {
			const texture = textureMap.get(face.textureRef);
			await drawFace(ctx, face, texture);
		}

		// Cache result
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
async function drawFace(
	ctx: CanvasRenderingContext2D,
	face: ProjectedFace,
	texture: Texture | undefined
): Promise<void> {
	if (!texture || !texture.loaded || face.vertices.length !== 4) {
		return;
	}

	const [v0, v1, v2, v3] = face.vertices;
	const [uv0, uv1, uv2, uv3] = face.uv;

	// Convert UV to pixel coordinates
	const [p0, p1, p2, p3] = [
		uvToPixels(texture, uv0),
		uvToPixels(texture, uv1),
		uvToPixels(texture, uv2),
		uvToPixels(texture, uv3)
	];

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
	drawTexturedTriangle(ctx, texture.canvas, p0, p1, p2, v0, v1, v2);

	ctx.restore();

	ctx.save();

	// Triangle 2
	ctx.beginPath();
	ctx.moveTo(v0.x, v0.y);
	ctx.lineTo(v2.x, v2.y);
	ctx.lineTo(v3.x, v3.y);
	ctx.closePath();
	ctx.clip();

	drawTexturedTriangle(ctx, texture.canvas, p0, p2, p3, v0, v2, v3);

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
 * Draw a texture mapped to a triangle
 * Uses a 2D affine transformation
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
	// Compute affine transformation matrix
	// We want to map texture coords (t0,t1,t2) to screen coords (v0,v1,v2)

	// Solve for matrix: [a b c; d e f] such that:
	// v0 = t0 * [a b c]   v1 = t1 * [a b c]   v2 = t2 * [a b c]
	//       [d e f]          [d e f]          [d e f]

	const det = (t1.x - t0.x) * (t2.y - t0.y) - (t1.y - t0.y) * (t2.x - t0.x);
	if (Math.abs(det) < 0.001) return; // Degenerate triangle

	const a = ((v1.x - v0.x) * (t2.y - t0.y) - (v2.x - v0.x) * (t1.y - t0.y)) / det;
	const b = ((v2.x - v0.x) * (t1.x - t0.x) - (v1.x - v0.x) * (t2.x - t0.x)) / det;
	const c = v0.x - a * t0.x - b * t0.y;

	const d = ((v1.y - v0.y) * (t2.y - t0.y) - (v2.y - v0.y) * (t1.y - t0.y)) / det;
	const e = ((v2.y - v0.y) * (t1.x - t0.x) - (v1.y - v0.y) * (t2.x - t0.x)) / det;
	const f = v0.y - d * t0.x - e * t0.y;

	ctx.transform(a, d, b, e, c, f);
	ctx.drawImage(textureCanvas, 0, 0);
}

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
}

/**
 * Check if model can be rendered (has been cached or model exists)
 */
export async function canRenderModel(modelName: string): Promise<boolean> {
	const model = await parseModel(modelName);
	return model !== null && model.faces.length > 0;
}