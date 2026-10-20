/*
 * Seed Map — workers/worker-pool.ts
 * Owns N seed workers, hands out work in deterministic order, tracks viewport
 * generations and provides the hard reset barrier (task 2.4).
 *
 * Responsibilities (docs section 3):
 *   - Pool size: min(hardwareConcurrency - 1, 5), at least 1.
 *   - Batches arrive already ordered (center-out priority is the tile
 *     manager's job, E3); each task goes to the least loaded worker
 *     (tie: lowest index) — scheduling is fully deterministic so tests can
 *     assert on the message flow.
 *   - At most `maxInFlight` (2) tiles in flight per worker; queued tasks wait
 *     until a result for that worker settles.
 *   - One request per task (a one-element tiles array): the in-flight cap
 *     only works if ids are per tile. The protocol keeps the `tiles[]` shape
 *     for the E8 batch optimization.
 *   - cancelBatch(batchId): settles queued tasks locally AND hands the ids to
 *     the worker so they are skipped if their requests arrive late (message
 *     delivery is ordered, but handling is async: a cancel can overtake its
 *     ids). In-flight tiles of the batch keep running; their results are
 *     delivered normally — generation discards decide whether they matter.
 *   - advanceGeneration(g): bumps the floor; queued stale tasks settle
 *     locally, flying ones are discarded on arrival, and each worker's queued
 *     future work is skipped by its optimistic generation check.
 *   - reset() barrier (task 2.4): settles everything old (queued AND flying —
 *     their results would be discarded anyway), raises the result floor,
 *     reseeds EVERY worker (ext_set_seed) and resolves only when all of them
 *     acknowledged. Submissions arriving during the barrier are held and
 *     released right after (older-than-floor ones are cancelled at release).
 *     A fast seed change therefore cannot emit tiles of the old world state.
 *
 * This module knows nothing about what tiles look like — E3 consumes
 * TileResult payloads.
 */

import { splitSeed, type Seed64 } from '../wasm/seed64';
import type {
	SeedVersion,
	StructureHit,
	StructureScan,
	TileResult,
	WorkerCancel,
	WorkerDrop,
	WorkerInbound,
	WorkerRequest,
	WorkerResult,
} from './protocol';
import { DEFAULT_TILE } from './seed-worker-core';

/** Worker abstraction shared by the browser factory and the test mocks. */
export interface WorkerLike {
	postMessage(msg: WorkerInbound, transfer?: Transferable[]): void;
	terminate(): Promise<void>;
	set onResult(handler: (result: WorkerResult) => void);
}

/** What the map layer submits (already priority-ordered, docs section 3). */
export type PoolBatch =
	| { kind: 'tiles'; gen: number; state: SeedVersion; tiles: { x: number; z: number; scale: number }[] }
	| { kind: 'structures'; gen: number; state: SeedVersion; scans: StructureScan[] }
	| { kind: 'strongholds'; gen: number; state: SeedVersion; count: number }
	| ({ kind: 'spawn'; gen: number } & SeedVersion);

/** What the map layer receives per finished/discarded task. */
export type PoolResult =
	| { batchId: number; gen: number; kind: 'tiles'; tile: TileResult }
	| { batchId: number; gen: number; kind: 'structures'; scan: StructureScan; hits: StructureHit[] }
	| { batchId: number; gen: number; kind: 'strongholds'; hits: StructureHit[] }
	| { batchId: number; gen: number; kind: 'spawn'; x: number; z: number }
	| { batchId: number; gen: number; kind: 'cancelled' }
	| { batchId: number; gen: number; kind: 'error'; message: string };

export type Unsubscribe = () => void;

export const MAX_IN_FLIGHT_PER_WORKER = 2;

export type PoolOptions = {
	/** Fixed pool size (tests pass a small deterministic value). */
	size?: number;
	/** Worker factory — required; use workers/worker-factory.ts in the browser. */
	createWorker: () => WorkerLike;
	/** In-flight cap per worker (keep the default of 2). */
	maxInFlight?: number;
};

/** min(cores - 1, 5), never below 1; falls back to 2 workers when unknown. */
export function defaultPoolSize(): number {
	const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
	const size = cores > 0 ? Math.min(cores - 1, 5) : 2;
	return Math.max(1, size);
}

type TaskState = 'queued' | 'flying' | 'settled';

interface Task {
	id: number;
	batchId: number;
	gen: number;
	worker: number;
	state: TaskState;
	request: WorkerRequest;
}

interface BatchWork {
	batch: PoolBatch;
	batchId: number;
}

export class WorkerPool {
	private workers: WorkerLike[] = [];
	private ids = 0;
	private batchSeq = 0;
	private tasks = new Map<number, Task>();
	private queuedPerWorker: number[][] = [];
	private inFlightPerWorker: number[] = [];
	private currentGen = Number.NEGATIVE_INFINITY;
	private barrier: { promise: Promise<void>; resolve: () => void; acks: Set<number> } | null = null;
	private heldByBarrier: BatchWork[] = [];
	private resultHandlers = new Set<(result: PoolResult) => void>();
	private disposed = false;
	private readonly maxInFlight: number;
	private readonly createWorker: () => WorkerLike;

	constructor(opts: PoolOptions) {
		this.maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT_PER_WORKER;
		this.createWorker = opts.createWorker;
		const size = opts.size ?? defaultPoolSize();
		for (let i = 0; i < size; i++) {
			this.queuedPerWorker.push([]);
			this.inFlightPerWorker.push(0);
			this.spawnWorker(i);
		}
	}

	private spawnWorker(index: number): void {
		const worker = this.createWorker();
		this.workers.push(worker);
		worker.onResult = (result) => this.onWorkerResult(index, result);
	}

	/**
	 * Queues a priority-ordered batch. Returns the batchId to cancel with.
	 * Submissions older than the newest generation the pool has seen are
	 * accepted but settle immediately as cancelled (their results would be
	 * discarded anyway).
	 */
	submit(batch: PoolBatch): number {
		if (this.disposed) throw new Error('pool is disposed');
		const batchId = ++this.batchSeq;
		if (this.barrier !== null) {
			// Strictly hold submissions until the barrier resolves; the batch is
			// re-checked against the generation rule at release time.
			this.heldByBarrier.push({ batch, batchId });
			return batchId;
		}
		this.enqueueBatch(batch, batchId);
		this.pump();
		return batchId;
	}

	/** Settles everything still queued of a batch; hands flying ids to the worker. */
	cancelBatch(batchId: number): void {
		if (this.disposed) return;
		for (const task of [...this.tasks.values()]) {
			if (task.batchId !== batchId) continue;
			if (task.state === 'queued') {
				this.retire(task, { batchId, gen: task.gen, kind: 'cancelled' });
			} else if (task.state === 'flying') {
				const cancel: WorkerCancel = { type: 'cancel', ids: [task.id] };
				this.send(task.worker, cancel);
			}
		}
		// Held submissions of the batch cannot run anymore either.
		this.heldByBarrier = this.heldByBarrier.filter((b) => b.batchId !== batchId);
	}

	/** Viewport generation stamp; also broadcasts the optimistic drop. */
	advanceGeneration(gen: number): void {
		if (this.disposed) return;
		if (gen <= this.currentGen) return; // generations only move forward
		this.currentGen = gen;
		const drop: WorkerDrop = { type: 'drop-priority', generation: gen };
		for (let w = 0; w < this.workers.length; w++) this.send(w, drop);
		for (const task of [...this.tasks.values()]) {
			if (task.state === 'queued' && task.gen < gen) {
				this.retire(task, { batchId: task.batchId, gen: task.gen, kind: 'cancelled' });
			}
		}
		this.pump();
	}

	/** Newest generation handed to the pool (the map layer keys on it). */
	get generation(): number {
		return this.currentGen;
	}

	/** Queued task ids across workers plus submissions held by the barrier. */
	get pendingCount(): number {
		let n = 0;
		for (const ids of this.queuedPerWorker) n += ids.length;
		return n + this.heldByBarrier.length;
	}

	get size(): number {
		return this.workers.length;
	}

	/** Tests/instrumentation: running task count (bounded by the in-flight cap). */
	flyingCount(): number {
		let n = 0;
		for (const t of this.tasks.values()) if (t.state === 'flying') n++;
		return n;
	}

	/**
	 * Hard reconfiguration (task 2.4). Resolves when every worker has reseeded
	 * for (seed, version, dim); submissions held until then cannot emit tiles
	 * of the old world state.
	 */
	async reset(seed: bigint, version: number, dim: number): Promise<void> {
		if (this.disposed) throw new Error('pool is disposed');
		if (this.barrier !== null) {
			// Only one barrier at a time; wait out the running one and retry —
			// the retry re-checks everything (queue state may have changed).
			await this.barrier.promise;
			return this.reset(seed, version, dim);
		}
		const state: SeedVersion = { seed: splitSeed(seed), version, dim };

		// Nothing in any queue belongs to the new world: queued tasks settle
		// as cancelled, and FLYING ones settle too (their results would be
		// discarded by the generation floor the moment they arrive; settling
		// them here frees the in-flight slots for post-barrier work).
		for (const task of [...this.tasks.values()]) {
			this.retire(task, { batchId: task.batchId, gen: task.gen, kind: 'cancelled' });
		}
		// Raise the local floor so any result that still races in drops.
		if (Number.isFinite(this.currentGen)) this.currentGen += 1;
		const drop: WorkerDrop = { type: 'drop-priority', generation: this.currentGen };
		for (let w = 0; w < this.workers.length; w++) this.send(w, drop);

		// 2) Reseed every worker; resolve when ALL acks are in.
		let barrierResolve = () => {};
		const barrierPromise = new Promise<void>((resolve) => (barrierResolve = resolve));
		this.barrier = { promise: barrierPromise, resolve: barrierResolve, acks: new Set<number>() };
		for (let w = 0; w < this.workers.length; w++) {
			const id = ++this.ids;
			const request: WorkerRequest = { id, kind: 'reset', seed: state.seed, version, dim };
			this.send(w, request);
		}
		await barrierPromise;

		// 3) Release held submissions; each re-checks the generation rule.
		const held = this.heldByBarrier;
		this.heldByBarrier = [];
		for (const entry of held) this.enqueueBatch(entry.batch, entry.batchId);
		this.pump();
	}

	onResult(handler: (result: PoolResult) => void): Unsubscribe {
		this.resultHandlers.add(handler);
		return () => this.resultHandlers.delete(handler);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.heldByBarrier = [];
		// Everything still tracked is moot once the workers terminate.
		for (const task of [...this.tasks.values()]) this.retire(task, null);
		const workers = this.workers;
		this.workers = [];
		await Promise.all(workers.map((w) => w.terminate()));
	}

	// ------------------------------------------------------------------ //

	private enqueueBatch(batch: PoolBatch, batchId: number): void {
		// Generation rule (docs section 3): anything older than the floor
		// would be discarded instantly, so it settles here and now.
		if (batch.gen < this.currentGen) {
			this.emit({ batchId, gen: batch.gen, kind: 'cancelled' });
			return;
		}
		if (batch.gen > this.currentGen) this.currentGen = batch.gen;

		let seed: Seed64;
		let version: number;
		let dim: number;
		if (batch.kind === 'spawn') {
			seed = batch.seed;
			version = batch.version;
			dim = batch.dim;
		} else {
			seed = batch.state.seed;
			version = batch.state.version;
			dim = batch.state.dim;
		}

		if (batch.kind === 'tiles') {
			for (const spec of batch.tiles) {
				// Uniform 256x256 tiles; one element per request keeps the
				// in-flight cap honest (an id per tile).
				const request: WorkerRequest = {
					id: 0,
					gen: batch.gen,
					kind: 'tiles',
					seed,
					version,
					dim,
					tiles: [{ x: spec.x, z: spec.z, scale: spec.scale, w: DEFAULT_TILE, h: DEFAULT_TILE }],
				};
				this.enqueue(request, batchId, batch.gen);
			}
		} else if (batch.kind === 'structures') {
			for (const scan of batch.scans) {
				const request: WorkerRequest = {
					id: 0,
					gen: batch.gen,
					kind: 'structures',
					seed,
					version,
					dim,
					type: scan.type,
					region: scan.region,
					flags: scan.flags,
				};
				this.enqueue(request, batchId, batch.gen);
			}
		} else {
			const request: WorkerRequest = { id: 0, gen: batch.gen, kind: 'spawn', seed, version, dim };
			this.enqueue(request, batchId, batch.gen);
		}
	}

	private enqueue(request: WorkerRequest, batchId: number, gen: number): void {
		// Least loaded worker; ties break by index (deterministic in tests).
		let best = 0;
		for (let w = 1; w < this.workers.length; w++) {
			const load = this.queuedPerWorker[w].length + this.inFlightPerWorker[w];
			const bestLoad = this.queuedPerWorker[best].length + this.inFlightPerWorker[best];
			if (load < bestLoad) best = w;
		}
		const id = ++this.ids;
		request.id = id;
		this.tasks.set(id, { id, batchId, gen, worker: -1, state: 'queued', request });
		this.queuedPerWorker[best].push(id);
	}

	private pump(): void {
		for (let w = 0; w < this.workers.length; w++) {
			while (this.inFlightPerWorker[w] < this.maxInFlight && this.queuedPerWorker[w].length > 0) {
				const id = this.queuedPerWorker[w].shift()!;
				const task = this.tasks.get(id);
				if (!task || task.state !== 'queued') continue;
				task.state = 'flying';
				task.worker = w;
				this.inFlightPerWorker[w]++;
				this.send(w, task.request);
			}
		}
	}

	private send(workerIdx: number, msg: WorkerInbound): void {
		this.workers[workerIdx]?.postMessage(msg);
	}

	private onWorkerResult(workerIdx: number, result: WorkerResult): void {
		if (this.disposed) return;
		if (result.kind === 'reset') {
			this.onBarrierAck(result.id);
			return;
		}
		if (result.kind === 'cancelled') return; // informational; cancels settle locally

		const task = this.tasks.get(result.id);
		if (!task || task.state !== 'flying') return; // ack for an already-settled task

		// A result that raced with a generation bump has no listener anymore.
		if (task.gen < this.currentGen) {
			this.retire(task, null);
			return;
		}
		switch (result.kind) {
			case 'tiles':
				for (const tile of result.results) {
					this.emit({ batchId: task.batchId, gen: task.gen, kind: 'tiles', tile });
				}
				break;
			case 'structures': {
				// One request == one scan; the exact scan is recoverable from
				// the request that carried the id. Hits arrive type-stamped
				// from the worker (or via the scan for defense in depth).
				const hitScan: StructureScan = task.request.kind === 'structures'
					? { type: task.request.type, region: task.request.region, flags: task.request.flags }
					: { type: 0, region: { x0: 0, z0: 0, w: 0, h: 0 }, flags: 0 };
				this.emit({
					batchId: task.batchId,
					gen: task.gen,
					kind: 'structures',
					scan: hitScan,
					hits: result.hits.map((h) => ({
						type: h.type !== undefined ? h.type : hitScan.type,
						x: h.x,
						z: h.z,
					})),
				});
				break;
			}
			case 'strongholds':
				this.emit({ batchId: task.batchId, gen: task.gen, kind: 'strongholds', hits: result.hits });
				break;
			case 'spawn':
				this.emit({ batchId: task.batchId, gen: task.gen, kind: 'spawn', x: result.x, z: result.z });
				break;
			case 'error':
				this.emit({ batchId: task.batchId, gen: task.gen, kind: 'error', message: result.message });
				break;
		}
		this.retire(task, null);
	}

	/**
	 * Settles a task and, when a result exists, delivers it exactly once.
	 * In-flight bookkeeping is centralized here: a task that was flying
	 * frees its slot in either path (result arrival, cancel, dispose).
	 */
	private retire(task: Task, result: PoolResult | null): void {
		if (task.state === 'settled') return;
		const wasFlying = task.state === 'flying';
		const wasWorker = task.worker;
		task.state = 'settled';
		this.tasks.delete(task.id);
		if (wasFlying && wasWorker >= 0 && this.inFlightPerWorker[wasWorker] > 0) {
			this.inFlightPerWorker[wasWorker]--;
		}
		if (result !== null) this.emit(result);
		if (!this.disposed) this.pump();
	}

	private emit(result: PoolResult): void {
		for (const handler of this.resultHandlers) handler(result);
	}

	private onBarrierAck(id: number): void {
		const barrier = this.barrier;
		if (barrier === null) return;
		barrier.acks.add(id);
		if (barrier.acks.size >= this.workers.length) {
			this.barrier = null;
			barrier.resolve();
		}
	}
}
