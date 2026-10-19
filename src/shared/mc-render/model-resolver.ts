// Model resolver — turns vanilla block model JSON into renderable geometry.
//
// This module is deliberately DOM-free and synchronous: it must run both in the
// browser (client-side fallback renders) and in Bun (build-time icon baking),
// so the caller passes the model bundle in instead of us fetching it.
//
// The semantics are copied from the vanilla client (`FaceBakery` /
// `BlockElementRotation` / `Quadrant` in net.minecraft.client.renderer),
// including the details the previous implementation got wrong:
//   * a child's `elements` replace the parent's instead of being appended;
//   * textures accumulate root → leaf, so the leaf value wins;
//   * `display` merges per transform key instead of being replaced wholesale;
//   * `elements[].rotation` is applied (angle/axis/origin/rescale);
//   * `elements[].shade: false` disables the directional GUI shade;
//   * the `down` face samples its texture mirrored on both axes.

import type { DisplayTransform, FaceGeometry, RawModel, UV, Vec3 } from './types';

const DEG2RAD = Math.PI / 180;

/** The four vertices of a quad, indexed the way `FaceInfo` does in vanilla. */
const FACE_NAMES = ['up', 'down', 'north', 'south', 'west', 'east'] as const;
type FaceName = (typeof FACE_NAMES)[number];

/**
 * The standard Minecraft GUI/inventory transform applied to block models.
 * Used whenever the model chain (and `block/block`) does not declare `display.gui`.
 */
export const DEFAULT_GUI_TRANSFORM: DisplayTransform = {
	rotation: [30, 225, 0],
	translation: [0, 0, 0],
	scale: [0.625, 0.625, 0.625]
};

/* ------------------------------------------------------------------------- */
/* Public API                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Resolve a model and its parent chain into the faces used to draw it.
 *
 * @param models every available model keyed by its bare file name ("oak_log",
 *               "white_glazed_terracotta", …) as used by `data/models/all.json`
 * @param modelName model to resolve; namespace/`block/` prefixes are tolerated
 * @returns the faces, or `null` when the model is missing or has no usable face
 */
export function resolveModelFaces(
	models: Record<string, RawModel>,
	modelName: string
): FaceGeometry[] | null {
	const chain = buildModelChain(models, modelName);
	if (chain.length === 0) return null;

	const inherited = mergeChain(chain);
	const elements = inherited.elements;
	if (elements === null) return null;

	const guiTransform = inherited.display.gui ?? DEFAULT_GUI_TRANSFORM;
	const faces: FaceGeometry[] = [];

	for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
		const element = parseElement(elements[elementIndex]);
		if (element === null) continue;

		const rotation = elementRotation(element);
		for (const [faceName, face] of element.faces) {
			// Model-space corners, already rotated by `elements[].rotation` when
			// the element declares one. Degenerate corners are kept: a cuboid that
			// is flat on one axis (a plate, a cross) still has four usable corners
			// for the faces that do have area.
			const corners = getFaceVertices(element, faceName).map((vertex) =>
				rotation.apply(vertex)
			);

			faces.push({
				element: elementIndex,
				vertices: corners.map((vertex) => applyDisplayTransform(vertex, guiTransform)) as [
					Vec3,
					Vec3,
					Vec3,
					Vec3
				],
				uv: uvAnchors(faceName, face.uv, element, face.rotation),
				texture: resolveFaceTexture(face.texture, inherited.textures),
				normal: faceNormal(faceName, corners, rotation),
				shade: element.shade
			});
		}
	}

	return faces.length > 0 ? faces : null;
}

 /**
 * Scale and centre a copy of `faces` so their orthographic projection fits in a
 * `size`×`size` box. The input faces are never mutated and the UV anchors are
 * passed through untouched; only the (already display-transformed) positions
 * change. Depth is left alone because a uniform 2D fit does not change which
 * face is nearer to the camera.
 *
 * The output vertices are in **canvas space** (screen y grows downwards), so
 * the rasterizer can feed `vertex.y` straight to the 2D context: the correct
 * canvas position of a model-space y is `-(vertex.y) * scale + offsetY`, which
 * is exactly the mapping below. The bounds are measured in the same space via
 * `projectFace` (x kept, y negated), keeping two spaces — raw model y and
 * canvas y — out of each other's arithmetic.
 *
 * @param faces faces to fit
 * @param size target box in pixels
 * @param padding empty margin kept around the icon, in pixels
 */
export function fitToSize(faces: FaceGeometry[], size: number, padding: number = 2): FaceGeometry[] {
	if (faces.length === 0) return [];

	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const face of faces) {
		for (const point of projectFace(face)) {
			if (point.x < minX) minX = point.x;
			if (point.x > maxX) maxX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.y > maxY) maxY = point.y;
		}
	}

	const width = maxX - minX;
	const height = maxY - minY;
	const maxExtent = Math.max(width, height);
	// A single point (or NaN input) cannot be fitted; return an untouched copy.
	if (!(maxExtent > 0)) return faces.map((face) => cloneFace(face));

	const scale = (size - padding * 2) / maxExtent;
	const offsetX = (size - width * scale) / 2 - minX * scale;
	// Screen y is the negated model y, hence the sign flip on this offset.
	const offsetY = (size - height * scale) / 2 - minY * scale;

	return faces.map((face) => cloneFace(face, (vertex) => ({
		x: vertex.x * scale + offsetX,
		y: offsetY - vertex.y * scale,
		z: vertex.z
	})));
}

/**
 * Orthographic projection of a face's vertices: keep x, flip y for canvas space,
 * drop z. The `display.gui` rotation already oriented the model, so no further
 * trigonometry is needed here.
 */
export function projectFace(f: FaceGeometry): { x: number; y: number }[] {
	return f.vertices.map((vertex) => ({ x: vertex.x, y: -vertex.y }));
}

/** Mean depth of a face; larger z is closer to the camera. */
export function faceAverageZ(f: FaceGeometry): number {
	let sum = 0;
	for (const vertex of f.vertices) sum += vertex.z;
	return sum / f.vertices.length;
}

/**
 * Back-face culling: true when the winding normal of already-transformed
 * vertices points towards the camera (+z).
 */
export function isFrontFacing(v: Vec3[]): boolean {
	if (v.length < 3) return false;
	const u = sub(v[1], v[0]);
	const w = sub(v[2], v[0]);
	return cross(u, w).z > 0;
}

/* ------------------------------------------------------------------------- */
/* Model chain                                                              */
/* ------------------------------------------------------------------------- */

/** Peel a model reference down to the bare name used as bundle key. */
function peelModelName(name: string): string {
	return name
		.replace(/^minecraft:/, '')
		.replace(/^(block|item)\//, '')
		.trim();
}

function lookupModel(models: Record<string, RawModel>, name: string): RawModel | undefined {
	const bare = peelModelName(name);
	return (
		models[name] ??
		models[bare] ??
		models[`minecraft:block/${bare}`] ??
		models[`block/${bare}`]
	);
}

/**
 * Walk the parent chain from the requested model up to the root and return it
 * root-first, which is the order the merge loop below needs. Cycles and missing
 * references simply stop the walk.
 */
function buildModelChain(models: Record<string, RawModel>, modelName: string): RawModel[] {
	const chain: RawModel[] = [];
	const seen = new Set<string>();

	let name = modelName;
	while (name.length > 0) {
		if (seen.has(name)) break; // defensive: sibling models may reference each other
		seen.add(name);

		const model = lookupModel(models, name);
		if (model === undefined) break;
		chain.push(model);

		name = typeof model.parent === 'string' ? peelModelName(model.parent) : '';
	}

	return chain.reverse();
}

interface InheritedState {
	textures: Record<string, string>;
	elements: unknown[] | null;
	display: Record<string, DisplayTransform>;
}

/**
 * Fold a root → leaf chain into the effective model state. Reading the chain in
 * this direction is what makes the leaf win: every level overwrites the keys it
 * declares instead of the other way round.
 */
function mergeChain(chain: RawModel[]): InheritedState {
	const textures: Record<string, string> = {};
	let elements: unknown[] | null = null;
	const display: Record<string, DisplayTransform> = {};

	for (const model of chain) {
		if (isRecord(model.textures)) {
			for (const [key, value] of Object.entries(model.textures)) {
				textures[key] = textureValue(value, textures);
			}
		}
		// A child that declares `elements` replaces the parent's geometry; vanilla
		// never concatenates cuboids.
		if (Array.isArray(model.elements)) {
			elements = model.elements;
		}
		if (isRecord(model.display)) {
			for (const [key, value] of Object.entries(model.display)) {
				const transform = parseTransform(value);
				if (transform !== null) display[key] = transform;
			}
		}
	}

	return { textures, elements, display };
}

/**
 * Resolve one `textures` entry against the map accumulated so far. Accepts the
 * plain string form (`"minecraft:block/x"`), a local alias (`"#other"`) and the
 * 26.1 object form (`{ "sprite": "…" }`).
 */
function textureValue(value: unknown, accumulated: Record<string, string>): string {
	const raw = typeof value === 'string' ? value : spriteOf(value);
	if (raw === undefined) return '';

	if (raw.startsWith('#')) {
		// Resolve against the state at this point in the walk: a `#ref` may only
		// use keys defined by an ancestor, mirroring vanilla's behaviour.
		const target = raw.slice(1);
		return accumulated[target] ? accumulated[target] : raw;
	}
	return raw;
}

function spriteOf(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.sprite === 'string' ? value.sprite : undefined;
}

function parseTransform(value: unknown): DisplayTransform | null {
	if (!isRecord(value)) return null;
	const src = isRecord(value.rotation) ? value.rotation : value;
	const rotation = vec3(src.rotation) ?? [0, 0, 0];
	const translation = vec3(src.translation) ?? [0, 0, 0];
	const scale = vec3(src.scale) ?? [1, 1, 1];
	return { rotation, translation, scale };
}

/* ------------------------------------------------------------------------- */
/* Elements and faces                                                       */
/* ------------------------------------------------------------------------- */

interface RawFace {
	texture: string;
	/** [u1, v1, u2, v2] in 0..16 texture space, only when the model declares one. */
	uv: number[] | undefined;
	rotation: number;
}

interface ParsedElement {
	from: [number, number, number];
	to: [number, number, number];
	faces: Array<[FaceName, RawFace]>;
	shade: boolean;
	/** Raw `rotation` object, already validated. */
	rotation: { angle: number; axis: 'x' | 'y' | 'z'; origin: Vec3; rescale: boolean } | null;
}

/** Validate one `elements[]` entry; unusable entries are skipped, not fatal. */
function parseElement(raw: unknown): ParsedElement | null {
	if (!isRecord(raw)) return null;

	const from = vec3(raw.from);
	const to = vec3(raw.to);
	if (from === null || to === null) return null;

	const faces: Array<[FaceName, RawFace]> = [];
	if (isRecord(raw.faces)) {
		for (const [key, value] of Object.entries(raw.faces)) {
			const faceName = asFaceName(key);
			if (faceName === null || !isRecord(value)) continue;
			if (typeof value.texture !== 'string') continue;
			faces.push([
				faceName,
				{
					texture: value.texture,
					uv: parseUV(value.uv),
					rotation: typeof value.rotation === 'number' ? value.rotation : 0
				}
			]);
		}
	}
	if (faces.length === 0) return null;

	return {
		from,
		to,
		faces,
		shade: raw.shade !== false,
		rotation: parseElementRotation(raw.rotation, from, to)
	};
}

/** Model JSON stores `[u1, v1, u2, v2]`; anything else falls back to auto-UV. */
function parseUV(raw: unknown): number[] | undefined {
	if (!Array.isArray(raw) || raw.length < 4) return undefined;
	const values = raw.slice(0, 4);
	if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
		return undefined;
	}
	return values as number[];
}

function asFaceName(key: string): FaceName | null {
	return (FACE_NAMES as readonly string[]).includes(key) ? (key as FaceName) : null;
}

function parseElementRotation(
	raw: unknown,
	from: [number, number, number],
	to: [number, number, number]
): ParsedElement['rotation'] {
	if (!isRecord(raw)) return null;

	const axis = raw.axis;
	if (axis !== 'x' && axis !== 'y' && axis !== 'z') return null;
	const angle = raw.angle;
	if (typeof angle !== 'number' || !Number.isFinite(angle)) return null;

	// Vanilla defaults the pivot to the element's own centre when `origin` is
	// absent; models in the wild always spell it out, but be safe.
	const declaredOrigin = vec3(raw.origin);
	const origin: Vec3 = declaredOrigin
		? { x: declaredOrigin[0], y: declaredOrigin[1], z: declaredOrigin[2] }
		: {
				x: (from[0] + to[0]) / 2,
				y: (from[1] + to[1]) / 2,
				z: (from[2] + to[2]) / 2
			};

	return { angle, axis, origin, rescale: raw.rescale === true };
}

/**
 * The four corners of a face in the order `FaceInfo` uses in vanilla: v0,v1,v2,v3
 * counter-clockwise seen from outside, which is what back-face culling and the
 * UV anchor table below assume.
 */
function getFaceVertices(element: ParsedElement, faceName: FaceName): Vec3[] {
	const [minX, maxX] = ordered(element.from[0], element.to[0]);
	const [minY, maxY] = ordered(element.from[1], element.to[1]);
	const [minZ, maxZ] = ordered(element.from[2], element.to[2]);

	switch (faceName) {
		case 'up':
			return [
				{ x: minX, y: maxY, z: maxZ },
				{ x: maxX, y: maxY, z: maxZ },
				{ x: maxX, y: maxY, z: minZ },
				{ x: minX, y: maxY, z: minZ }
			];
		case 'down':
			return [
				{ x: minX, y: minY, z: minZ },
				{ x: maxX, y: minY, z: minZ },
				{ x: maxX, y: minY, z: maxZ },
				{ x: minX, y: minY, z: maxZ }
			];
		case 'north':
			return [
				{ x: minX, y: minY, z: minZ },
				{ x: minX, y: maxY, z: minZ },
				{ x: maxX, y: maxY, z: minZ },
				{ x: maxX, y: minY, z: minZ }
			];
		case 'south':
			return [
				{ x: maxX, y: minY, z: maxZ },
				{ x: maxX, y: maxY, z: maxZ },
				{ x: minX, y: maxY, z: maxZ },
				{ x: minX, y: minY, z: maxZ }
			];
		case 'west':
			return [
				{ x: minX, y: minY, z: maxZ },
				{ x: minX, y: maxY, z: maxZ },
				{ x: minX, y: maxY, z: minZ },
				{ x: minX, y: minY, z: minZ }
			];
		case 'east':
			return [
				{ x: maxX, y: minY, z: minZ },
				{ x: maxX, y: maxY, z: minZ },
				{ x: maxX, y: maxY, z: maxZ },
				{ x: maxX, y: minY, z: maxZ }
			];
	}
}

/* ------------------------------------------------------------------------- */
/* UVs                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Map the texture region [u1, v1, u2, v2] onto the face's four corners.
 *
 * Vanilla anchors the region per face (`BlockElementFace.UVs#getVertexU/V`):
 * vertices 0 and 1 take u1, vertices 2 and 3 take u2, while vertices 0 and 3
 * take v1 and vertices 1 and 2 take v2. Written for a full-size element that
 * reduces to the anchors below, which are what the renderer relies on:
 *
 *   up/down:    u1 ↔ minX, u2 ↔ maxX, v1 ↔ minZ  (down: v1 ↔ maxZ once the
 *               z-flip of `FaceBakery.defaultFaceUV` is folded in)
 *   north/south/west/east: v1 ↔ maxY, v2 ↔ minY, u grows towards the face's own
 *               right when seen from outside
 *
 * The old implementation mirrored the `down` face on both axes, which made every
 * bottom face render upside down.
 *
 * `face.rotation` is a clockwise spin of the texture in 90° steps, i.e. a cyclic
 * left shift of the four corners (`Quadrant#rotateVertexIndex`).
 */
function uvAnchors(
	faceName: FaceName,
	uv: number[] | undefined,
	element: ParsedElement,
	rotation: number
): [UV, UV, UV, UV] {
	const { u1, v1, u2, v2 } = autoUV(faceName, uv, element);

	let corners: UV[];
	switch (faceName) {
		case 'up':
		case 'down':
			// Both faces share the corner order because the two vertex orders are
			// opposite: `up` walks (minX,maxZ)→…→(minX,minZ) while `down` walks
			// (minX,minZ)→…→(minX,maxZ).
			corners = [
				{ u: u1, v: v2 },
				{ u: u2, v: v2 },
				{ u: u2, v: v1 },
				{ u: u1, v: v1 }
			];
			break;
		default:
			corners = [
				{ u: u2, v: v2 },
				{ u: u2, v: v1 },
				{ u: u1, v: v1 },
				{ u: u1, v: v2 }
			];
			break;
	}

	const steps = Math.round(((((rotation % 360) + 360) % 360) / 90)) % 4;
	if (steps > 0) {
		corners = [...corners.slice(steps), ...corners.slice(0, steps)];
	}
	return corners as [UV, UV, UV, UV];
}

/** The texture region to sample, defaulting to the element's own footprint. */
function autoUV(
	faceName: FaceName,
	uv: number[] | undefined,
	element: ParsedElement
): { u1: number; v1: number; u2: number; v2: number } {
	if (uv !== undefined) return { u1: uv[0], v1: uv[1], u2: uv[2], v2: uv[3] };

	const [minX, maxX] = ordered(element.from[0], element.to[0]);
	const [minY, maxY] = ordered(element.from[1], element.to[1]);
	const [minZ, maxZ] = ordered(element.from[2], element.to[2]);

	// Matches `FaceBakery.defaultFaceUV` for elements spanning the whole 0..16
	// block, which is what every model in the vanilla assets does when it omits
	// an explicit `uv`.
	switch (faceName) {
		case 'up':
		case 'down':
			return { u1: minX, v1: minZ, u2: maxX, v2: maxZ };
		case 'north':
		case 'south':
			return { u1: minX, v1: minY, u2: maxX, v2: maxY };
		default:
			return { u1: minZ, v1: minY, u2: maxZ, v2: maxY };
	}
}

/**
 * The face texture, resolved against the merged texture map.
 *
 * Aliases can be multi-level: `cube_column` declares `up: "#end"` and the leaf
 * (`oak_log`) is the one that finally defines `end`. The ancestor's alias
 * therefore cannot be resolved while walking the chain and has to be followed
 * lazily here, with a bounded loop so a malformed map cannot hang the bake.
 */
function resolveFaceTexture(ref: string, textures: Record<string, string>): string {
	let key = ref.startsWith('#') ? ref.slice(1) : ref;
	const seen = new Set<string>();

	for (let depth = 0; depth < 8; depth++) {
		const value = textures[key];
		// Either the key is not an alias of anything, or the alias points to a
		// key the chain never defined.
		if (value === undefined || seen.has(key)) break;
		if (!value.startsWith('#')) return normalizeTextureName(value);
		seen.add(key);
		key = value.slice(1);
	}

	return normalizeTextureName(key);
}

function normalizeTextureName(name: string): string {
	return name
		.replace(/^minecraft:/, '')
		.replace(/^(block|item)\//, '');
}

/* ------------------------------------------------------------------------- */
/* Element rotation                                                          */
/* ------------------------------------------------------------------------- */

interface ElementRotation {
	apply(vertex: Vec3): Vec3;
}

/** Identity rotation: turning it into a value keeps the face loop allocation-free. */
const IDENTITY_ROTATION: ElementRotation = { apply: (vertex) => vertex };

/**
 * Build the transform for an element's `rotation` block.
 *
 * Vanilla rotates the vertices around `origin` about the given axis and, when
 * `rescale` is set, additionally scales around that same origin by
 * `1 / max(abs(rotated basis component))` (see `BlockElementRotation#computeRescale`).
 * Without it, cuboids rotated 45° look squeezed: a 16×16 face rotated 45° about y
 * would only cover ~11px of the block's width.
 */
function elementRotation(element: ParsedElement): ElementRotation {
	if (element.rotation === null) return IDENTITY_ROTATION;

	const { angle, axis, origin, rescale } = element.rotation;
	if (angle === 0) return IDENTITY_ROTATION;

	const radians = angle * DEG2RAD;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);

	let scale: [number, number, number] = [1, 1, 1];
	if (rescale) {
		// Rotate each unit axis through the very same rotation and keep its largest
		// component: that component is the part of the axis that survives the
		// rotation, so inverting it restores the element's extent along it. The
		// rotated axis itself keeps a factor of 1, so the element is never
		// stretched along the axis it spins around.
		scale = [
			1 / maxComponent(rotateAboutAxis({ x: 1, y: 0, z: 0 }, cos, sin, axis)),
			1 / maxComponent(rotateAboutAxis({ x: 0, y: 1, z: 0 }, cos, sin, axis)),
			1 / maxComponent(rotateAboutAxis({ x: 0, y: 0, z: 1 }, cos, sin, axis))
		];
	}

	const originVec = origin;
	return {
		apply: (vertex) => {
			const local = {
				x: (vertex.x - originVec.x) * scale[0],
				y: (vertex.y - originVec.y) * scale[1],
				z: (vertex.z - originVec.z) * scale[2]
			};
			const rotated = rotateAboutAxis(local, cos, sin, axis);
			return {
				x: rotated.x + originVec.x,
				y: rotated.y + originVec.y,
				z: rotated.z + originVec.z
			};
		}
	};
}

/**
 * Right-handed rotation of a point about the given model axis. The sign
 * convention matches `rotateVertex` used by the display transform, which was
 * verified against the inventory view.
 */
function rotateAboutAxis(v: Vec3, cos: number, sin: number, axis: 'x' | 'y' | 'z'): Vec3 {
	switch (axis) {
		case 'x':
			return { x: v.x, y: v.y * cos - v.z * sin, z: v.y * sin + v.z * cos };
		case 'y':
			return { x: v.x * cos + v.z * sin, y: v.y, z: -v.x * sin + v.z * cos };
		case 'z':
			return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos, z: v.z };
	}
}

function maxComponent(v: Vec3): number {
	return Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
}

/**
 * Model-space normal of a face, used for the fixed GUI shading. It comes from
 * the winding of the (already element-rotated) corners, which is what vanilla
 * does (`FaceBakery#calculateFacing`); flat cuboids have a zero-area winding for
 * some faces, so those fall back to the nominal face direction rotated the same
 * way — shading a paper-thin face from its own orientation is what makes crossed
 * plants and plates look right.
 */
function faceNormal(faceName: FaceName, corners: Vec3[], rotation: ElementRotation): Vec3 {
	const winding = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
	if (maxComponent(winding) > 1e-6) return winding;
	return rotation.apply(nominalNormal(faceName));
}

function nominalNormal(faceName: FaceName): Vec3 {
	switch (faceName) {
		case 'up':
			return { x: 0, y: 1, z: 0 };
		case 'down':
			return { x: 0, y: -1, z: 0 };
		case 'north':
			return { x: 0, y: 0, z: -1 };
		case 'south':
			return { x: 0, y: 0, z: 1 };
		case 'west':
			return { x: -1, y: 0, z: 0 };
		case 'east':
			return { x: 1, y: 0, z: 0 };
	}
}

/* ------------------------------------------------------------------------- */
/* Transforms and small helpers                                              */
/* ------------------------------------------------------------------------- */

/**
 * Apply the vanilla item/display transform to a vertex: move to the (8,8,8)
 * centre, rotate Rx·Ry·Rz (z first, then y, then x), scale, translate, move back.
 * Keeping the exact order matters — rotating x first flips the cube's orientation
 * and the top face stops facing the camera.
 */
function applyDisplayTransform(v: Vec3, transform: DisplayTransform): Vec3 {
	const x = v.x - 8;
	const y = v.y - 8;
	const z = v.z - 8;

	const rotated = rotateVertex({ x, y, z }, transform.rotation);
	return {
		x: rotated.x * transform.scale[0] + transform.translation[0] + 8,
		y: rotated.y * transform.scale[1] + transform.translation[1] + 8,
		z: rotated.z * transform.scale[2] + transform.translation[2] + 8
	};
}

/** Rotate about z, then y, then x (matrix order Rx·Ry·Rz). */
function rotateVertex(v: Vec3, rotation: [number, number, number]): Vec3 {
	const [rx, ry, rz] = rotation;
	let { x, y, z } = v;

	if (rz !== 0) {
		const cos = Math.cos(rz * DEG2RAD);
		const sin = Math.sin(rz * DEG2RAD);
		const nx = x * cos - y * sin;
		const ny = x * sin + y * cos;
		x = nx;
		y = ny;
	}
	if (ry !== 0) {
		const cos = Math.cos(ry * DEG2RAD);
		const sin = Math.sin(ry * DEG2RAD);
		const nx = x * cos + z * sin;
		const nz = -x * sin + z * cos;
		x = nx;
		z = nz;
	}
	if (rx !== 0) {
		const cos = Math.cos(rx * DEG2RAD);
		const sin = Math.sin(rx * DEG2RAD);
		const ny = y * cos - z * sin;
		const nz = y * sin + z * cos;
		y = ny;
		z = nz;
	}
	return { x, y, z };
}

function cloneFace(face: FaceGeometry, transform?: (vertex: Vec3) => Vec3): FaceGeometry {
	return {
		...face,
		vertices: face.vertices.map((vertex) => {
			const next = transform ? transform(vertex) : vertex;
			return { x: next.x, y: next.y, z: next.z };
		}) as [Vec3, Vec3, Vec3, Vec3]
	};
}

function sub(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x
	};
}

/** `[a, b]` with the two entries sorted, so `from`/`to` may be given either way. */
function ordered(a: number, b: number): [number, number] {
	return a <= b ? [a, b] : [b, a];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a `[x, y, z]` tuple, rejecting anything that is not three finite numbers. */
function vec3(value: unknown): [number, number, number] | null {
	if (!Array.isArray(value) || value.length < 3) return null;
	const [x, y, z] = value;
	if (
		typeof x !== 'number' || !Number.isFinite(x) ||
		typeof y !== 'number' || !Number.isFinite(y) ||
		typeof z !== 'number' || !Number.isFinite(z)
	) {
		return null;
	}
	return [x, y, z];
}
