// Minecraft Model Parser
// Parses Minecraft model JSON into renderable geometry for isometric rendering.
// Optimized: bounded LRU (150 raw / 500 resolved), inflight fetch dedupe,
// precompiled regex, visited-set cycle guard. Projection math untouched.

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

export interface UV {
	u: number;
	v: number;
}

export interface Face {
	vertices: Vec3[];        // 4 vertices in 3D space (clockwise)
	uv: UV[];                // 4 UV coordinates (0-16)
	textureRef: string;      // e.g., "oak_planks", "cut_copper"
	normal: Vec3;            // Face normal for culling/sorting
}	export interface Element {
	from: [number, number, number];
	to: [number, number, number];
	faces: Record<string, {
		uv: number[];        // [u1, v1, u2, v2]
		texture: string;     // #bottom, #top, #side, #texture, etc.
		cullface?: string;   // down, up, north, south, west, east
		rotation?: number;   // 0, 90, 180 or 270 — clockwise texture rotation
	}>;
}

export interface DisplayTransform {
	rotation: [number, number, number];   // x, y, z degrees
	translation: [number, number, number];
	scale: [number, number, number];
}

// The standard Minecraft GUI/inventory display transform applied to block models.
// Used as the fallback when a model (or its parents) doesn't declare a gui transform.
const DEFAULT_GUI_TRANSFORM: DisplayTransform = {
	rotation: [30, 225, 0],
	translation: [0, 0, 0],
	scale: [0.625, 0.625, 0.625]
};

export interface ParsedModel {
	elements: Element[];
	textures: Record<string, string>;   // #bottom -> "oak_planks"
	display: {
		gui: DisplayTransform;
	};
}

export interface ResolvedModel {
	faces: Face[];
	display: {
		gui: DisplayTransform;
	};
}

// ---- Bounded LRU caches ----

const MODEL_CACHE_CAP = 150;
const RESOLVED_CACHE_CAP = 500;

const modelCache = new Map<string, unknown>();
const resolvedCache = new Map<string, ResolvedModel>();
const modelInflight = new Map<string, Promise<unknown>>();
const resolvedInflight = new Map<string, Promise<ResolvedModel | null>>();

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
	if (map.has(key)) map.delete(key);
	map.set(key, value);
	if (map.size > cap) {
		const oldest = map.keys().next();
		if (!oldest.done) map.delete(oldest.value);
	}
}

function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
	const v = map.get(key);
	if (v === undefined) return undefined;
	map.delete(key);
	map.set(key, v);
	return v;
}

const MODEL_BASE = '/data/models/block';
const ALL_MODELS_URL = '/data/models/all.json';

let allModelsPromise: Promise<Record<string, unknown>> | null = null;

// Precompiled patterns (avoid re-compiling per model/texture).
const MC_PREFIX_RE = /^minecraft:/;
const BLOCK_ITEM_DIR_RE = /^(block|item)\//;
const PARENT_MC_BLOCK_RE = /^minecraft:block\//;
const PARENT_BLOCK_RE = /^block\//;

/** Load the combined model bundle once (all block models in a single request). */
async function getAllModels(): Promise<Record<string, unknown>> {
	if (!allModelsPromise) {
		allModelsPromise = fetch(ALL_MODELS_URL, { cache: 'force-cache' } as RequestInit)
			.then((res) => (res.ok ? res.json() : Promise.resolve({})))
			.catch(() => ({} as Record<string, unknown>));
		// Allow retry if the bundle fetch itself rejects at the network layer
		// (the catch above already converts to {}, so this is a safety net).
		allModelsPromise.catch(() => {
			allModelsPromise = null;
		});
	}
	return allModelsPromise;
}

/**
 * Fetch a model JSON from the local data directory (via the combined bundle,
 * falling back to an individual file if the bundle is unavailable).
 * Dedupes concurrent fetches for the same name.
 */
async function fetchModel(name: string): Promise<unknown> {
	const cached = lruGet(modelCache, name);
	if (cached !== undefined) return cached;
	const inflight = modelInflight.get(name);
	if (inflight) return inflight;

	const p = (async (): Promise<unknown> => {
		try {
			const all = await getAllModels();
			const bundled = (all as Record<string, unknown>)[name];
			if (bundled !== undefined) {
				lruSet(modelCache, name, bundled, MODEL_CACHE_CAP);
				return bundled;
			}
		} catch {
			// Fall through to individual file.
		}
		try {
			const res = await fetch(`${MODEL_BASE}/${name}.json`, { cache: 'force-cache' } as RequestInit);
			if (!res.ok) {
				return null;
			}
			const data: unknown = await res.json();
			lruSet(modelCache, name, data, MODEL_CACHE_CAP);
			return data;
		} catch (e) {
			console.error(`fetchModel error for ${name}:`, e);
			return null;
		}
	})();

	modelInflight.set(name, p);
	try {
		return await p;
	} finally {
		modelInflight.delete(name);
	}
}

interface RawModel {
	parent?: unknown;
	textures?: unknown;
	elements?: Element[];
	display?: ParsedModel['display'];
}

/**
 * Recursively resolve a model including its parent.
 * `visited` guards against parent cycles (A -> B -> A).
 */
async function resolveModel(
	name: string,
	textures: Record<string, string> = {},
	visited: Set<string> = new Set<string>()
): Promise<ParsedModel | null> {
	if (visited.has(name)) return null;
	visited.add(name);

	const raw = (await fetchModel(name)) as RawModel | null;
	if (!raw) {
		return null;
	}
	const model = raw;

	// Merge textures from this model
	const mergedTextures: Record<string, string> = { ...textures };
	if (model.textures && typeof model.textures === 'object') {
		const entries = Object.entries(model.textures as Record<string, unknown>);
		for (let i = 0; i < entries.length; i++) {
			const key = entries[i][0];
			const value = entries[i][1];
			if (typeof value === 'string' && value.charCodeAt(0) === 35 /* # */) {
				// Resolve texture references like #bottom, #texture
				const ref = value.slice(1);
				mergedTextures[key] = mergedTextures[ref] || value;
			} else if (value && typeof value === 'object' && typeof (value as { sprite?: unknown }).sprite === 'string') {
				// New 26.1 format: { "sprite": "minecraft:block/foo", ... }
				mergedTextures[key] = (value as { sprite: string }).sprite;
			} else if (typeof value === 'string') {
				mergedTextures[key] = value;
			}
		}
	}

	// Resolve parent if exists
	let parentElements: Element[] = [];
	let parentDisplay: ParsedModel['display'] | null = null;
	let parentTextures: Record<string, string> = {};
	if (typeof model.parent === 'string' && model.parent) {
		const parentName = model.parent.replace(PARENT_MC_BLOCK_RE, '').replace(PARENT_BLOCK_RE, '');
		if (parentName && !visited.has(parentName)) {
			const parent = await resolveModel(parentName, mergedTextures, visited);
			if (parent) {
				parentElements = parent.elements;
				parentDisplay = parent.display;
				parentTextures = parent.textures;
			}
		}
	}

	// Get elements from this model
	const elements: Element[] = model.elements ? [...parentElements, ...model.elements] : parentElements;

	// Get display transform - inherit from parent if not overridden
	const display = model.display || parentDisplay || { gui: DEFAULT_GUI_TRANSFORM };

	// Use parent's FULLY RESOLVED textures (which include resolved #refs), falling back to local merged
	// This ensures face texture refs like #down, #up from parent are properly resolved
	const finalTextures = { ...mergedTextures, ...parentTextures };

	return {
		elements,
		textures: finalTextures,
		display
	};
}

/**
 * Apply rotation to a vertex around origin
 * MATH UNTOUCHED — do not modify projection math.
 */
function rotateVertex(v: Vec3, rx: number, ry: number, rz: number): Vec3 {
	// Convert to radians
	const deg2rad = Math.PI / 180;
	rx *= deg2rad;
	ry *= deg2rad;
	rz *= deg2rad;

	let x = v.x, y = v.y, z = v.z;

	// Minecraft composes display rotations as R = Rx · Ry · Rz, which means a
	// point is rotated about Z first, then Y, then X. Applying X first flips the
	// cube's orientation so the top face no longer faces the camera, which makes
	// inventory icons look wrong.
	// Rotate Z
	if (rz !== 0) {
		const cos = Math.cos(rz), sin = Math.sin(rz);
		const nx = x * cos - y * sin;
		const ny = x * sin + y * cos;
		x = nx; y = ny;
	}
	// Rotate Y
	if (ry !== 0) {
		const cos = Math.cos(ry), sin = Math.sin(ry);
		const nx = x * cos + z * sin;
		const nz = -x * sin + z * cos;
		x = nx; z = nz;
	}
	// Rotate X
	if (rx !== 0) {
		const cos = Math.cos(rx), sin = Math.sin(rx);
		const ny = y * cos - z * sin;
		const nz = y * sin + z * cos;
		y = ny; z = nz;
	}

	return { x, y, z };
}

/**
 * Apply display transform to a vertex
 * MATH UNTOUCHED.
 */
function applyDisplayTransform(v: Vec3, transform: DisplayTransform): Vec3 {
	// Translate to origin centered (8,8,8)
	let x = v.x - 8;
	let y = v.y - 8;
	let z = v.z - 8;

	// Apply rotation
	const rotated = rotateVertex({ x, y, z }, transform.rotation[0], transform.rotation[1], transform.rotation[2]);
	x = rotated.x; y = rotated.y; z = rotated.z;

	// Apply scale
	x *= transform.scale[0];
	y *= transform.scale[1];
	z *= transform.scale[2];

	// Apply translation
	x += transform.translation[0];
	y += transform.translation[1];
	z += transform.translation[2];

	// Translate back
	x += 8;
	y += 8;
	z += 8;

	return { x, y, z };
}

/**
 * Get face normal from face name
 */
function getFaceNormal(faceName: string): Vec3 {
	switch (faceName) {
		case 'up': return { x: 0, y: 1, z: 0 };
		case 'down': return { x: 0, y: -1, z: 0 };
		case 'north': return { x: 0, y: 0, z: -1 };
		case 'south': return { x: 0, y: 0, z: 1 };
		case 'west': return { x: -1, y: 0, z: 0 };
		case 'east': return { x: 1, y: 0, z: 0 };
		default: return { x: 0, y: 0, z: 0 };
	}
}

/**
 * Get vertices for a face of a cuboid
 * MATH UNTOUCHED.
 */
function getFaceVertices(element: Element, faceName: string): Vec3[] {
	const { from, to } = element;
	// Model JSON uses arrays [x, y, z], not objects with x,y,z
	const minX = Math.min(from[0], to[0]);
	const maxX = Math.max(from[0], to[0]);
	const minY = Math.min(from[1], to[1]);
	const maxY = Math.max(from[1], to[1]);
	const minZ = Math.min(from[2], to[2]);
	const maxZ = Math.max(from[2], to[2]);

	// Vertices ordered clockwise when looking at face from outside
	switch (faceName) {
		case 'down': // bottom face (y = minY)
			return [
				{ x: minX, y: minY, z: minZ }, // 0,0
				{ x: maxX, y: minY, z: minZ }, // 1,0
				{ x: maxX, y: minY, z: maxZ }, // 1,1
				{ x: minX, y: minY, z: maxZ }  // 0,1
			];
		case 'up': // top face (y = maxY)
			return [
				{ x: minX, y: maxY, z: maxZ },
				{ x: maxX, y: maxY, z: maxZ },
				{ x: maxX, y: maxY, z: minZ },
				{ x: minX, y: maxY, z: minZ }
			];
		case 'north': // z = minZ
			return [
				{ x: minX, y: minY, z: minZ },
				{ x: minX, y: maxY, z: minZ },
				{ x: maxX, y: maxY, z: minZ },
				{ x: maxX, y: minY, z: minZ }
			];
		case 'south': // z = maxZ
			return [
				{ x: maxX, y: minY, z: maxZ },
				{ x: maxX, y: maxY, z: maxZ },
				{ x: minX, y: maxY, z: maxZ },
				{ x: minX, y: minY, z: maxZ }
			];
		case 'west': // x = minX
			return [
				{ x: minX, y: minY, z: maxZ },
				{ x: minX, y: maxY, z: maxZ },
				{ x: minX, y: maxY, z: minZ },
				{ x: minX, y: minY, z: minZ }
			];
		case 'east': // x = maxX
			return [
				{ x: maxX, y: minY, z: minZ },
				{ x: maxX, y: maxY, z: minZ },
				{ x: maxX, y: maxY, z: maxZ },
				{ x: maxX, y: minY, z: maxZ }
			];
		default:
			return [];
	}
}

/**
 * Normalize a texture name to the bare file name used by texture-loader.
 * Handles the two prefixes found in vanilla models: "minecraft:block/foo",
 * "block/foo" (some models like grass_block omit the "minecraft:" namespace),
 * and the occasional "minecraft:item/foo".
 */
function normalizeTextureName(name: string): string {
	return name
		.replace(MC_PREFIX_RE, '')
		.replace(BLOCK_ITEM_DIR_RE, '');
}

/**
 * Resolve texture reference (#bottom -> actual texture name)
 */
function resolveTextureRef(ref: string, textures: Record<string, string>): string {
	if (ref.charCodeAt(0) === 35 /* # */) {
		const key = ref.slice(1);
		return textures[key] ? normalizeTextureName(textures[key]) : normalizeTextureName(key);
	}
	// A few models (e.g. heavy_core) reference a texture-map key without the
	// leading "#". Resolve those against the map as well when the key exists.
	if (textures[ref]) return normalizeTextureName(textures[ref]);
	return normalizeTextureName(ref);
}

/**
 * Parse UV coordinates from model format [u1, v1, u2, v2] to 4 UV points.
 * If UV is undefined, auto-calculate it from the face and element bounds.
 *
 * The texture region [u1, v1, u2, v2] (top-left to bottom-right) is mapped to
 * the face's 4 corners so the texture appears upright when the face is viewed
 * from outside the block. The vertex order from getFaceVertices is clockwise
 * when viewed from outside, so each face needs its own corner mapping.
 * MATH UNTOUCHED.
 */
function parseUV(uv: number[] | undefined, faceName: string, element: Element, rotation: number = 0): UV[] {
	const { from, to } = element;
	const minX = Math.min(from[0], to[0]);
	const maxX = Math.max(from[0], to[0]);
	const minY = Math.min(from[1], to[1]);
	const maxY = Math.max(from[1], to[1]);
	const minZ = Math.min(from[2], to[2]);
	const maxZ = Math.max(from[2], to[2]);

	// Determine the texture region [u1, v1, u2, v2].
	let u1: number, v1: number, u2: number, v2: number;
	if (uv) {
		[u1, v1, u2, v2] = uv;
	} else {
		// Minecraft auto-UV: derive from the element's position per face.
		switch (faceName) {
			case 'down':
			case 'up':
				u1 = minX; u2 = maxX; v1 = minZ; v2 = maxZ;
				break;
			case 'north':
			case 'south':
				u1 = minX; u2 = maxX; v1 = minY; v2 = maxY;
				break;
			case 'west':
			case 'east':
				u1 = minZ; u2 = maxZ; v1 = minY; v2 = maxY;
				break;
			default:
				u1 = 0; u2 = 16; v1 = 0; v2 = 16;
		}
	}

	// Map the region to the 4 corners in getFaceVertices order.
	let corners: UV[];
	switch (faceName) {
		case 'down':
			corners = [
				{ u: u2, v: v1 },
				{ u: u1, v: v1 },
				{ u: u1, v: v2 },
				{ u: u2, v: v2 }
			];
			break;
		case 'up':
			corners = [
				{ u: u1, v: v2 },
				{ u: u2, v: v2 },
				{ u: u2, v: v1 },
				{ u: u1, v: v1 }
			];
			break;
		case 'north':
		case 'south':
		case 'west':
		case 'east':
			corners = [
				{ u: u2, v: v2 },
				{ u: u2, v: v1 },
				{ u: u1, v: v1 },
				{ u: u1, v: v2 }
			];
			break;
		default:
			corners = [
				{ u: u1, v: v1 },
				{ u: u2, v: v1 },
				{ u: u2, v: v2 },
				{ u: u1, v: v2 }
			];
	}

	// Apply Minecraft's face "rotation": a clockwise permutation of the texture
	// corners (does not change which region of the texture is sampled). The four
	// corners are stored in the same clockwise order as getFaceVertices, so
	// rotating the texture N*90° clockwise is a cyclic left-shift by N.
	const steps = Math.round(((rotation % 360) + 360) % 360 / 90) % 4;
	if (steps > 0) {
		corners = [...corners.slice(steps), ...corners.slice(0, steps)];
	}
	return corners;
}

/**
 * Main function: parse a model name into resolved faces ready for rendering.
 * Dedupes concurrent parses for the same model.
 */
export async function parseModel(modelName: string): Promise<ResolvedModel | null> {
	// Check cache first
	const hit = lruGet(resolvedCache, modelName);
	if (hit !== undefined) return hit;
	const inflight = resolvedInflight.get(modelName);
	if (inflight) return inflight;

	const p = (async (): Promise<ResolvedModel | null> => {
		const parsed = await resolveModel(modelName);
		if (!parsed) {
			return null;
		}

		const faces: Face[] = [];
		const guiTransform = parsed.display.gui || DEFAULT_GUI_TRANSFORM;

		const elements = parsed.elements;
		for (let ei = 0; ei < elements.length; ei++) {
			const element = elements[ei];
			const faceEntries = Object.entries(element.faces);
			for (let fi = 0; fi < faceEntries.length; fi++) {
				const faceName = faceEntries[fi][0];
				const faceData = faceEntries[fi][1];
				const vertices = getFaceVertices(element, faceName);
				if (vertices.length !== 4) continue;

				// Apply display transform to each vertex
				const v0 = applyDisplayTransform(vertices[0], guiTransform);
				const v1 = applyDisplayTransform(vertices[1], guiTransform);
				const v2 = applyDisplayTransform(vertices[2], guiTransform);
				const v3 = applyDisplayTransform(vertices[3], guiTransform);

				const textureRef = resolveTextureRef(faceData.texture, parsed.textures);
				const uv = parseUV(faceData.uv, faceName, element, faceData.rotation);
				const normal = getFaceNormal(faceName);

				faces.push({
					vertices: [v0, v1, v2, v3],
					uv,
					textureRef,
					normal
				});
			}
		}

		if (faces.length === 0) {
			return null;
		}

		const result: ResolvedModel = {
			faces,
			display: parsed.display
		};

		lruSet(resolvedCache, modelName, result, RESOLVED_CACHE_CAP);
		return result;
	})();

	resolvedInflight.set(modelName, p);
	try {
		return await p;
	} finally {
		resolvedInflight.delete(modelName);
	}
}

/**
 * Get the inventory model name for a block (handles blockstates)
 */
export function getInventoryModelName(blockName: string): string {
	// For most blocks, the inventory model is the base model
	// For stairs/slabs, use the straight/bottom variant
	// For fences, use fence_inventory
	// This is a simplified version - in reality we'd parse blockstate

	if (blockName.endsWith('_stairs')) {
		return blockName; // oak_stairs (shape=straight,half=bottom,facing=north is default)
	}
	if (blockName.endsWith('_slab')) {
		return blockName; // oak_slab (type=bottom is default)
	}
	if (blockName.endsWith('_fence')) {
		return `${blockName}_inventory`; // oak_fence_inventory
	}
	if (blockName.endsWith('_fence_gate')) {
		return `${blockName}_inventory`; // oak_fence_gate_inventory
	}
	if (blockName.endsWith('_wall')) {
		return `${blockName}_inventory`; // cobblestone_wall_inventory
	}
	if (blockName.includes('copper_bars')) {
		return 'copper_bars_post_ends'; // multipart, use post for inventory
	}
	if (blockName.includes('copper_chain')) {
		return 'copper_chain';
	}
	if (blockName.includes('copper_lantern')) {
		return 'copper_lantern';
	}
	if (blockName.includes('lightning_rod')) {
		return blockName; // lightning_rod
	}

	return blockName;
}

/**
 * Clear caches (useful for testing)
 */
export function clearModelCache() {
	modelCache.clear();
	resolvedCache.clear();
	modelInflight.clear();
	resolvedInflight.clear();
	allModelsPromise = null;
}
