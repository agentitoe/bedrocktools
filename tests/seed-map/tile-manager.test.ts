/*
 * Seed Map — tile-manager tests with a deterministic mock pool.
 * No real timers/workers: results pushed manually, LRU clock injected.
 */

import { test, expect } from 'bun:test';
import {
	TileManager,
	type TileEntry,
	type TilePoolLike,
} from '../../src/tools/seed-map/tile-manager';
import type { PoolBatch, PoolResult } from '../../src/tools/seed-map/workers/worker-pool';
import { tileKeyToString } from '../../src/tools/seed-map/types';

const SEED = 845932142563n;
const VERSION = 32;

/** Deterministic mock pool: records batches, replays results manually. */
class MockPool implements TilePoolLike {
	submitted: PoolBatch[] = [];
	inbound: number[] = []; // cancels (-batchId) and generation bumps (+gen)
	private handlers = new Set<(r: PoolResult) => void>();
	private batchSeq = 0;

	lastReset: { seed: bigint; version: number; dim: number } | null = null;

	submit(batch: PoolBatch): number {
		this.submitted.push(batch);
		return ++this.batchSeq;
	}

	cancelBatch(batchId: number): void {
		this.inbound.push(-batchId);
	}

	advanceGeneration(gen: number): void {
		this.inbound.push(gen);
	}

	async reset(seed: bigint, version: number, dim: number): Promise<void> {
		this.lastReset = { seed, version, dim };
	}

	onResult(cb: (result: PoolResult) => void): () => void {
		this.handlers.add(cb);
		return () => void this.handlers.delete(cb);
	}

	/** Simulates the pool settling one tile task of the given batch. */
	pushTile(batchId: number, gen: number, tx: number, tz: number, scale = 4): void {
		const result: PoolResult = {
			batchId,
			gen,
			kind: 'tiles',
			tile: {
				x: tx * scale * 256, z: tz * scale * 256, scale,
				w: 256, h: 256, pixels: new Uint8ClampedArray(256 * 256).fill(tx & 0x7f),
			},
		};
		for (const handler of this.handlers) handler(result);
	}
}

function viewport(x0: number, z0: number, w: number, h: number, scale = 4) {
	return { rect: { x0, z0, w, h }, scale };
}

const clock = () => { let t = 0; return () => ++t; };

async function seeded(marginTiles = 1) {
	const pool = new MockPool();
	const manager = new TileManager({ pool, marginTiles, now: clock() });
	await manager.setState(SEED, VERSION, 0);
	return { pool, manager };
}

// Scale 4 tiles cover 1024x1024 blocks: a 1024x1024 viewport is one tile,
// 3x3 keys with margin 1.
const BATCH = 16; // 4x4 keys: 1-tile-wide rect + margin 1 on every side

test('setViewport requests visible tiles plus a margin ring, center-out', async () => {
	const { pool, manager } = await seeded();
	manager.setViewport(viewport(0, 0, 1024, 1024, 4));
	const batch = pool.submitted[0]!;
	expect(batch.kind).toBe('tiles');
	expect(batch.tiles).toHaveLength(BATCH); // 4x4 with margin 1
	// The viewport center (512, 512) lives in tile (0,0): it goes FIRST.
	expect(batch.tiles[0]).toEqual({ x: 0, z: 0, scale: 4 });
	// Distances are non-decreasing: the sort metric is Manhattan from the
	// center TILE (0,0), block coordinates are (tx*1024, tz*1024).
	let prevDist = -1;
	for (const t of batch.tiles) {
		const d = Math.abs(t.x / 1024) + Math.abs(t.z / 1024);
		expect(d).toBeGreaterThanOrEqual(prevDist);
		prevDist = d;
	}
});

test('tiles land in the cache; panning inside the wanted set re-requests nothing', async () => {
	const { pool, manager } = await seeded();
	manager.setViewport(viewport(0, 0, 1024, 1024, 4));
	manager.setViewport(viewport(500, 0, 1024, 1024, 4)); // pan half a tile
	expect(pool.submitted).toHaveLength(1); // same wanted keys, all pending

	const tiled: TileEntry[] = [];
	manager.onTileReady((entry) => tiled.push(entry));
	pool.pushTile(1, pool.submitted[0]!.gen, 1, 1, 4);
	expect(tiled).toHaveLength(1);
	expect(manager.cachedCount).toBe(1); // tile (1,1) is cached now
	expect(manager.getTile(
		tileKeyToString({ seed: pool.submitted[0]!.state.seed, version: VERSION, dim: 0, scale: 4, tx: 1, tz: 1 }),
	)).not.toBeNull();
	manager.setViewport(viewport(500, 0, 1024, 1024, 4)); // (1,1) still wanted
	expect(pool.submitted).toHaveLength(1); // no re-request for the cached tile
});

test('fully-out batches are cancelled; pan keeps the generation epoch', async () => {
	const { pool, manager } = await seeded();
	manager.setViewport(viewport(0, 0, 1024, 1024, 4));
	manager.setViewport(viewport(6 * 1024, 0, 1024, 1024, 4)); // 6 tiles east: old set fully out
	expect(pool.inbound).toContain(-1); // cancelBatch(batchId 1)
	expect(pool.submitted).toHaveLength(2);
	expect(pool.submitted[1]!.gen).toBe(1); // NOT bumped by panning
});

test('viewport storm: marginal growth, no duplicate pending keys', async () => {
	const { pool, manager } = await seeded();
	for (let i = 0; i < 10; i++) {
		manager.setViewport(viewport(i * 1024, 0, 1024, 1024, 4));
	}
	// First batch covers tx -1..2; the following ones only add the new column.
	const sizes = pool.submitted.map((b) => b.tiles.length);
	expect(sizes[0]).toBe(BATCH);
	expect(sizes.at(-1)).toBe(4); // only the new edge column (4 keys)
	// In-flight accounting partitions every requested key exactly once.
	const owned = new Set<string>();
	for (const b of pool.submitted) {
		for (const t of b.tiles) {
			const k = `${t.x}:${t.z}`;
			expect(owned.has(k)).toBe(false);
			owned.add(k);
		}
	}
});

test('scale change bumps the generation epoch and forgets old-scale work', async () => {
	const { pool, manager } = await seeded();
	manager.setViewport(viewport(0, 0, 1024, 1024, 4));
	manager.setViewport(viewport(0, 0, 1024, 1024, 256)); // LOD switch
	const gens = pool.submitted.map((b) => b.gen);
	expect(gens[0]).toBe(1);
	expect(gens[1]).toBe(2);
	expect(pool.inbound).toContain(2); // seen by the pool as advanceGeneration
});

test('setState flushes the cache and cannot mix seeds across epochs', async () => {
	const { pool, manager } = await seeded();
	const evicted: string[] = [];
	const tiled: TileEntry[] = [];
	manager.onTileReady((entry) => tiled.push(entry));
	manager.onEvict((key) => evicted.push(key));
	manager.setViewport(viewport(0, 0, 1024, 1024, 4));
	for (let tx = -1; tx <= 2; tx++) {
		for (let tz = -1; tz <= 2; tz++) {
			pool.pushTile(1, 1, tx, tz, 4);
		}
	}
	expect(tiled).toHaveLength(BATCH);
	expect(manager.cachedCount).toBe(BATCH);

	await manager.setState(SEED + 1n, VERSION, 0);
	expect(evicted).toHaveLength(BATCH);
	expect(manager.cachedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
	expect(pool.lastReset!.seed).toBe(SEED + 1n);

	manager.setViewport(viewport(0, 0, 1024, 1024, 4));
	const batch = pool.submitted.at(-1)!;
	expect(`${batch.state.seed.hi}:${batch.state.seed.lo}`)
		.not.toBe(`${pool.submitted[0]!.state.seed.hi}:${pool.submitted[0]!.state.seed.lo}`);
	expect(manager.getTile(tileKeyToString({
		seed: batch.state.seed, version: VERSION, dim: 0, scale: 4, tx: 0, tz: 0,
	}))).toBeNull();
});

test('stale-epoch results are dropped instead of cached', async () => {
	const { pool, manager } = await seeded();
	manager.setViewport(viewport(0, 0, 1024, 1024, 4));
	const tiled: TileEntry[] = [];
	manager.onTileReady((entry) => tiled.push(entry));

	manager.setViewport(viewport(0, 0, 1024, 1024, 256)); // gen 1 -> 2
	pool.pushTile(1, 1, 0, 0); // late scale-4 result of the old epoch
	expect(tiled).toHaveLength(0);

	await manager.setState(SEED, VERSION, 0); // gen 2 -> 3
	pool.pushTile(1, 1, 1, 0);
	expect(tiled).toHaveLength(0);
	expect(manager.cachedCount).toBe(0);
});

test('LRU holds capacity and never evicts fresh visible entries while room exists', async () => {
	const pool = new MockPool();
	const manager = new TileManager({ pool, maxTiles: 10, marginTiles: 0, now: clock() });
	await manager.setState(SEED, VERSION, 0);
	const evicted: string[] = [];
	manager.onEvict((key) => evicted.push(key));
	for (let i = 0; i < 20; i++) {
		manager.setViewport(viewport(i * 1024, 0, 1024, 1024, 4));
		const gen = pool.submitted.at(-1)!.gen;
		pool.pushTile(i + 1, gen, i, 0, 4); // resolve only the center tile
	}
	expect(evicted.length).toBe(10); // 20 resolved, capacity 10
	expect(manager.cachedCount).toBe(10);
	// The just-resolved, currently visible tile is still cached.
	const lastKey = tileKeyToString({ seed: { hi: (Number(SEED >> 32n) | 0) as number, lo: Number(BigInt.asUintN(32, SEED & 0xffffffffn)) }, version: VERSION, dim: 0, scale: 4, tx: 19, tz: 0 });
	expect(manager.getTile(lastKey)).not.toBeNull();
	// And the evicted half are the OLDER entries, never the fresh ones.
	expect(evicted).not.toContain(lastKey);
});

test('dispose clears tracking and unsubscribes', async () => {
	const { manager } = await seeded();
	manager.dispose();
	expect(manager.pendingCount).toBe(0);
	manager.setViewport(viewport(0, 0, 1024, 1024, 4)); // no-op after dispose
});
