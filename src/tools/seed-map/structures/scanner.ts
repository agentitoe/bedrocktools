/*
 * Seed Map — structures/scanner.ts
 * Viewport -> structure scans relay (plan task 4.2/4.3 wiring).
 *
 * Responsibilities:
 *   - Debounced re-scan: camera/view events only restart a timer (250 ms
 *     default); a quiet viewport is scanned ONCE, not per pan frame.
 *   - Region math per catalog entry: 'regions' kinds cut the viewport into
 *     native-size structure regions (granularity = regionSize * 16 blocks,
 *     plus a +-1 region margin), 'chunks' kinds scan chunk cells and are
 *     SKIPPED entirely when the chunk count passes the budget (mineshaft/
 *     treasure/geode at coarse LODs — 0.4%...1% chunk probabilities make
 *     far-zoom chunk sweeps pure waste per worker ms).
 *   - Stronghold rides its dedicated 'strongholds' batch kind (ring walk,
 *     never a region scan; getStructurePos has no Stronghold case).
 *   - Result decant: worker-stamped hits (type included) go into a union
 *     deduped by `type:x|z` with a FIFO cap; toggling a type re-filters
 *     WITHOUT rescanning (client-side only).
 *   - Seed/version changes wipe the buckets: tiles-of-the-old-world rules
 *     apply to structure markers too.
 *
 * This module never touches WASM — only the pool contract.
 */

import {
	STRUCTURE_CATALOG,
	structureByEnumId,
	structuresForMc,
	scanConfigFor,
	type StructureEntry,
	type StructureId,
} from './catalog';
import type { WorldRect } from '../types';
import { WORLD_LIMIT } from '../types';
import type { RegionRect, SeedVersion, StructureHit } from '../workers/protocol';
import type { PoolBatch, PoolResult, Unsubscribe, WorkerPool } from '../workers/worker-pool';

/** Marker payload the host maps onto the renderer (color/label from catalog). */
export type StructureMarker = {
	/** Stable key `type:x|z` (renderer dedup + hit-test id). */
	id: string;
	/** cubiomes StructureType enum of the hit (worker-stamped). */
	type: number;
	structureId: StructureId;
	x: number;
	z: number;
	label: string;
	color: string;
};

export type TimerLike = {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type StructureScannerOptions = {
	pool: WorkerPool;
	/** Idle window before a scan fires on view changes. */
	debounceMs?: number;
	/** Per-type cap on regions of ONE scan (centers on the viewport). */
	maxRegionsPerScan?: number;
	/** Chunks per scan; larger viewports skip the chunk-scan type. */
	maxChunksPerScan?: number;
	/** FIFO cap of deduped hits kept across scans. */
	maxMarkers?: number;
	timers?: TimerLike;
};

export class StructureScanner {
	private readonly pool: WorkerPool;
	private readonly debounceMs: number;
	private readonly maxRegionsPerScan: number;
	private readonly maxChunksPerScan: number;
	private readonly maxMarkers: number;
	private readonly timers: TimerLike;

	private enabledIds = new Set<StructureId>(STRUCTURE_CATALOG.map((e) => e.id));
	private state: SeedVersion | null = null;
	/** Last viewport (world rect) + generation seen. */
	private lastView: { rect: WorldRect } | null = null;
	/** Scanner-local generation counter (kept above the pool floor; tiles use
	 * their own counter, the pool's single floor rule handles the rest). */
	private gens = 0;
	private timer: unknown = null;
	private markerHandlers = new Set<(markers: StructureMarker[]) => void>();
	private hits = new Map<string, StructureHit>();
	/** Batch ids in flight, for cancel-on-new-scan and reset. */
	private pendingBatches = new Set<number>();
	private gotResult: Unsubscribe | null = null;
	private disposed = false;

	constructor(opts: StructureScannerOptions) {
		this.pool = opts.pool;
		this.debounceMs = opts.debounceMs ?? 250;
		this.maxRegionsPerScan = opts.maxRegionsPerScan ?? 2048;
		this.maxChunksPerScan = opts.maxChunksPerScan ?? 4096;
		this.maxMarkers = opts.maxMarkers ?? 6144;
		this.timers = opts.timers ?? globalThis;
		this.gotResult = this.pool.onResult((result) => this.decant(result));
	}

	/**
	 * World-state change (task 2.4 barrier upstream): structure data of the
	 * old world is moot — buckets cleared, batches cancelled, timer reset.
	 * A pending viewport is re-scanned against the new state.
	 */
	setWorldState(state: SeedVersion): void {
		if (this.disposed) return;
		const seedChanged = this.state === null || this.state.version !== state.version
			|| this.state.dim !== state.dim
			|| this.state.seed.hi !== state.seed.hi || this.state.seed.lo !== state.seed.lo;
		this.state = state;
		if (!seedChanged) return;
		this.clearBuckets();
		// The current viewport re-scans for the new state (debounced).
		if (this.lastView !== null) this.scheduleScan();
	}

	/** Camera change: restart the debounce window (cheap, no WASM here). */
	onScrollView(rect: WorldRect): void {
		if (this.disposed) return;
		this.lastView = { rect };
		this.scheduleScan();
	}

	/** Toggle structure types client-side; re-filters and repaints markers. */
	setEnabled(ids: Iterable<StructureId>): void {
		this.enabledIds = new Set(ids);
		this.emitMarkers();
	}

	get enabled(): StructureId[] {
		return [...this.enabledIds];
	}

	/** Fires the pending scan immediately (state changes, tests). */
	scanNow(): void {
		if (this.timer !== null) {
			this.timers.clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.lastView === null || this.state === null) return;
		const view = this.lastView;
		const floor = Number.isFinite(this.pool.generation) ? this.pool.generation : 0;
		const gen = Math.max(++this.gens, floor + 1);
		this.cancelPending();
		const catalog = structuresForMc(this.state.version);

		const scans = [];
		let strongholds = false;
		for (const entry of catalog) {
			if (!this.enabledIds.has(entry.id) || this.state.version < entry.minMc) continue;
			const config = scanConfigFor(entry, this.state.version);
			if (config === null) continue;
			if (config.kind === 'special') {
				strongholds = true; // one ring walk per scan; regions do not apply
				continue;
			}
			if (config.kind === 'regions') {
				const region = this.regionRectFor(view.rect, config.granularity);
				if (region !== null) scans.push({ type: entry.enumId, region, flags: entry.flags });
			} else {
				const region = this.chunkRectFor(view.rect, entry);
				if (region !== null) scans.push({ type: entry.enumId, region, flags: entry.flags });
			}
		}

		if (scans.length > 0) {
			const batch: PoolBatch = { kind: 'structures', gen, state: this.state, scans };
			this.pendingBatches.add(this.pool.submit(batch));
		}
		if (strongholds) {
			const batch: PoolBatch = { kind: 'strongholds', gen, state: this.state, count: 128 };
			this.pendingBatches.add(this.pool.submit(batch));
		}
	}

	onMarkersChanged(handler: (markers: StructureMarker[]) => void): Unsubscribe {
		this.markerHandlers.add(handler);
		return () => this.markerHandlers.delete(handler);
	}

	dispose(): void {
		this.disposed = true;
		if (this.gotResult !== null) {
			this.gotResult();
			this.gotResult = null;
		}
		this.cancelPending();
		if (this.timer !== null) {
			this.timers.clearTimeout(this.timer);
			this.timer = null;
		}
		this.markerHandlers.clear();
		this.hits.clear();
	}

	// ------------------------------------------------------------------ //

	private scheduleScan(): void {
		if (this.timer !== null) this.timers.clearTimeout(this.timer);
		this.timer = this.timers.setTimeout(() => {
			this.timer = null;
			this.scanNow();
		}, this.debounceMs);
	}

	private cancelPending(): void {
		for (const batchId of this.pendingBatches) this.pool.cancelBatch(batchId);
		this.pendingBatches.clear();
	}

	private clearBuckets(): void {
		this.hits.clear();
		this.cancelPending();
		this.emitMarkers();
	}

	/**
	 * Viewport -> region rect of native-size cells (grain in world blocks)
	 * with a +-1 cell margin, budgeted symmetric shrink around the center
	 * region when the count exceeds the per-scan cap. Null = nothing to scan.
	 */
	private regionRectFor(rect: WorldRect, grain: number): RegionRect | null {
		if (grain <= 0) return null;
		const limit = Math.floor(WORLD_LIMIT / grain);
		let rx0 = Math.floor(rect.x0 / grain) - 1;
		let rx1 = Math.floor((rect.x0 + rect.w - 1) / grain) + 1;
		let rz0 = Math.floor(rect.z0 / grain) - 1;
		let rz1 = Math.floor((rect.z0 + rect.h - 1) / grain) + 1;
		const count = () => (rx1 - rx0 + 1) * (rz1 - rz0 + 1);
		if (count() > this.maxRegionsPerScan) {
			// Budgeted shrink keeps the CENTER of the viewport covered even at
			// far LODs (icons of the margins return on later, closer pans).
			const half = Math.floor(Math.sqrt(this.maxRegionsPerScan) / 2) - 1;
			const cx = Math.floor((rx0 + rx1) / 2);
			const cz = Math.floor((rz0 + rz1) / 2);
			rx0 = cx - half;
			rx1 = cx + half;
			rz0 = cz - half;
			rz1 = cz + half;
		}
		// Hard world bounds (anti-overflow, types.ts convention).
		rx0 = Math.max(rx0, -limit);
		rx1 = Math.min(rx1, limit);
		rz0 = Math.max(rz0, -limit);
		rz1 = Math.min(rz1, limit);
		if (rx1 <= rx0 || rz1 <= rz0) return null;
		return { x0: rx0, z0: rz0, w: rx1 - rx0 + 1, h: rz1 - rz0 + 1 };
	}

	/**
	 * Chunk-cell scan (mineshaft/treasure/geode): cells of 16 blocks, capped
	 * by the chunk budget; a viewport beyond the cap is skipped whole.
	 */
	private chunkRectFor(rect: WorldRect, entry: StructureEntry): RegionRect | null {
		const grain = 16;
		const limit = Math.floor(WORLD_LIMIT / grain);
		let rx0 = Math.floor(rect.x0 / grain);
		let rx1 = Math.floor((rect.x0 + rect.w - 1) / grain);
		let rz0 = Math.floor(rect.z0 / grain);
		let rz1 = Math.floor((rect.z0 + rect.h - 1) / grain);
		const count = (rx1 - rx0 + 1) * (rz1 - rz0 + 1);
		if (count > this.maxChunksPerScan) {
			// Not budgetable-without-randomness: random-type decimation would
			// silently report a biased hit set. Skip the type (TODO E8: run
			// chunk sweeps guardedly inside the worker instead of the UI).
			return null;
		}
		// No margin: chunk types are 1:1 with cells (pos inside the chunk).
		rx0 = Math.max(rx0, -limit);
		rx1 = Math.min(rx1, limit);
		rz0 = Math.max(rz0, -limit);
		rz1 = Math.min(rz1, limit);
		if (rx1 < rx0 || rz1 < rz0) return null;
		return { x0: rx0, z0: rz0, w: rx1 - rx0 + 1, h: rz1 - rz0 + 1 };
	}

	/** Decants pool results into the hit buckets and re-emits markers. */
	private decant(result: PoolResult): void {
		if (result.kind === 'cancelled') {
			this.pendingBatches.delete(result.batchId);
			return;
		}
		const hits = result.kind === 'structures' || result.kind === 'strongholds'
			? result.hits
			: null;
		if (hits === null) return; // tiles/spawn/errors are other layers' data
		this.pendingBatches.delete(result.batchId);
		const dirty = hits.length > 0;
		for (const hit of hits) {
			const key = hitKey(hit);
			const prior = this.hits.get(key);
			if (prior !== undefined) continue; // union dedupe
			if (this.hits.size >= this.maxMarkers) {
				// FIFO cap: the OLDEST scan batch data goes first.
				const oldest = this.hits.keys().next();
				if (oldest.done) continue;
				const evicted = oldest.value;
				this.hits.delete(evicted);
			}
			this.hits.set(key, hit);
		}
		if (dirty) this.emitMarkers();
	}

	private emitMarkers(): void {
		const markers: StructureMarker[] = [];
		for (const [key, hit] of this.hits) {
			const entry = structureEntryOf(hit.type);
			if (entry === null) continue;
			if (!this.enabledIds.has(entry.id)) continue; // toggle: client-side
			markers.push({
				id: key,
				type: hit.type,
				structureId: entry.id,
				x: hit.x,
				z: hit.z,
				label: entry.marker.label,
				color: entry.marker.color,
			});
		}
		for (const handler of this.markerHandlers) handler(markers);
	}
}

function hitKey(hit: { type: number; x: number; z: number }): string {
	return hit.type + ':' + hit.x + ':' + hit.z;
}

function structureEntryOf(type: number): StructureEntry | null {
	// Stronghold stamps come straight from the worker; defense-in-depth for
	// catalog/submodule drift is the wasm test's job, not the scanner's.
	return structureByEnumId(type);
}
