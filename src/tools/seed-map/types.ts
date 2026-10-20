/*
 * Seed Map — types.ts
 * Shared geometry/state types for the map layer (docs/seed-map-architecture.md
 * sections 3 and 4). Pure data + pure functions: no DOM, no workers, so every
 * browser module and the test suite can agree on one vocabulary.
 */

import { seedToHex, splitSeed, type Seed64 } from './wasm/seed64';

/** World-space rectangle in blocks ([x0, x0+w) x [z0, z0+h)). */
export type WorldRect = { x0: number; z0: number; w: number; h: number };

/**
 * Camera of the map view: the world-space center and how many world blocks
 * one CSS pixel covers (cubiomes-style "blocks per pixel"; the inverse is the
 * screen scale). Everything below derives from these two numbers — the view
 * never stores both a blocks-per-pixel AND a scale, they are kept in lockstep.
 */
export type CameraState = {
	/** Center of the viewport in world blocks (x). */
	cx: number;
	/** Center of the viewport in world blocks (z). */
	cz: number;
	/** World blocks per CSS pixel. */
	blocksPerPixel: number;
	/** Backing-store multiplier of the canvases (devicePixelRatio, capped). */
	dpr: number;
};

/** A viewport snapshot the tile manager keys requests and generations on. */
export type ViewState = {
	/** Cubiomes LOD scale currently feeding tiles: {256, 4, 1}. */
	scale: number;
	/** Viewport generation, monotonic per camera/LOD epoch. */
	generation: number;
} & CameraState;

/**
 * Hard world bounds, kept "WebGL-reasonable" at ±30M blocks (vanilla world
 * border sits just inside; the spec's 60M-wide window). Anti-overflow rule:
 * clamps are the ONLY place raw world coordinates touch these limits.
 */
export const WORLD_LIMIT = 30_000_000;

/** Cubiomes tileSize constant for a rendered tile (docs section 4). */
export const TILE_SIZE = 256;

/**
 * The three native cubiomes LOD scales. A tile at scale S covers
 * TILE_SIZE * S world blocks on a side and one pixel per S blocks.
 */
export const LOD_SCALES = [1, 4, 256] as const;

/**
 * LOD thresholds (map-view documentation of record):
 *
 *   scale 256   blocksPerPixel >= 32        (overview; 8+ blocks under-resampling)
 *   scale 4     1.6 <= blocksPerPixel < 32  (default map view, 1:4 native)
 *   scale 1     blocksPerPixel < 1.6        (2.5x past the native 1:4 tile)
 *
 * Rationale: below 1.6 bpp the 1:4 tile grid must be magnified at least 2.5x
 * before it is worth native sampling (1:1 tiles cost 16x the pixels); above
 * 32 bpp the browser magnifies 1:4 tiles by 8x or more, and the 256-sample
 * map render is visibly crisper at a fraction of the tile count.
 */
export function lodScaleFor(blocksPerPixel: number): number {
	if (blocksPerPixel >= 32) return 256;
	if (blocksPerPixel < 1.6) return 1;
	return 4;
}

/** World blocks covered by one tile of the given LOD scale. */
export function tileWorldSize(scale: number): number {
	return TILE_SIZE * scale;
}

/** Canonical, collision-free tile key (docs section 4):
 * `seedHex | version | dim | scale | tx | tz`. seedHex is the 16-digit
 * lowercase hex of the 64-bit seed: beyond 2^53 numeric keys collide, hex
 * does not, and DevTools stays readable. */
export type TileKey = {
	/** 64-bit halves (the canonical form is derived from these, never Number). */
	seed: Seed64;
	/** cubiomes MC enum value (MC_1_18..MC_NEWEST). */
	version: number;
	/** cubiomes dimension (0 overworld in the MVP). */
	dim: number;
	/** cubiomes LOD scale ({1, 4, 256}). */
	scale: number;
	/** Tile grid coordinates at that scale (north-west corner). */
	tx: number;
	tz: number;
};

/** Produces the canonical string form of a TileKey. */
export function tileKeyToString(key: TileKey): string {
	return [
		seedToHex(key.seed),
		key.version,
		key.dim,
		key.scale,
		key.tx,
		key.tz,
	].join('|');
}

/** Parses a canonical key back into its parts (tests/debugging round-trips). */
export function parseTileKey(text: string): TileKey {
	const parts = text.split('|');
	if (parts.length !== 6) throw new Error('malformed TileKey: ' + text);
	return {
		seed: splitSeed(BigInt('0x' + parts[0]!)),
		version: Number(parts[1]),
		dim: Number(parts[2]),
		scale: Number(parts[3]),
		tx: Number(parts[4]),
		tz: Number(parts[5]),
	};
}

/**
 * World-floor tile coordinates: which tile contains block (x, z) at `scale`
 * (negative-safe floor division, unlike the JS `Math.floor` of a division).
 */
export function worldToTileCoord(x: number, z: number, scale: number): { tx: number; tz: number } {
	const size = tileWorldSize(scale);
	return { tx: Math.floor(x / size), tz: Math.floor(z / size) };
}

/** Manhattan distance, the center-out priority metric of docs section 3. */
export function manhattan(ax: number, az: number, bx: number, bz: number): number {
	return Math.abs(ax - bx) + Math.abs(az - bz);
}
