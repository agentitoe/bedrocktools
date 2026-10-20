/*
 * Seed Map — workers/seed-worker-core.ts
 * Worker-side request handling, decoupled from the worker runtime so the
 * message contract can be tested with a mock bridge (tests/seed-map/).
 *
 * Runtime responsibilities live only in seed-worker.ts (the worker entry);
 * this core has NO dependency on `self`/`postMessage` and NO map logic —
 * it is purely request-response.
 */

import type { BiomeTileRequest, SpawnPoint, StructurePos, StructureScanRequest } from '../wasm/bridge';
import { asSeed64, sameSeed, type Seed64 } from '../wasm/seed64';
import type {
	SeedVersion,
	TileResult,
	WorkerCancel,
	WorkerDrop,
	WorkerInbound,
	WorkerRequest,
	WorkerResult,
} from './protocol';

export const DEFAULT_TILE = 256;

/**
 * Minimal bridge interface the core needs (structural: the real
 * wasm/bridge.BiomesBridge satisfies it, tests inject a mock).
 */
export interface WorkerBridge {
	reset(seed: bigint | Seed64, version: number, dim: number, flags?: number): void;
	genTile(req: BiomeTileRequest, out: Uint8ClampedArray | Uint8Array): void;
	findStructures(req: StructureScanRequest): StructurePos[];
	getSpawn(): SpawnPoint;
}

/**
 * Handles inbound worker messages against one (lazily created, reused)
 * bridge. Contract per message (workers/protocol):
 *   - 'cancel': puts ids in a pending set; requests whose id is in the set
 *     are skipped WITHOUT running the WASM.
 *   - 'drop-priority': raises the generation floor; requests below it are
 *     discarded optimistically — no result, the pool settles them locally.
 *   - Requests: run the WASM and produce results. Tile results are emitted
 *     per tile so the renderer can paint each tile as soon as it is ready.
 */
export class SeedWorkerCore {
	private bridge: WorkerBridge | null = null;
	private bridgePromise: Promise<WorkerBridge> | null = null;
	private generation = Number.NEGATIVE_INFINITY;
	private cancelledIds = new Set<number>();
	private appliedState: SeedVersion | null = null;

	constructor(
		private readonly bridgeLoader: () => Promise<WorkerBridge>,
		/** Raised small tile sizes in tests. */
		private readonly defaultTile: { w: number; h: number } = { w: DEFAULT_TILE, h: DEFAULT_TILE },
	) {}

	/** Bridge accessor; loads at most once per worker lifetime. */
	getBridge(): Promise<WorkerBridge> {
		if (this.bridgePromise === null) {
			this.bridgePromise = this.bridgeLoader().then((bridge) => {
				this.bridge = bridge;
				// If a reset arrived before the WASM finished loading, the fresh
				// module is seeded with that state right away.
				if (this.appliedState !== null) {
					this.applyState(bridge, this.appliedState);
				}
				return bridge;
			});
		}
		return this.bridgePromise;
	}

	/** For tests: true once the WASM module has been handed over. */
	get loaded(): boolean {
		return this.bridgePromise !== null;
	}

	async handle(msg: WorkerInbound): Promise<WorkerResult[]> {
		// Requests carry the `kind` discriminant; control messages do not, so
		// this split narrows unions cleanly (note: requests have no `type`
		// discriminant of their own — StructureScan carries a numeric `type`).
		if ('kind' in msg) {
			if (msg.kind === 'reset') return this.onReset(msg);

			// Optimistic discard: any work older than the newest generation
			// seen jumps out BEFORE touching the WASM (docs section 3).
			if (msg.gen < this.generation) return [];
			if (this.cancelledIds.has(msg.id)) {
				this.cancelledIds.delete(msg.id);
				return [];
			}

			try {
				const bridge = await this.getBridge();
				// Defensive reconfiguration: after a real barrier this is a
				// no-op, but if a mismatched request sneaks mid-flight we
				// re-apply the seed instead of mixing biome sets.
				this.ensureState(bridge, msg);
				switch (msg.kind) {
					case 'tiles':
						return this.generateTiles(bridge, msg);
					case 'structures': {
						// The worker stamps each hit with the scanned structure
						// type (the bridge returns coordinates only).
						const hits = bridge.findStructures({
							type: msg.type,
							region: msg.region,
							flags: msg.flags,
						});
						return [{
							id: msg.id,
							gen: msg.gen,
							kind: 'structures',
							hits: hits.map((h) => ({ type: msg.type, x: h.x, z: h.z })),
						}];
					}
					case 'spawn': {
						const spawn = bridge.getSpawn();
						return [{ id: msg.id, gen: msg.gen, kind: 'spawn', x: spawn.x, z: spawn.z }];
					}
				}
			} catch (err) {
				return [{ id: msg.id, kind: 'error', message: err instanceof Error ? err.message : String(err) }];
			}
		}

		// Control messages: both variants carry the `type` discriminant.
		if (msg.type === 'cancel') {
			for (const id of msg.ids) this.cancelledIds.add(id);
			return [];
		}
		if (msg.generation > this.generation) this.generation = msg.generation;
		return [];
	}

	private async onReset(
		msg: WorkerRequest & { kind: 'reset' } & SeedVersion,
	): Promise<WorkerResult[]> {
		this.cancelledIds.clear();
		// The request IS the state payload; the bridge may still be loading,
		// so the state is stored AND applied directly when already loaded.
		this.appliedState = msg;
		if (this.bridge !== null) this.applyState(this.bridge, msg);
		return [{ id: msg.id, kind: 'reset' }];
	}

	private applyState(bridge: WorkerBridge, state: SeedVersion): void {
		bridge.reset(asSeed64(state.seed), state.version, state.dim);
		this.appliedState = state;
	}

	private ensureState(bridge: WorkerBridge, msg: WorkerRequest & SeedVersion): void {
		if (this.appliedState !== null) {
			const same = sameSeed(this.appliedState.seed, msg.seed)
				&& this.appliedState.version === msg.version
				&& this.appliedState.dim === msg.dim;
			if (same) return;
		}
		this.applyState(bridge, msg);
	}

	private generateTiles(
		bridge: WorkerBridge,
		msg: WorkerRequest & { kind: 'tiles' } & SeedVersion,
	): WorkerResult[] {
		const results: WorkerResult[] = [];
		for (const spec of msg.tiles) {
			const w = spec.w ?? this.defaultTile.w;
			const h = spec.h ?? this.defaultTile.h;
			// Uint8ClampedArray: the one copy out of the WASM heap, and the
			// transferable representation of the doc's protocol.
			const pixels = new Uint8ClampedArray(w * h);
			bridge.genTile({ scale: spec.scale, x: spec.x, z: spec.z, w, h }, pixels);
			const tile: TileResult = { x: spec.x, z: spec.z, scale: spec.scale, w, h, pixels };
			results.push({ id: msg.id, gen: msg.gen, kind: 'tiles', results: [tile] });
		}
		return results;
	}
}
