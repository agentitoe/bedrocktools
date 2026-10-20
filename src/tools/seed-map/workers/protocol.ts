/*
 * Seed Map — workers/protocol.ts
 * Message contract between the worker pool (main thread) and seed-worker.ts
 * (worker thread). Mirrors docs/seed-map-architecture.md section 3.
 *
 * Wire rules:
 *   - postMessage payloads must remain structured-cloneable; pixel buffers go
 *     out as transferables (Uint8ClampedArray), never as plain arrays.
 *   - `gen` is the viewport generation stamp. The worker refuses work older
 *     than the newest generation it has seen WITHOUT running the WASM
 *     ("optimistic discard"); the pool additionally drops late results.
 *   - ids are pool-assigned and monotonically increasing; every request id is
 *     answered at most once (result or error) unless it is cancelled or its
 *     generation goes stale.
 */

import type { Seed64 } from '../wasm/seed64';

/** Tile geometry in world/scale units. (x, z) is the north-west corner. */
export type TileSpec = {
	x: number;
	z: number;
	/** cubiomes horizontal scale: one of {1, 4, 16, 64, 256}. */
	scale: number;
	/** Defaults to 256 cells; only overridden by tests. */
	w?: number;
	h?: number;
};

/** Region rectangle in structure-region units ([x0, x0+w) x [z0, z0+h)). */
export type RegionRect = {
	x0: number;
	z0: number;
	w: number;
	h: number;
};

/** Seed + version + dimension, sent with every request that needs them. */
export type SeedVersion = {
	seed: Seed64;
	/** cubiomes MC enum value (MC_1_18..MC_NEWEST). */
	version: number;
	/** cubiomes dimension: 0 overworld, -1 nether, +1 end. */
	dim: number;
};

export type StructureScan = {
	type: number;
	region: RegionRect;
	/** Optional structure-specific info (e.g. village variant), passes to
	 * isViableStructurePos. 0 = defaults. */
	flags: number;
};

/** Main -> worker. */
export type WorkerRequest =
	| ({ id: number; gen: number; kind: 'tiles' } & SeedVersion & { tiles: TileSpec[] })
	| ({ id: number; gen: number; kind: 'structures' } & SeedVersion & StructureScan)
	| { id: number; gen: number; kind: 'spawn' } & SeedVersion
	| { id: number; kind: 'reset' } & SeedVersion;

/** Bitmap responses keep their buffer: one entry per generated tile. */
export type TileResult = {
	x: number;
	z: number;
	scale: number;
	w: number;
	h: number;
	/** Biome ids as bytes (see EXT_BIOME_NONE), transferable. */
	pixels: Uint8ClampedArray;
};

/** E2 carries cubiomes' numeric structure enum; the typed catalog lands in
 * E4 (constants + versions) and reuses this shape. */
export type StructureHit = {
	type: number;
	x: number;
	z: number;
};

/** Worker -> main. */
export type WorkerResult =
	| { id: number; gen: number; kind: 'tiles'; results: TileResult[] }
	| { id: number; gen: number; kind: 'structures'; hits: StructureHit[] }
	| { id: number; gen: number; kind: 'spawn'; x: number; z: number }
	| { id: number; kind: 'reset' }
	| { id: number; kind: 'error'; message: string }
	| { id: number; kind: 'cancelled' };

/** Cancel pending requests by id (batch cancellation). In-flight work is NOT
 * interrupted; the pool discards its result on arrival. */
export type WorkerCancel = { type: 'cancel'; ids: number[] };

/** Optimistic discard: queued work with gen < generation is skipped without
 * running the WASM. Also raises the worker's current generation. */
export type WorkerDrop = { type: 'drop-priority'; generation: number };

/** Anything the worker can receive. */
export type WorkerInbound = WorkerRequest | WorkerCancel | WorkerDrop;

/** Single biome byte in a TileResult result, for tiles decoded anywhere. */
export const TILE_INVALID_BIOME = 0xff;
