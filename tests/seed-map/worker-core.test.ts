/*
 * Seed Map — seed-worker-core contract tests (mock bridge, no WASM).
 * Covers: tile generation payload, reset-before-load, optimistic generation
 * discard, cancel-overlapping-ids, structures/spawn passthrough and errors.
 */

import { test, expect } from 'bun:test';
import {
	SeedWorkerCore,
	type WorkerBridge,
} from '../../src/tools/seed-map/workers/seed-worker-core';
import type { BiomeTileRequest, SpawnPoint, StructurePos } from '../../src/tools/seed-map/wasm/bridge';
import type {
	SeedVersion,
	StructureScanRequest,
	WorkerInbound,
	WorkerResult,
} from '../../src/tools/seed-map/workers/protocol';

const STATE: SeedVersion = {
	seed: { hi: -674840662, lo: 3717008242 }, // -2898418569583981710
	version: 32,
	dim: 0,
};

class MockBridge implements WorkerBridge {
	reseeds: { seed: { hi: number; lo: number }; version: number; dim: number }[] = [];
	tileCalls: BiomeTileRequest[] = [];
	scans: StructureScanRequest[] = [];
	strongholdCalls: number[] = [];
	strongholdHits: StructurePos[] = [];
	spawnCalls = 0;
	failTiles = false;

	reset(seed: bigint | { hi: number; lo: number }, version: number, dim: number): void {
		this.reseeds.push({
			seed: typeof seed === 'bigint' ? { hi: Number(seed >> 32n), lo: Number(seed & 0xffffffffn) } : seed,
			version,
			dim,
		});
	}

	genTile(req: BiomeTileRequest, out: Uint8ClampedArray | Uint8Array): void {
		if (this.failTiles) throw new Error('gen failed');
		this.tileCalls.push(req);
		out.fill(7);
	}

	findStructures(req: StructureScanRequest): StructurePos[] {
		this.scans.push(req);
		return [{ x: 544, z: 352 }];
	}

	findStrongholds(count: number): StructurePos[] {
		this.strongholdCalls.push(count);
		return this.strongholdHits;
	}

	getSpawn(): SpawnPoint {
		this.spawnCalls++;
		return { x: 0, z: 0 };
	}
}

async function drained(core: SeedWorkerCore, msg: WorkerInbound): Promise<WorkerResult[]> {
	const results = await core.handle(msg);
	await new Promise((r) => setTimeout(r, 0)); // settle microtasks of the loader
	return results;
}

test('tile request reaches the bridge and results carry the pixels', async () => {
	const bridge = new MockBridge();
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	const results = await drained(core, {
		id: 1, gen: 1, kind: 'tiles', ...STATE,
		tiles: [{ x: -1, z: -2, scale: 4 }],
	});
	expect(bridge.tileCalls).toEqual([{ scale: 4, x: -1, z: -2, w: 4, h: 2 }]);
	expect(results).toHaveLength(1);
	expect(results[0].kind).toBe('tiles');
	if (results[0].kind === 'tiles') {
		expect(results[0].gen).toBe(1);
		expect(results[0].results[0]).toEqual({ x: -1, z: -2, scale: 4, w: 4, h: 2, pixels: new Uint8ClampedArray(8).fill(7) });
	}
});

test('reset before the bridge loads is applied as soon as it does', async () => {
	const bridge = new MockBridge();
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	const ack = await core.handle({ id: 2, kind: 'reset', ...STATE });
	expect(ack).toEqual([{ id: 2, kind: 'reset' }]);
	await core.getBridge();
	expect(bridge.reseeds).toEqual([{ seed: STATE.seed, version: 32, dim: 0 }]);
});

test('stale generation is discarded WITHOUT running the WASM', async () => {
	const bridge = new MockBridge();
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	await core.handle({ type: 'drop-priority', generation: 5 } as WorkerInbound);
	const results = await drained(core, { id: 3, gen: 4, kind: 'tiles', ...STATE, tiles: [{ x: 0, z: 0, scale: 1 }] });
	expect(results).toEqual([]);
	expect(bridge.tileCalls).toHaveLength(0);
});

test('newer generation still runs after the drop', async () => {
	const bridge = new MockBridge();
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	await core.handle({ type: 'drop-priority', generation: 5 } as WorkerInbound);
	const results = await drained(core, { id: 4, gen: 5, kind: 'spawn', ...STATE });
	expect(results).toEqual([{ id: 4, gen: 5, kind: 'spawn', x: 0, z: 0 }]);
});

test('cancelled ids are skipped even when the request arrives later', async () => {
	const bridge = new MockBridge();
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	await core.handle({ type: 'cancel', ids: [9] } as WorkerInbound);
	const results = await drained(core, { id: 9, gen: 3, kind: 'tiles', ...STATE, tiles: [{ x: 0, z: 0, scale: 1 }] });
	expect(results).toEqual([]);
	expect(bridge.tileCalls).toHaveLength(0);
});

test('structures and spawn scan the bridge with their exact payloads', async () => {
	const bridge = new MockBridge();
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	const hits = await drained(core, {
		id: 10, gen: 2, kind: 'structures', ...STATE,
		type: 5, region: { x0: -2, z0: -2, w: 4, h: 4 }, flags: 0,
	});
	expect(hits).toEqual([{ id: 10, gen: 2, kind: 'structures', hits: [{ type: 5, x: 544, z: 352 }]}]);
	expect(bridge.scans[0].type).toBe(5);
	expect(bridge.scans[0].region).toEqual({ x0: -2, z0: -2, w: 4, h: 4 });
});

test('bridge failures surface as error results for the request id', async () => {
	const bridge = new MockBridge();
	bridge.failTiles = true;
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	const results = await drained(core, { id: 11, gen: 1, kind: 'tiles', ...STATE, tiles: [{ x: 0, z: 0, scale: 1 }] });
	expect(results).toEqual([{ id: 11, kind: 'error', message: 'gen failed' }]);
});

test('strongholds request ring-walks the bridge and re-stamps hits as 27', async () => {
	const bridge = new MockBridge();
	bridge.strongholdHits = [{ x: -204, z: -1692 }, { x: 2004, z: 916 }];
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	const results = await drained(core, { id: 20, gen: 3, kind: 'strongholds', ...STATE, count: 128 });

	// The bridge receives the EXACT requested cap and returns raw coords.
	expect(bridge.strongholdCalls).toEqual([128]);
	// The worker stamps EVERY hit with the pinned Stronghold enum (27):
	// the bridge deliberately returns coordinates only.
	expect(results).toEqual([{
		id: 20,
		gen: 3,
		kind: 'strongholds',
		hits: [
			{ type: 27, x: -204, z: -1692 },
			{ type: 27, x: 2004, z: 916 },
		],
	}]);
});

test('strongholds re-applies a mismatched world state before the ring walk', async () => {
	const bridge = new MockBridge();
	bridge.strongholdHits = [{ x: 1156, z: 5124 }];
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	const other: SeedVersion = { seed: { hi: 1901, lo: 560071542 }, version: 25, dim: 0 };
	await core.handle({ id: 21, kind: 'reset', ...STATE });
	await drained(core, { id: 22, gen: 1, kind: 'strongholds', ...other, count: 16 });
	expect(bridge.strongholdCalls).toEqual([16]);
	expect(bridge.reseeds).toHaveLength(2);
	expect(bridge.reseeds[1]).toEqual({ seed: other.seed, version: 25, dim: 0 });
});

test('seed mismatch mid-flight re-applies the state (no biome mixing)', async () => {
	const bridge = new MockBridge();
	const core = new SeedWorkerCore(async () => bridge, { w: 4, h: 2 });
	await core.handle({ id: 12, kind: 'reset', ...STATE });
	await core.getBridge();
	const other: SeedVersion = { seed: { hi: 0, lo: 1 }, version: 32, dim: 0 };
	await drained(core, { id: 13, gen: 1, kind: 'spawn', ...other });
	// ensureState re-applied the OTHER seed for its request: 2 reconfigurations.
	expect(bridge.reseeds).toHaveLength(2);
	expect(bridge.reseeds[1]).toEqual({ seed: other.seed, version: 32, dim: 0 });
});
