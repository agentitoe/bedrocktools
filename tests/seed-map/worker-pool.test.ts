/*
 * Seed Map — worker-pool contract tests with mock workers.
 * Deterministic: no real Workers, no timers — results are pushed manually
 * through the recorded onResult handlers.
 */

import { test, expect } from 'bun:test';
import {
	MAX_IN_FLIGHT_PER_WORKER,
	WorkerPool,
	type PoolResult,
	type WorkerLike,
} from '../../src/tools/seed-map/workers/worker-pool';
import type { SeedVersion, WorkerInbound, WorkerResult } from '../../src/tools/seed-map/workers/protocol';

const STATE: SeedVersion = { seed: { hi: -674840662, lo: 3717008242 }, version: 32, dim: 0 };
const stateOf = (seed: SeedVersion['seed']) => ({ ...STATE, seed });

interface Mock {
	worker: WorkerLike;
	sent: WorkerInbound[];
	push(result: WorkerResult): void;
	isTerminated(): boolean;
}

function makeMock(): Mock {
	const sent: WorkerInbound[] = [];
	let handler: ((r: WorkerResult) => void) | null = null;
	let terminated = false;
	const worker: WorkerLike = {
		postMessage(msg) {
			sent.push(msg);
		},
		terminate() {
			terminated = true;
			return Promise.resolve();
		},
		set onResult(h) {
			handler = h;
		},
	};
	return {
		worker,
		sent,
		isTerminated: () => terminated,
		push(result) {
			handler!(result);
		},
	};
}

function tileBatch(gen: number, count: number, seed: SeedVersion['seed'] = STATE.seed) {
	return {
		kind: 'tiles' as const,
		gen,
		state: stateOf(seed),
		tiles: Array.from({ length: count }, (_, i) => ({ x: i, z: 0, scale: 4 })),
	};
}

const tileResult = (id: number, x: number): WorkerResult => ({
	id,
	gen: 1,
	kind: 'tiles',
	results: [{ x, z: 0, scale: 4, w: 256, h: 256, pixels: new Uint8ClampedArray(65536).fill(3) }],
});

test('requests spread across workers deterministically', () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 2, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	expect(pool.size).toBe(2);
	expect(MAX_IN_FLIGHT_PER_WORKER).toBe(2);

	const batchId = pool.submit(tileBatch(1, 4));
	const sent0 = mocks[0].sent.filter((m) => 'kind' in m && m.kind === 'tiles');
	const sent1 = mocks[1].sent.filter((m) => 'kind' in m && m.kind === 'tiles');
	expect(sent0).toHaveLength(2);
	expect(sent1).toHaveLength(2);
	const first = sent0[0] as Extract<WorkerInbound, { kind: 'tiles' }>;
	expect(first.id).toBe(1);
	expect(first.seed).toEqual(STATE.seed);
	expect(first.tiles[0]).toEqual({ x: 0, z: 0, scale: 4, w: 256, h: 256 });
	expect(batchId).toBe(1);
	pool.dispose();
});

test('the in-flight cap queues and releases as results settle', () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 1, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	pool.submit(tileBatch(1, 4));
	expect(mocks[0].sent).toHaveLength(2);
	expect(pool.flyingCount()).toBe(2);
	expect(pool.pendingCount).toBe(2);

	mocks[0].push(tileResult(1, 0)); // settles task 1 → next queued task is sent
	expect(mocks[0].sent).toHaveLength(3);
	mocks[0].push(tileResult(2, 1));
	expect(mocks[0].sent).toHaveLength(4);
	expect(pool.pendingCount).toBe(0);
	pool.dispose();
});

test('results are delivered once with their batch id', () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 1, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	const got: PoolResult[] = [];
	pool.onResult((r) => got.push(r));
	pool.submit(tileBatch(1, 2));
	mocks[0].push(tileResult(1, 0));

	expect(got).toEqual([{
		batchId: 1, gen: 1, kind: 'tiles',
		tile: { x: 0, z: 0, scale: 4, w: 256, h: 256, pixels: new Uint8ClampedArray(65536).fill(3) },
	}]);
	pool.dispose();
});

test('cancelBatch settles queued tasks and hands flying ids to the worker', () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 1, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	const got: PoolResult[] = [];
	pool.onResult((r) => got.push(r));
	pool.submit(tileBatch(1, 3));

	mocks[0].sent.length = 0;
	pool.cancelBatch(1); // 2 flying (ids 1, 2 kept running), 1 queued (id 3)
	expect(got).toEqual([{ batchId: 1, gen: 1, kind: 'cancelled' }]); // only id 3
	const cancels = mocks[0].sent.filter((m) => m.type === 'cancel');
	expect(cancels.map((c) => c.type === 'cancel' ? c.ids : [])).toEqual([[1], [2]]);

	// Flying tiles of the cancelled batch still deliver results.
	mocks[0].push(tileResult(1, 0));
	expect(got.filter((r) => r.kind === 'tiles')).toHaveLength(1);
	pool.dispose();
});

test('advanceGeneration drops queued work and late results', () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 1, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	const got: PoolResult[] = [];
	pool.onResult((r) => got.push(r));
	pool.submit(tileBatch(1, 3));

	mocks[0].sent.length = 0;
	pool.advanceGeneration(2); // clears sent first: drop message must appear
	const drop = mocks[0].sent.find((m) => m.type === 'drop-priority');
	expect(drop).toEqual({ type: 'drop-priority', generation: 2 });
	expect(got.filter((r) => r.kind === 'cancelled').length).toBe(1);

	// Late school result from the old generation arrives → discarded silently.
	mocks[0].sent.length = 0;
	const tilesAfter = got.filter((r) => r.kind === 'tiles').length;
	mocks[0].push(tileResult(1, 0));
	expect(got.filter((r) => r.kind === 'tiles').length).toBe(tilesAfter);
	expect(pool.generation).toBe(2);
	// New-generation batches still run.
	pool.submit(tileBatch(2, 1));
	const runs = mocks[0].sent.filter((m) => m.type !== 'cancel' && m.type !== 'drop-priority');
	expect(runs).toHaveLength(1);
	expect((runs[0] as Extract<WorkerInbound, { kind: 'tiles' }>).gen).toBe(2);
	pool.dispose();
});

test('reset barrier reseeds every worker before new work is released', async () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 2, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	const got: PoolResult[] = [];
	pool.onResult((r) => got.push(r));
	pool.submit(tileBatch(1, 4));
	expect(pool.flyingCount()).toBe(4);

	const resetPromise = pool.reset(845932142563n, 32, 0);
	// 1) queue is purged (all 4 were flying, results will now be stale);
	// 2) each worker got a drop + a reset request with the split seed.
	const resetMsgs = mocks.flatMap((m) => m.sent).filter((m) => m.type !== 'cancel' && 'kind' in m && m.kind === 'reset');
	expect(resetMsgs).toHaveLength(2);
	const resetRequest = resetMsgs[0] as Extract<WorkerInbound, { kind: 'reset' }>;
	expect(resetRequest.seed).toEqual({ hi: 196, lo: 4118552547 }); // 845932142563
	expect(resetRequest.version).toBe(32);
	expect(resetRequest.dim).toBe(0);

	// 3) submissions during the barrier are held...
	const held = pool.submit(tileBatch(7, 1));
	expect(pool.pendingCount).toBe(1);

	// 4) ...and released only after EVERY worker acknowledged.
	mocks[0].push({ id: resetRequest.id, kind: 'reset' });
	let done = false;
	resetPromise.then(() => (done = true));
	await Promise.resolve(); // microtask boundary
	expect(done).toBe(false);
	mocks[1].push({ id: resetMsgs[1].id, kind: 'reset' });
	await resetPromise;
	expect(done).toBe(true);

	expect(pool.generation).toBe(7); // 2 after the barrier, 7 once gen-7 batch enqueues
	expect(pool.pendingCount).toBe(0);
	const released = mocks[0].sent
		.filter((m) => 'kind' in m && m.kind === 'tiles')
		.filter((m) => 'gen' in m && m.gen === 7); // only the held batch tile
	expect(released).toHaveLength(1);
	expect(held).toBe(2); // batch id still valid for cancelling
	pool.dispose();
});

test('stale batches are cancelled at once and disposed pools reject submissions', async () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 1, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	const got: PoolResult[] = [];
	pool.onResult((r) => got.push(r));

	pool.submit(tileBatch(1, 1));
	// Advance the generation so the next batch is already stale.
	pool.advanceGeneration(2);
	const emittedBefore = got.length;
	pool.submit(tileBatch(1, 1)); // gen 1 < floor 2 → settles as cancelled
	expect(got.length).toBe(emittedBefore + 1);
	expect(got.at(-1)?.kind).toBe('cancelled');

	await pool.dispose();
	const moreGot: PoolResult[] = [];
	pool.onResult((r) => moreGot.push(r));
	expect(() => pool.submit(tileBatch(3, 1))).toThrow('disposed');
	// dispose must have terminated the worker.
	expect(mocks[0].isTerminated()).toBe(true);
});

test('strongholds batches dispatch one request and propagate the stamped hits', () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 1, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	const got: PoolResult[] = [];
	pool.onResult((r) => got.push(r));

	const batchId = pool.submit({ kind: 'strongholds', gen: 1, state: STATE, count: 128 });
	// One request for the whole ring walk (the in-flight cap sees ONE task).
	expect(mocks[0].sent).toHaveLength(1);
	const request = mocks[0].sent[0] as Extract<WorkerInbound, { kind: 'strongholds' }>;
	expect(request).toEqual({
		id: 1, gen: 1, kind: 'strongholds',
		seed: STATE.seed, version: 32, dim: 0, count: 128,
	});
	expect(batchId).toBe(1);

	// The worker stamps hits with the Stronghold enum; the pool propagates
	// them exactly once, correlated with the batch id.
	mocks[0].push({
		id: 1, gen: 1, kind: 'strongholds',
		hits: [{ type: 27, x: -204, z: -1692 }, { type: 27, x: 2004, z: 916 }],
	});
	expect(got).toEqual([{
		batchId: 1, gen: 1, kind: 'strongholds',
		hits: [{ type: 27, x: -204, z: -1692 }, { type: 27, x: 2004, z: 916 }],
	}]);
	expect(pool.pendingCount).toBe(0);
	pool.dispose();
});

test('a cancelled strongholds batch hands the flying ids to the worker; racing results still deliver', () => {
	const mocks: Mock[] = [];
	const pool = new WorkerPool({ size: 1, createWorker: () => { const m = makeMock(); mocks.push(m); return m.worker; } });
	const got: PoolResult[] = [];
	pool.onResult((r) => got.push(r));

	// Single-request batch: it is FLYING when cancelled (no queued task to
	// settle locally), so the pool only hands the ids to the worker.
	pool.submit({ kind: 'strongholds', gen: 1, state: STATE, count: 128 });
	mocks[0].sent.length = 0;
	pool.cancelBatch(1);
	expect(got).toEqual([]);
	expect(mocks[0].sent).toEqual([{ type: 'cancel', ids: [1] }]);

	// Flying tasks of the batch deliver normally — a result that raced the
	// cancel arrives exactly once, the duplicate after settling is dropped.
	mocks[0].push({ id: 1, gen: 1, kind: 'strongholds', hits: [{ type: 27, x: 1, z: 2 }] });
	expect(got).toEqual([{ batchId: 1, gen: 1, kind: 'strongholds', hits: [{ type: 27, x: 1, z: 2 }] }]);
	mocks[0].push({ id: 1, gen: 1, kind: 'strongholds', hits: [{ type: 27, x: 1, z: 2 }] });
	expect(got).toHaveLength(1);
	pool.dispose();
});
