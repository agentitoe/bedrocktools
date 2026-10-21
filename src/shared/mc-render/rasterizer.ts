// Rasterizer — paints isometric Minecraft item icons onto a 2D context.
//
// This module is the drawing half of the shared renderer: `model-resolver.ts`
// owns the geometry, everything here is how that geometry reaches pixels. It
// knows nothing about the DOM beyond the `CanvasImageSource` values it is
// handed, so the very same code runs in the browser (client-side fallback) and
// in Bun through `@napi-rs/canvas` (build-time icon baking).
//
// Two details matter for visual fidelity, both carried over from the verified
// `canvas-renderer.ts` implementation:
//   * a face is drawn as two texture-mapped triangles (an affine transform plus
//     a clip), which is what keeps the "isometric" look with no perspective;
//   * Minecraft's GUI shading is a fixed per-face brightness derived from the
//     *model-space* normal, not from a light, so it is applied as a black
//     overlay of alpha (1 - shade).

import { faceAverageZ, fitToSize, isFrontFacing } from './model-resolver';
import type { FaceGeometry, TextureTile, UV, Vec3 } from './types';

/**
 * The minimal slice of a 2D canvas context this module needs. Both
 * `CanvasRenderingContext2D` (browser) and `@napi-rs/canvas`'s context satisfy
 * it structurally, so callers never have to wrap anything.
 *
 * `globalCompositeOperation` and `clearRect` are optional capabilities: the
 * layer tinting in {@link drawLayeredTile} uses them when they are available
 * and degrades gracefully (no tint) when the backing context does not provide
 * them.
 */
export interface Ctx2D {
	save(): void;
	restore(): void;
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	closePath(): void;
	clip(): void;
	transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	drawImage(img: CanvasImageSource, dx: number, dy: number, dw?: number, dh?: number): void;
	fill(): void;
	fillRect(x: number, y: number, w: number, h: number): void;
	fillStyle: string | CanvasGradient | CanvasPattern;
	imageSmoothingEnabled: boolean;
	/** Blend mode of the next drawing operation, when the context supports it. */
	globalCompositeOperation?: string;
	/** Erase a rectangle to transparent black, when the context supports it. */
	clearRect?(x: number, y: number, w: number, h: number): void;
}

/** Texture coordinates live in a 0..16 tile, whatever the texture's pixel size. */
const TEXTURE_SPAN = 16;

/** Colour used for faces whose texture failed to load, so there are no holes. */
const MISSING_TEXTURE_COLOR = '#808080';

/** Determinant below which a texture triangle is considered degenerate. */
const DEGENERATE_DETERMINANT = 1e-3;

/** Depth comparisons this close are treated as a tie (keeps sorting stable). */
const DEPTH_EPSILON = 1e-9;

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Render an isometric block-model icon into a `size`×`size` target.
 *
 * The faces are drawn back to front in **element groups**: every face of an
 * element is painted before the next element, which is the fix for the old
 * "painter per face" ordering that broke models whose elements overlap (bug 9
 * of the plan). Within a group the furthest face goes down first.
 *
 * The context transform is reset to the identity on entry and left untouched,
 * so every coordinate handed to it is a canvas coordinate.
 *
 * @param ctx target context, already sized to `opts.size` square
 * @param faces faces produced by `resolveModelFaces`
 * @param textures texture tiles keyed by the `face.texture` name
 * @param opts `size` is required; `padding` defaults to 2px
 */
export function rasterize(
	ctx: Ctx2D,
	faces: FaceGeometry[],
	textures: Map<string, TextureTile>,
	opts: { size: number; padding?: number }
): void {
	if (!Array.isArray(faces)) {
		throw new TypeError('rasterize: faces must be an array');
	}
	if (!(textures instanceof Map)) {
		throw new TypeError('rasterize: textures must be a Map');
	}

	const size = assertPositiveSize(opts.size, 'rasterize: size');
	const padding = assertPadding(opts.padding ?? 2);

	// Back-face culling first: a cuboid only ever shows three faces in the GUI
	// view, and drawing the hidden ones would just waste texture fetches.
	const visible = faces.filter((face) => isFrontFacing(face.vertices));
	const fitted = fitToSize(visible, size, padding);

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.imageSmoothingEnabled = false;

	for (const index of paintOrder(visible)) {
		drawFace(ctx, fitted[index], textures);
	}
}

/**
 * Blit a raw item texture (a flat sprite, or one layer of a layered item) into
 * a `size`×`size` target with nearest-neighbour sampling, so pixel art stays
 * crisp at the small sizes the GUI uses.
 */
export function drawFlatTile(ctx: Ctx2D, tex: TextureTile, size: number): void {
	assertPositiveSize(size, 'drawFlatTile: size');
	assertTile(tex, 'drawFlatTile');

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(tex.image, 0, 0, size, size);
}

/**
 * Composite the layers of a flat item the way vanilla does (potions, tipped
 * arrows, eyeblossoms…): each layer is drawn over the previous one and, when it
 * carries a tint, the tint multiplies the layer's RGB while its alpha — the
 * silhouette and any shading — is preserved.
 *
 * The multiply + destination-in pair is exactly what `createLayeredCanvas` in
 * `src/tools/minecraft-items/images.ts` did; both steps need
 * `globalCompositeOperation`, so a context without blend modes simply draws the
 * untinted layers.
 */
export function drawLayeredTile(
	ctx: Ctx2D,
	layers: Array<{ tex: TextureTile; tint?: string }>,
	size: number
): void {
	if (!Array.isArray(layers)) {
		throw new TypeError('drawLayeredTile: layers must be an array');
	}
	assertPositiveSize(size, 'drawLayeredTile: size');

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.imageSmoothingEnabled = false;

	for (const layer of layers) {
		const tex = layer.tex;
		if (tex === undefined || tex === null) continue;
		assertTile(tex, 'drawLayeredTile');

		ctx.drawImage(tex.image, 0, 0, size, size);

		const tint = typeof layer.tint === 'string' ? parseCssColor(layer.tint) : null;
		if (tint === null || ctx.globalCompositeOperation === undefined) continue;

		// Multiply the tint into the layer…
		ctx.save();
		ctx.globalCompositeOperation = 'multiply';
		ctx.fillStyle = tint;
		ctx.fillRect(0, 0, size, size);
		ctx.restore();

		// …then restore the layer's own alpha, because blending an opaque colour
		// over the canvas would otherwise extend it to the full square.
		ctx.save();
		ctx.globalCompositeOperation = 'destination-in';
		ctx.drawImage(tex.image, 0, 0, size, size);
		ctx.restore();
	}
}

/* ------------------------------------------------------------------------- */
/* Faces                                                                     */
/* ------------------------------------------------------------------------- */

function drawFace(ctx: Ctx2D, face: FaceGeometry, textures: Map<string, TextureTile>): void {
	const [v0, v1, v2, v3] = face.vertices;
	const tex = textures.get(face.texture);

	if (tex === undefined) {
		// A missing texture must not leave a hole in the silhouette, otherwise
		// whatever was drawn behind it shows through.
		fillQuad(ctx, face, MISSING_TEXTURE_COLOR);
	} else {
		// Texture pixels for the four UV anchors: the anchors live in 0..16 tile
		// space, the tile may be any square multiple of that.
		const scaleX = tex.width / TEXTURE_SPAN;
		const scaleY = tex.height / TEXTURE_SPAN;
		const p0 = toPixels(face.uv[0], scaleX, scaleY);
		const p1 = toPixels(face.uv[1], scaleX, scaleY);
		const p2 = toPixels(face.uv[2], scaleX, scaleY);

		// Draw the whole face as ONE affine-mapped quad. The orthographic
		// projection is affine, so the texture rectangle (u1v1..u2v2) maps onto
		// the projected face exactly — one matrix solved from three anchors
		// covers all four corners. Splitting into two triangles instead leaves
		// a visible diagonal seam where the shared edge's pixels are rasterized
		// differently on each side.
		clipQuad(ctx, face);
		drawTexturedQuad(ctx, tex.image, p0, p1, p2, v0, v1, v2);
		ctx.restore();
	}

	applyShade(ctx, face);
}

/** Enter a clipped, saved state for the whole face quad. */
function clipQuad(ctx: Ctx2D, face: FaceGeometry): void {
	const [v0, v1, v2, v3] = face.vertices;
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(v0.x, v0.y);
	ctx.lineTo(v1.x, v1.y);
	ctx.lineTo(v2.x, v2.y);
	ctx.lineTo(v3.x, v3.y);
	ctx.closePath();
	ctx.clip();
}

/**
 * Map the texture rectangle whose corners are t0,t1,t2 (t3 completing the
 * rectangle) onto the projected face quad with an affine transform.
 *
 * Solving the 2×3 system `v_i = M · t_i` for the first three pairs gives the
 * matrix; because both spaces are related by a strictly affine map (orthographic
 * model → screen is linear + translation, and every fitting step is uniform
 * scale + translate), the fourth corner lands exactly where the quad clip
 * already is, so no seam can appear between triangles.
 *
 * The determinant check drops degenerate quads (collapsed onto a line) instead
 * of feeding NaNs to the context.
 */
function drawTexturedQuad(
	ctx: Ctx2D,
	image: CanvasImageSource,
	t0: Point,
	t1: Point,
	t2: Point,
	v0: Vec3,
	v1: Vec3,
	v2: Vec3
): void {
	const det = (t1.x - t0.x) * (t2.y - t0.y) - (t1.y - t0.y) * (t2.x - t0.x);
	if (Math.abs(det) < DEGENERATE_DETERMINANT) return; // Degenerate quad

	const a = ((v1.x - v0.x) * (t2.y - t0.y) - (v2.x - v0.x) * (t1.y - t0.y)) / det;
	const b = ((v2.x - v0.x) * (t1.x - t0.x) - (v1.x - v0.x) * (t2.x - t0.x)) / det;
	const c = v0.x - a * t0.x - b * t0.y;

	const d = ((v1.y - v0.y) * (t2.y - t0.y) - (v2.y - v0.y) * (t1.y - t0.y)) / det;
	const e = ((v2.y - v0.y) * (t1.x - t0.x) - (v1.y - v0.y) * (t2.x - t0.x)) / det;
	const f = v0.y - d * t0.x - e * t0.y;

	ctx.transform(a, d, b, e, c, f);
	ctx.drawImage(image, 0, 0);
}

/**
 * Minecraft's fixed GUI lighting, applied on the model-space normal: top
 * brightest, bottom darkest, north/south in between, east/west darker still.
 * It is the single reason an inventory block reads as a 3D cube.
 */
function faceShade(normal: Vec3): number {
	if (normal.y > 0.5) return 1.0; // up
	if (normal.y < -0.5) return 0.5; // down
	if (Math.abs(normal.z) > 0.5) return 0.8; // north / south
	return 0.6; // east / west
}

function applyShade(ctx: Ctx2D, face: FaceGeometry): void {
	if (face.shade !== true) return;

	const shade = faceShade(face.normal);
	if (shade >= 1) return;

	fillQuad(ctx, face, `rgba(0, 0, 0, ${(1 - shade).toFixed(3)})`);
}

function fillQuad(ctx: Ctx2D, face: FaceGeometry, fillStyle: string): void {
	const [v0, v1, v2, v3] = face.vertices;
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(v0.x, v0.y);
	ctx.lineTo(v1.x, v1.y);
	ctx.lineTo(v2.x, v2.y);
	ctx.lineTo(v3.x, v3.y);
	ctx.closePath();
	ctx.fillStyle = fillStyle;
	ctx.fill();
	ctx.restore();
}

/*
 * Map a texture triangle onto a screen triangle with an affine transform: the
 * arithmetic below (solving `v_i = M · t_i` from three anchor pairs) is shared
 * by {@link drawTexturedQuad}, which applies it to whole faces to avoid the
 * per-triangle diagonal seam.
 */


/* ------------------------------------------------------------------------- */
/* Depth ordering                                                            */
/* ------------------------------------------------------------------------- */

interface FaceGroup {
	/** Mean depth of the group's faces; smaller means further from the camera. */
	depth: number;
	/** Index of the group's first face, used as a stable tie-breaker. */
	firstIndex: number;
	/** Indices into the face array, already sorted back to front. */
	faces: number[];
}

/**
 * Draw order for the visible faces: groups first (by mean depth), then faces
 * inside each group (by depth). Painting per *element* instead of per *quad*
 * is what stops an overlapping element's far face from covering a nearer face
 * of the element in front of it.
 */
function paintOrder(faces: FaceGeometry[]): number[] {
	const groups = new Map<number, { depthSum: number; firstIndex: number; faces: number[] }>();

	faces.forEach((face, index) => {
		const group = groups.get(face.element) ?? { depthSum: 0, firstIndex: index, faces: [] };
		group.depthSum += faceAverageZ(face);
		group.faces.push(index);
		groups.set(face.element, group);
	});

	const ordered: FaceGroup[] = [...groups.values()]
		.map((group) => ({
			depth: group.depthSum / group.faces.length,
			firstIndex: group.firstIndex,
			faces: group.faces
		}))
		.sort((left, right) => compareDepth(left.depth, right.depth, left.firstIndex, right.firstIndex));

	for (const group of ordered) {
		group.faces.sort((left, right) =>
			compareDepth(faceAverageZ(faces[left]), faceAverageZ(faces[right]), left, right)
		);
	}

	const order: number[] = [];
	for (const group of ordered) order.push(...group.faces);
	return order;
}

/** Ascending depth (far first); ties fall back to the model's own face order. */
function compareDepth(aDepth: number, bDepth: number, aIndex: number, bIndex: number): number {
	if (aDepth < bDepth - DEPTH_EPSILON) return -1;
	if (bDepth < aDepth - DEPTH_EPSILON) return 1;
	return aIndex - bIndex;
}

/**
 * Draw order for the visible faces: groups first (by mean depth), then faces
 * inside each group (by depth). Painting per *element* instead of per *quad*
 * is what stops an overlapping element's far face from covering a nearer face
 * of the element in front of it.
 */

interface Point {
	x: number;
	y: number;
}

function toPixels(uv: UV, scaleX: number, scaleY: number): Point {
	return { x: uv.u * scaleX, y: uv.v * scaleY };
}

/**
 * Normalise the colour notations vanilla models and item data use (`#rgb`,
 * `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`) to a hex string the canvas API
 * always accepts. Returns `null` for anything else, which callers treat as
 * "no tint".
 */
export function parseCssColor(value: string): string | null {
	const raw = value.trim();
	if (raw.length === 0) return null;

	const hex = /^#([0-9a-f]{3,8})$/i.exec(raw);
	if (hex !== null) {
		const digits = hex[1].toLowerCase();
		if (digits.length === 3 || digits.length === 4) {
			return `#${digits.slice(0, 3).split('').map((c) => c + c).join('')}`;
		}
		if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`;
		return null;
	}

	const fn = /^rgba?\(([^)]+)\)$/i.exec(raw);
	if (fn !== null) {
		const parts = fn[1]
			.split(/[,/\s]+/)
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (parts.length < 3) return null;
		const hex6 = parts.slice(0, 3).map((part) => {
			const channel = Number.parseFloat(part.endsWith('%') ? `${Number.parseFloat(part) / 100 * 255}` : part);
			if (!Number.isFinite(channel) || channel < 0 || channel > 255) return null;
			return Math.round(channel).toString(16).padStart(2, '0');
		});
		if (hex6.some((part) => part === null)) return null;
		return `#${hex6.join('')}`;
	}

	return null;
}

function assertPositiveSize(size: number, label: string): number {
	if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
		throw new TypeError(`${label} must be a positive finite number, got ${String(size)}`);
	}
	return size;
}

function assertPadding(padding: number): number {
	if (typeof padding !== 'number' || !Number.isFinite(padding) || padding < 0) {
		throw new TypeError(`rasterize: padding must be a non-negative finite number, got ${String(padding)}`);
	}
	return padding;
}

function assertTile(tex: TextureTile, label: string): void {
	if (!(typeof tex === 'object' && tex !== null)) {
		throw new TypeError(`${label} expected a texture tile`);
	}
	if (!(typeof tex.width === 'number' && tex.width > 0) || !(typeof tex.height === 'number' && tex.height > 0)) {
		throw new TypeError(`${label} expected a texture tile with positive dimensions`);
	}
	if (tex.image === undefined || tex.image === null) {
		throw new TypeError(`${label} expected a texture tile with an image`);
	}
}
