/*
 * Seed Map — structures/scanner.ts contract tests with a MOCK pool and
 * INJECTED fake timers (no real scheduling, no WASM — the scanner never
 * touches WASM itself). Covers: debounce, region math (+-1 margin and the
 * symmetric budgeted shrink), chunk-kind skip over the chunk budget, hit
 * dedupe (type:x:z) with a FIFO cap, client-side toggle re-emit WITHOUT
 * rescanning, world-state invalidation with cancel-on-rescan, generation
 * counters and dispose.
 */

import { test, expect } from 'bun:test';
import {
	StructureScanner,
	type StructureMarker,
	type TimerLike,
} from '../../src/tools/seed-map/structures/scanner';
import type { PoolBatch, PoolResult, WorkerPool } from '../../src/tools/seed-map/workers/worker-pool';
import type { SeedVersion, StructureScan } from '../../src/tools/seed-map/workers/protocol';

const STATE: SeedVersion = { seed: { hi: -674840662, lo: 3717008242 }, version: 32, dim: 0 };
const VIEW = { x0: 0, z0: 0, w: 544, h: 544 };
const OTHER: SeedVersion = { seed: { hi: 0, lo: 1 }, version: 32, dim: 0 };

// ----------------------------------------------------------------------- //
// Mocks

type Submitted = { batch: PoolBatch; id: number };

/** Structural WorkerPool stand-in: the scanner only uses submit/cancelBatch/onResult/generation. */
class MockPool {
	#generation = 0;
	recorded: Submitted[] = [];
	cancels: number[] = [];
	private handlers = new Set<(r: PoolResult) => void>();
	private seq = 0;

	get generation(): number {
		return this.#generation;
	}

	set generation(value: number) {
		this.#generation = value;
	}

	submit(batch: PoolBatch): number {
		const id = ++this.seq;
		this.recorded.push({ batch, id });
		return id;
	}

	cancelBatch(batchId: number): void {
		this.cancels.push(batchId);
	}

	onResult(handler: (r: PoolResult) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	push(result: Partial<PoolResult> & { batchId: number; gen: number }): void {
		for (const h of [...this.handlers]) h(result as PoolResult);
	}

	batches(kind: PoolBatch['kind']): PoolBatch[] {
		return this.recorded.filter((s) => s.batch.kind === kind).map((s) => s.batch);
	}

	structureScans(): (StructureScan & { batchGen: number })[] {
		const out: (StructureScan & { batchGen: number })[] = [];
		for (const s of this.recorded) {
			if (s.batch.kind !== 'structures') continue;
			for (const scan of s.batch.scans) out.push({ ...scan, batchGen: s.batch.gen });
		}
		return out;
	}

	scanOf(type: number): (StructureScan & { batchGen: number }) {
		const found = this.structureScans().find((s) => s.type === type);
		if (!found) throw new Error('no scan submitted for type ' + type);
		return found;
	}

	strongholdBatch(): PoolBatch & { kind: 'strongholds' } {
		const batch = this.batches('strongholds')[0] as PoolBatch & { kind: 'strongholds' };
		if (!batch) throw new Error('no strongholds batch submitted');
		return batch;
	}

	clear(): void {
		this.recorded = [];
		this.cancels = [];
	}
}

/** Debounce windows the test fires manually; clearTimeout matches by identity. */
class FakeTimers implements TimerLike {
	pending: { handler: () => void; ms: number }[] = [];

	setTimeout(handler: () => void, ms: number): unknown {
		const task = { handler, ms };
		this.pending.push(task);
		return task;
	}

	clearTimeout(handle: unknown): void {
		this.pending = this.pending.filter((t) => t !== handle);
	}

	/** Pops the single pending window and runs it (the scanner keeps <= 1). */
	fire(): void {
		const [task] = this.pending.splice(0, 1);
		if (task) task.handler();
	}
}

function makeScanner(
	pool: MockPool,
	timers: FakeTimers,
	opts: Partial<ConstructorParameters<typeof StructureScanner>[0]> = {},
): { scanner: StructureScanner; markers: StructureMarker[][] } {
	const releases: StructureMarker[][] = [];
	const scanner = new StructureScanner({
		pool: pool as unknown as WorkerPool,
		debounceMs: 250,
		timers,
		...opts,
	});
	scanner.onMarkersChanged((m) => releases.push(m));
	return { scanner, markers: releases };
}

const structureResult = (
	batchId: number,
	gen: number,
	type: number,
	hits: { x: number; z: number }[],
): PoolResult => ({
	batchId,
	gen,
	kind: 'structures',
	scan: { type, region: { x0: -2, z0: -2, w: 4, h: 4 }, flags: 0 },
	hits: hits.map((h) => ({ type: type, x: h.x, z: h.z })),
});

// ----------------------------------------------------------------------- //

test('view + state changes schedule ONE debounced scan, never an immediate one', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner } = makeScanner(pool, timers);

	scanner.setWorldState(STATE); // no lastView yet -> nothing scheduled
	scanner.onScrollView(VIEW); // arms the debounce window
	expect(timers.pending).toHaveLength(1);
	expect(timers.pending[0].ms).toBe(250);
	expect(pool.recorded).toHaveLength(0); // nothing fires before the window closes

	scanner.onScrollView({ ...VIEW, x0: 16 }); // a second pan RESTARTS the window
	expect(timers.pending).toHaveLength(1);
	expect(pool.recorded).toHaveLength(0);

	timers.fire();
	expect(pool.recorded.length).toBeGreaterThan(0);
	expect(timers.pending).toHaveLength(0);
});

test('old state asserts the region scans shapes with the stronghold batch', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner } = makeScanner(pool, timers);
	scanner.setWorldState(STATE);
	scanner.onScrollView(VIEW);
	timers.fire();

	// MC 32 == whole catalog: 14 region kinds + 3 chunk kinds in ONE
	// structures batch, and the stronghold dedicated batch (count 128).
	expect(pool.batches('structures')).toHaveLength(1);
	const batch = pool.batches('structures')[0] as Extract<PoolBatch, { kind: 'structures' }>;
	expect(batch.scans).toHaveLength(17);
	const types = batch.scans.map((s) => s.type).sort((a, b) => a - b);
	expect(types).toContain(5); // village
	expect(types).toContain(14); // buried_treasure (chunk kind)
	expect(types).not.toContain(27); // stronghold never rides the region scan
	expect(batch.gen).toBe(1);
	const stronghold = pool.strongholdBatch();
	expect(stronghold.count).toBe(128);
	expect(stronghold.state).toEqual(STATE);
	expect(stronghold.gen).toBe(1);
});

test('region math: native-grain viewports get the +-1 region margin', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner } = makeScanner(pool, timers);
	scanner.setEnabled(['village']); // isolate one region kind (grain 34*16 = 544)
	scanner.setWorldState(STATE);

	// Viewport fully inside village cell (1, 2): 544..555 x 1088..1099.
	scanner.onScrollView({ x0: 544, z0: 1088, w: 12, h: 12 });
	timers.fire();
	expect(pool.scanOf(5).region).toEqual({ x0: 0, z0: 1, w: 3, h: 3 });

	// A viewport straddling two cells on both axes: cells 0..1 x 1..2 + margin.
	pool.clear();
	scanner.onScrollView({ x0: 500, z0: 1000, w: 100, h: 100 });
	timers.fire();
	expect(pool.scanOf(5).region).toEqual({ x0: -1, z0: 0, w: 4, h: 4 });
});

test('region math: budget overage shrinks SYMMETRICALLY around the viewport center', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	// cap 32 -> half = floor(sqrt(32)/2) - 1 = 1 -> a centered 3x3 window.
	const { scanner } = makeScanner(pool, timers, { maxRegionsPerScan: 32 });
	scanner.setEnabled(['village']);
	scanner.setWorldState(STATE);
	// Huge viewport: unbounded region count far above the cap.
	// region cells: x in [-1, 18383], z in [-1, 184].
	scanner.onScrollView({ x0: 0, z0: 0, w: 10_000_000, h: 100_000 });
	timers.fire();

	const region = pool.scanOf(5).region;
	// cx = floor((-1 + 18383)/2) = 9191, cz = floor((-1 + 184)/2) = 91.
	expect(region).toEqual({ x0: 9190, z0: 90, w: 3, h: 3 });
	// Symmetric and within budget.
	expect(region.w).toBe(region.h);
	expect(region.w * region.h).toBeLessThanOrEqual(32);
});

test('chunk kinds are SKIPPED whole over the chunk budget, 1:1 cells under it', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	// viewport 200x200 blocks = 13x13 = 169 chunks > 10 -> the chunk types
	// skip; region kinds still scan.
	const { scanner } = makeScanner(pool, timers, { maxChunksPerScan: 10 });
	scanner.setWorldState(STATE);
	scanner.onScrollView({ x0: 0, z0: 0, w: 200, h: 200 });
	timers.fire();

	expect(pool.structureScans().find((s) => s.type === 14)).toBeUndefined(); // buried_treasure
	expect(pool.structureScans().find((s) => s.type === 15)).toBeUndefined(); // mineshaft
	expect(pool.structureScans().find((s) => s.type === 17)).toBeUndefined(); // amethyst_geode
	expect(pool.structureScans().find((s) => s.type === 5)).toBeDefined(); // village fine

	// Under the budget the chunk cells come through with NO margin (256x256
	// blocks = 16x16 chunks; a fresh cap large enough for them).
	pool.clear();
	const loose = new MockPool();
	const looseTimers = new FakeTimers();
	const { scanner: looseScanner } = makeScanner(loose, looseTimers, { maxChunksPerScan: 300 });
	looseScanner.setEnabled(['buried_treasure']);
	looseScanner.setWorldState(STATE);
	looseScanner.onScrollView({ x0: 0, z0: 0, w: 256, h: 256 });
	looseTimers.fire();
	expect(loose.scanOf(14).region).toEqual({ x0: 0, z0: 0, w: 16, h: 16 });
});

test('hits dedupe by type:x:z with a FIFO cap (oldest evicted first)', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner, markers } = makeScanner(pool, timers, { maxMarkers: 2 });
	scanner.setEnabled(['village', 'shipwreck', 'ocean_monument']);
	scanner.setWorldState(STATE);
	scanner.onScrollView(VIEW);
	timers.fire();

	// First scan: two distinct hits -> two keys in insertion order.
	pool.push(structureResult(1, 1, 5, [{ x: 100, z: 200 }]));
	pool.push(structureResult(1, 1, 7, [{ x: 0, z: 0 }]));
	expect(markers.at(-1)!.map((m) => m.id)).toEqual(['5:100:200', '7:0:0']);

	// A duplicate key (same type/coords, new batch) never duplicates AND
	// keeps the previous FIFO order (no re-insertion of existing keys).
	pool.push(structureResult(2, 2, 5, [{ x: 100, z: 200 }]));
	expect(markers.at(-1)!.map((m) => m.id)).toEqual(['5:100:200', '7:0:0']);

	// Cap of 2: the NEW key evicts the OLDEST ('5:100:200').
	pool.push(structureResult(2, 2, 8, [{ x: 5, z: 5 }]));
	expect(markers.at(-1)!.map((m) => m.id)).toEqual(['7:0:0', '8:5:5']);

	// Marker payloads carry the catalog label/color of the type.
	const wreck = markers.at(-1)!.find((m) => m.type === 7)!;
	expect(wreck.label).toBe('SX');
	expect(wreck.color).toBe('#7c6a55');
	expect(wreck.structureId).toBe('shipwreck');
});

test('setEnabled RE-EMITS filtered markers without submitting a new scan', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner, markers } = makeScanner(pool, timers);
	scanner.setEnabled(['village', 'shipwreck']);
	scanner.setWorldState(STATE);
	scanner.onScrollView(VIEW);
	timers.fire();
	pool.push(structureResult(1, 1, 5, [{ x: 100, z: 200 }]));
	pool.push(structureResult(1, 1, 7, [{ x: 0, z: 0 }]));
	const submitsAfterScan = pool.recorded.length;

	scanner.setEnabled(['village']); // toggle off shipwreck, client-side only
	expect(markers.at(-1)!.map((m) => m.id)).toEqual(['5:100:200']);
	expect(pool.recorded).toHaveLength(submitsAfterScan); // NO rescan submitted
	expect(timers.pending).toHaveLength(0); // and NO debounce either

	scanner.setEnabled([]); // everything off -> empty emission, still no scan
	expect(markers.at(-1)).toEqual([]);
	expect(pool.recorded).toHaveLength(submitsAfterScan);
});

test('setWorldState: same state is a no-op; a new seed clears, cancels and rescans', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner, markers } = makeScanner(pool, timers);
	scanner.setEnabled(['village']);
	scanner.setWorldState(STATE);
	scanner.onScrollView(VIEW);
	timers.fire(); // batch ids: structures = 1 (no strongholds: toggled off)
	expect(pool.recorded).toHaveLength(1);
	pool.push(structureResult(1, 1, 5, [{ x: 100, z: 200 }])); // batch 1 settles
	expect(markers.at(-1)).toHaveLength(1);

	// IDENTICAL state: no wipe, no reschedule, no cancel.
	scanner.setWorldState({ ...STATE });
	expect(markers.at(-1)).toHaveLength(1);
	expect(pool.cancels).toHaveLength(0);
	expect(timers.pending).toHaveLength(0);

	// Pan once more so a batch is PENDING while the world changes.
	scanner.onScrollView({ ...VIEW, x0: 16 });
	timers.fire();
	expect(pool.recorded).toHaveLength(2);

	// NEW seed: buckets cleared (an empty emission), the pending batch
	// cancelled, and the KNOWN viewport re-scans against the new state.
	scanner.setWorldState(OTHER);
	expect(markers.at(-1)).toEqual([]);
	expect(pool.cancels).toEqual([2]);
	expect(timers.pending).toHaveLength(1);

	timers.fire();
	expect(pool.recorded).toHaveLength(3);
	const rescan = pool.recorded[2].batch as Extract<PoolBatch, { kind: 'structures' }>;
	expect(rescan.state.seed).toEqual(OTHER.seed); // the scans ride the NEW state
	expect(rescan.gen).toBe(3);
	expect((pool.recorded[1].batch as { gen: number }).gen).toBe(2); // counter kept moving
});

test('re-scan cancels the previous batch ids and advances the gen counter', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner } = makeScanner(pool, timers);
	scanner.setEnabled(['village', 'shipwreck']);
	scanner.setWorldState(STATE);
	scanner.onScrollView(VIEW);
	timers.fire();
	const firstIds = pool.recorded.map((s) => s.id);
	const firstGen = (pool.recorded[0].batch as { gen: number }).gen;
	expect(firstGen).toBe(1);

	timers.fire(); // nothing armed -> the scanner is NOT disturbed
	expect(pool.recorded).toHaveLength(firstIds.length);
	expect(pool.cancels).toHaveLength(0);

	scanner.onScrollView({ ...VIEW, x0: 16 }); // pan -> debounce -> scan again
	timers.fire();
	expect(pool.cancels).toEqual(firstIds); // ALL pending batches cancelled
	const secondIds = pool.recorded.map((s) => s.id);
	expect(secondIds).not.toEqual(firstIds);
	expect((pool.recorded.at(-1)!.batch as { gen: number }).gen).toBe(2);
});

test('the pool generation floor lifts the scanner gen above it', () => {
	const pool = new MockPool();
	pool.generation = 50;
	const timers = new FakeTimers();
	const { scanner } = makeScanner(pool, timers);
	scanner.setEnabled(['village', 'stronghold']);
	scanner.setWorldState(STATE);
	scanner.onScrollView(VIEW);
	timers.fire();
	// gen = max(++gens, pool floor + 1); both batches share it.
	expect(pool.recorded[0].batch.gen).toBe(51);
	expect(pool.recorded[1].batch.gen).toBe(51);
});

test('pool results decant ONLY structure kinds; errors, tiles and cancels are ignored', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner, markers } = makeScanner(pool, timers);
	scanner.setEnabled(['village', 'stronghold']);
	scanner.setWorldState(STATE);
	scanner.onScrollView(VIEW);
	timers.fire();

	pool.push({ batchId: 1, gen: 1, kind: 'error', message: 'boom' } as PoolResult);
	pool.push({ batchId: 1, gen: 1, kind: 'cancelled' } as PoolResult);
	expect(markers.at(-1)).toEqual([]); // nothing decanted (emissions so far are the wipe ones), no crash
	expect(markers.every((m) => m.length === 0)).toBe(true);

	// Stronghold hits flow through with their worker-stamped type.
	pool.push({
		batchId: 2, gen: 1, kind: 'strongholds',
		hits: [{ type: 27, x: -204, z: -1692 }],
	} as PoolResult);
	const last = markers.at(-1)!;
	expect(last).toHaveLength(1);
	expect(last[0].type).toBe(27);
	expect(last[0].structureId).toBe('stronghold');
	expect(last[0].id).toBe('27:-204:-1692');
	expect(last[0].label).toBe('ST');
});

test('dispose cancels pending, clears timers and unsubscribes the decant', () => {
	const pool = new MockPool();
	const timers = new FakeTimers();
	const { scanner, markers } = makeScanner(pool, timers);
	scanner.setEnabled(['village']); // wipe emission
	scanner.setWorldState(STATE); // wipe emission
	scanner.onScrollView(VIEW);
	timers.fire();
	const ids = pool.recorded.map((s) => s.id);
	expect(ids).toHaveLength(1);
	const emissionsAtDispose = markers.length;

	scanner.dispose();
	expect(pool.cancels).toEqual(ids); // pending batches cancelled
	expect(timers.pending).toHaveLength(0);
	scanner.onScrollView(VIEW); // ignored after dispose
	expect(timers.pending).toHaveLength(0);
	pool.push({ batchId: 5, gen: 5, kind: 'cancelled' } as PoolResult);
	pool.push(structureResult(9, 9, 5, [{ x: 1, z: 2 }]));
	// Late results never reach the disposed scanner: no new emission, and
	// nothing anywhere carries the pushed marker.
	expect(markers).toHaveLength(emissionsAtDispose);
	expect(markers.flat().find((m) => m.x === 1 && m.z === 2)).toBeUndefined();
});
