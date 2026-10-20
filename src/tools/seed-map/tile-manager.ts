/*
 * Seed Map — tile-manager.ts
 * LRU tile cache on demand (docs/seed-map-architecture.md sections 3-4).
 * Owns WHAT is missing and in what order; knows nothing about canvas.
 *
 * Contract recap:
 *   - TileKey = seed64hex|version|dim|scale|tx|tz (types.ts, collision-free
 *     across seeds beyond 2^53). A tile is one pool request.
 *   - setViewport(rect, scale): trims the visible rect + 1 tile margin,
 *     orders tiles center-out (Manhattan to the viewport center tile),
 *     dedupes against cache AND pending requests, and submits ONE batch.
 *   - Batches that leave the view entirely are cancelled (queue settles +
 *     workers skip late ids); partially overlapping batches stay in flight
 *     so smooth panning never re-generates shared tiles.
 *   - Generation is a two-axis epoch: bumped on seed/version/dim change and
 *     on LOD scale change. Pan NEVER bumps it — pool discards would throw
 *     away healthy overlapping in-flight tiles. On epoch bumps the discards
 *     are exactly the wanted behavior.
 *   - setState() is the seed-change barrier: cache flush (every old entry
 *     emits onEvict), pool.reset() re-seeds all workers before new work
 *     runs, and results of batches submitted under an older epoch are
 *     dropped on arrival. A fast seed change cannot mix biome sets.
 *   - LRU capacity ~160 tiles (~0.25 MB each); eviction walks the insertion
 *     order cache and provably skips the currently visible keys.
 */

import {
	manhattan,
	tileKeyToString,
	tileWorldSize,
	worldToTileCoord,
	type TileKey,
	type WorldRect,
} from './types';
import { seedToHex, type Seed64 } from './wasm/seed64';
import type { PoolBatch, PoolResult, Unsubscribe } from './workers/worker-pool';
import type { SeedVersion } from './workers/protocol';
import type { TileResult } from './workers/protocol';

/** Structural pool dependency (real WorkerPool satisfies this). */
export interface TilePoolLike {
	submit(batch: PoolBatch): number;
	cancelBatch(batchId: number): void;
	advanceGeneration(gen: number): void;
	reset(seed: bigint, version: number, dim: number): Promise<void>;
	onResult(cb: (result: PoolResult) => void): Unsubscribe;
}

/** A generated tile in the cache. `pixels` is 1 byte of biome id per cell. */
export type TileEntry = {
	key: TileKey;
	keyString: string;
	tile: TileResult;
	/** Insertion timestamp (monotonic within a manager instance). */
	ts: number;
	/** Approximate retained bytes (pixel data). */
	bytes: number;
};

export type TileManagerOptions = {
	pool: TilePoolLike;
	/** LRU capacity in tiles (docs: ~160 tiles ≈ 64 MB worst case). */
	maxTiles?: number;
	/** Tiles of overlap requested around the viewport (docs: 1). */
	marginTiles?: number;
	/** Upper bound of ONE batch to bound zoom-out bursts. */
	maxBatchTiles?: number;
	/** Clock for LRU stamps (tests inject a counter). */
	now?: () => number;
};

export type ViewportIn = {
	rect: WorldRect;
	scale: number;
	dim?: number; // informational only; state lives in setState
};

const DEFAULT_MAX_TILES = 160;
const DEFAULT_MARGIN = 1;
const DEFAULT_MAX_BATCH = 256;

export class TileManager {
	private readonly pool: TilePoolLike;
	private readonly maxTiles: number;
	private readonly marginTiles: number;
	private readonly maxBatchTiles: number;
	private readonly now: () => number;
	private readonly poolUnsubscribe: Unsubscribe;

	/** Insertion-ordered cache = LRU (get() re-inserts to refresh). */
	private cache = new Map<string, TileEntry>();
	/** key -> batchIds still able to deliver it. */
	private inFlight = new Map<string, Set<number>>();
	/** batchId -> tracked batch. */
	private batches = new Map<number, BatchTrack>();

	/** Current world state the cache is bound to. */
	private state: SeedVersion | null = null;
	/** Viewport generation epoch; pool sees strictly increasing numbers. */
	private generation = 0;
	private lastScale: number | null = null;
	private visibleKeys = new Set<string>();

	private tileHandlers = new Set<(entry: TileEntry) => void>();
	private evictHandlers = new Set<(key: string) => void>();
	private errorHandlers = new Set<(message: string) => void>();

	private disposed = false;

	constructor(opts: TileManagerOptions) {
		this.pool = opts.pool;
		this.maxTiles = opts.maxTiles ?? DEFAULT_MAX_TILES;
		this.marginTiles = opts.marginTiles ?? DEFAULT_MARGIN;
		this.maxBatchTiles = opts.maxBatchTiles ?? DEFAULT_MAX_BATCH;
		this.now = opts.now ?? (() => Date.now());
		this.poolUnsubscribe = this.pool.onResult((result) => this.onPoolResult(result));
	}

	// ------------------------------------------------------------- events

	onTileReady(cb: (entry: TileEntry) => void): () => void {
		this.tileHandlers.add(cb);
		return () => void this.tileHandlers.delete(cb);
	}

	onEvict(cb: (keyString: string) => void): () => void {
		this.evictHandlers.add(cb);
		return () => void this.evictHandlers.delete(cb);
	}

	onError(cb: (message: string) => void): () => void {
		this.errorHandlers.add(cb);
		return () => void this.errorHandlers.delete(cb);
	}

	// ---------------------------------------------------------------- state

	/**
	 * Seed/world-state change (task 2.4 semantics): flush the cache NOW so
	 * no stale biome byte survives, then jangles the pool's reset barrier.
	 * New viewport requests must wait for this promise.
	 */
	async setState(seed: bigint, version: number, dim: number): Promise<void> {
		if (this.disposed) throw new Error('tile manager is disposed');
		await this.pool.reset(seed, version, dim);
		// The barrier resolved: from here on, every worker is on the new state.
		this.state = { seed: { hi: Number(BigInt.asIntN(32, seed >> 32n)), lo: Number(BigInt.asUintN(32, seed & 0xffffffffn)) }, version, dim };
		this.generation += 1;
		this.lastScale = null;
		// Whatever survived tracking is stale: bump the floor and forget it.
		this.pool.advanceGeneration(this.generation);
		this.dropAllBatches(false);
		this.flushAll();
	}

	/** Current cached state (null before the first setState resolves). */
	getState(): SeedVersion | null {
		return this.state === null ? null : { ...this.state };
	}

	/** Tiles currently queued or running somewhere in the pool. */
	get pendingCount(): number {
		let n = 0;
		for (const batch of this.batches.values()) n += batch.keys.size;
		return n;
	}

	get cachedCount(): number {
		return this.cache.size;
	}

	// ------------------------------------------------------------ viewport

	/**
	 * Viewport update: request what is missing (ordered center-out, with a
	 * `marginTiles` ring) and cancel batches that fully left the view.
	 */
	setViewport(view: ViewportIn): void {
		if (this.disposed || this.state === null) return;
		if (view.scale !== this.lastScale && this.lastScale !== null) {
			// LOD epoch: forget in-flight work of the previous scale — the
			// pool discards it silently (results below the new gen floor),
			// so tracking it would block the same keys forever.
			this.generation += 1;
			this.pool.advanceGeneration(this.generation);
			this.dropAllBatches(false);
			this.lastScale = view.scale;
		} else if (this.lastScale === null) {
			this.lastScale = view.scale;
		}

		const wanted = this.visibleTileKeys(view);
		const wantedStrings = wanted.map(tileKeyToString);
		this.visibleKeys = new Set(wantedStrings);
		const missing: TileKey[] = [];
		for (const key of wanted) {
			const keyString = tileKeyToString(key);
			if (this.cache.has(keyString)) continue;
			if (this.inFlight.has(keyString)) continue;
			missing.push(key);
		}

		if (missing.length > 0) {
			const cxTile = (worldToTileCoord(
				Math.round(view.rect.x0 + view.rect.w / 2),
				Math.round(view.rect.z0 + view.rect.h / 2),
				view.scale,
			));
			missing.sort(
				(a, b) =>
					manhattan(a.tx, a.tz, cxTile.tx, cxTile.tz) - manhattan(b.tx, b.tz, cxTile.tx, cxTile.tz)
					|| a.tx - b.tx || a.tz - b.tz,
			);
			const capped = missing.slice(0, this.maxBatchTiles);
			this.submitBatch(view.scale, capped);
		}

		// Cancel batches whose keys are ALL no longer wanted.
		for (const batch of [...this.batches.values()]) {
			let stillWanted = false;
			for (const keyString of batch.keys) {
				if (this.visibleKeys.has(keyString)) {
					stillWanted = true;
					break;
				}
			}
			if (!stillWanted) this.dropBatch(batch.batchId, true);
		}
	}

	// -------------------------------------------------------------- cache

	/** Lookup with LRU touch; null when absent or pending. */
	getTile(keyString: string): TileEntry | null {
		const entry = this.cache.get(keyString);
		if (entry === undefined) return null;
		// Refresh recency: delete + re-append (Map preserves insertion order).
		this.cache.delete(keyString);
		this.cache.set(keyString, entry);
		return entry;
	}

	/** Drop every cached tile (seed change). Emits onEvict per entry. */
	flushAll(): void {
		for (const [keyString] of [...this.cache]) {
			this.removeEntry(keyString);
		}
	}

	/** Cleanup: unsubscribes from the pool (workers are owned by the pool). */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.poolUnsubscribe();
		this.flushAll();
		this.batches.clear();
		this.inFlight.clear();
		this.tileHandlers.clear();
		this.evictHandlers.clear();
		this.errorHandlers.clear();
	}

	// ------------------------------------------------------------- helpers

	/**
	 * Visible rect expanded by `marginTiles` at the tile grid, clamped to the
	 * hard world limit. Row-major here; the center-out priority ordering is
	 * applied by submitBatch().
	 */
	private visibleTileKeys(view: ViewportIn): TileKey[] {
		const size = tileWorldSize(view.scale);
		const tileOf = (v: number) => Math.floor(v / size);
		const rect = {
			x0: clampWorld(view.rect.x0), z0: clampWorld(view.rect.z0),
			x1: clampWorld(view.rect.x0 + view.rect.w), z1: clampWorld(view.rect.z0 + view.rect.h),
		};
		const tx0 = tileOf(rect.x0) - this.marginTiles;
		const tx1 = tileOf(rect.x1) + this.marginTiles;
		const tz0 = tileOf(rect.z0) - this.marginTiles;
		const tz1 = tileOf(rect.z1) + this.marginTiles;

		const keys: TileKey[] = [];
		for (let tz = tz0; tz <= tz1; tz++) {
			for (let tx = tx0; tx <= tx1; tx++) {
				keys.push({
					seed: { ...this.state!.seed },
					version: this.state!.version,
					dim: this.state!.dim,
					scale: view.scale,
					tx, tz,
				});
			}
		}
		return keys;
	}

	private submitBatch(scale: number, keys: TileKey[]): void {
		const state = this.state!;
		const batch: PoolBatch = {
			kind: 'tiles',
			gen: this.generation,
			state: { seed: { ...state.seed }, version: state.version, dim: state.dim },
			tiles: keys.map((k) => ({ x: k.tx * tileWorldSize(scale), z: k.tz * tileWorldSize(scale), scale })),
		};
		const batchId = this.pool.submit(batch);
		const tracked: BatchTrack = {
			batchId,
			gen: this.generation,
			scale,
			seedHex: seedToHex(state.seed),
			keys: new Set(keys.map(tileKeyToString)),
		};
		this.batches.set(batchId, tracked);
		for (const keyString of tracked.keys) {
			this.inFlightFor(keyString).add(batchId);
		}
	}

	private inFlightFor(keyString: string): Set<number> {
		let set = this.inFlight.get(keyString);
		if (set === undefined) {
			set = new Set<number>();
			this.inFlight.set(keyString, set);
		}
		return set;
	}

	private clearInFlightOwner(keyString: string, batchId: number): void {
		const owners = this.inFlight.get(keyString);
		if (owners === undefined) return;
		owners.delete(batchId);
		if (owners.size === 0) this.inFlight.delete(keyString);
	}

	/** Forgets every tracked batch; `cancel` also settles pool work. */
	private dropAllBatches(cancel: boolean): void {
		for (const batchId of [...this.batches.keys()]) {
			this.dropBatch(batchId, cancel);
		}
	}

	/** Removes batch tracking; optional pool.cancelBatch(). */
	private dropBatch(batchId: number, cancel: boolean): void {
		const batch = this.batches.get(batchId);
		if (batch === undefined) return;
		this.batches.delete(batchId);
		if (cancel) this.pool.cancelBatch(batchId);
		for (const keyString of batch.keys) {
			const owners = this.inFlight.get(keyString);
			if (owners === undefined) continue;
			owners.delete(batchId);
			if (owners.size === 0) this.inFlight.delete(keyString);
		}
	}

	private onPoolResult(result: PoolResult): void {
		switch (result.kind) {
			case 'cancelled': {
				// A cancelFeed from pool.reset()/dispose(): the batch is gone.
				this.dropBatch(result.batchId, false);
				break;
			}
			case 'tiles': {
				const batch = this.batches.get(result.batchId);
				if (batch === undefined) return; // cancelled or unknown batch
				if (batch.gen !== this.generation) {
					// Stale epoch (seed change / LOD change raced the pool).
					this.dropBatch(result.batchId, true);
					return;
				}
				this.putTile(batch, result.tile);
				break;
			}
			case 'error':
				for (const handler of this.errorHandlers) handler(result.message);
				break;
			default:
				// 'structures'/'spawn' results flow to their own consumers.
				break;
		}
	}

	private putTile(batch: BatchTrack, tile: TileResult): void {
		const key: TileKey = {
			seed: { ...this.state!.seed },
			version: this.state!.version,
			dim: this.state!.dim,
			scale: tile.scale,
			tx: Math.floor(tile.x / tileWorldSize(tile.scale)),
			tz: Math.floor(tile.z / tileWorldSize(tile.scale)),
		};
		const keyString = tileKeyToString(key);
		batch.keys.delete(keyString);
		this.clearInFlightOwner(keyString, batch.batchId);

		const entry: TileEntry = {
			key,
			keyString,
			tile,
			ts: this.now(),
			bytes: tile.pixels.byteLength,
		};
		this.cache.delete(keyString);
		this.cache.set(keyString, entry);
		this.evictIfNeeded();
		for (const handler of this.tileHandlers) handler(entry);

		if (batch.keys.size === 0) this.batches.delete(batch.batchId);
	}

	/** LRU eviction: oldest first; visible entries are the last to go. */
	private evictIfNeeded(): void {
		let excess = this.cache.size - this.maxTiles;
		if (excess <= 0) return;
		// Pass 1: drop oldest entries outside the current viewport.
		for (const keyString of [...this.cache.keys()]) {
			if (excess <= 0) break;
			if (this.visibleKeys.has(keyString)) continue;
			if (this.removeEntry(keyString)) excess--;
		}
		// Pass 2 (pressure wins over visibility): oldest regardless.
		for (const keyString of [...this.cache.keys()]) {
			if (excess <= 0) break;
			if (this.removeEntry(keyString)) excess--;
		}
	}

	private removeEntry(keyString: string): boolean {
		if (!this.cache.delete(keyString)) return false;
		for (const handler of this.evictHandlers) handler(keyString);
		return true;
	}
}

interface BatchTrack {
	batchId: number;
	gen: number;
	scale: number;
	seedHex: string;
	keys: Set<string>;
}

function clampWorld(v: number): number {
	const limit = 30_000_000;
	if (v < -limit) return -limit;
	if (v > limit) return limit;
	return v;
}
