/*
 * Seed Map — index.ts
 * Minimal composition entry (task 3.5): builds the DOM skeleton, wires
 * pool -> tile-manager -> view -> renderer, exposes mountSeedMap() for the
 * tool page integration (the full tool page/controls/status bar is E6).
 *
 * startup contract:
 *   1) mountSeedMap(root) builds the two-layer canvas stack + legend and
 *      returns a handle synchronously (map-not-ready yet).
 *   2) handle.setState({seed, version, dim}) resets workers (barrier),
 *      flushes the tile cache and requests the current viewport.
 *   3) The first decoded tile ends the skeleton; spawn marker lands via a
 *      separate pool batch of kind 'spawn'.
 *
 * Conventions: shared styles/classes come from the design system; only the
 * absolutely necessary inline geometry lives here. NO index.html yet (E6).
 */

import {
	TileManager,
	type TileEntry,
} from './tile-manager';
import { createSeedWorker, isWorkerRuntimeAvailable } from './workers/worker-factory';
import { WorkerPool, type PoolBatch, type PoolResult } from './workers/worker-pool';
import { asSeed64 } from './wasm/seed64';
import { buildPalette, biomeCssColor, defaultPalette, type Palette } from './biome-colors';
import { MapView } from './map-view';
import { MapRenderer, type CanvasLike, type Marker } from './map-renderer';
import type { ViewEvent } from './map-view';
import type { SeedVersion } from './workers/protocol';

export type SeedMapState = {
	/** Raw 64-bit world seed as a bigint (the UI border keeps it exact). */
	seed: bigint;
	/** cubiomes MC enum value (MC_1_18..MC_NEWEST). */
	version: number;
	/** cubiomes dimension (0 overworld in this phase). */
	dim: number;
};

export type SeedMapHandle = {
	/** World-state change (flush + barrier + refetch) — resolves after reset. */
	setState(state: SeedMapState): Promise<void>;
	/** Overlay markers (structures/spawn); repainted within one frame. */
	setMarkers(markers: Marker[]): void;
	/** Toggle the legend strip visibility. */
	setLegendVisible(visible: boolean): void;
	dispose(): Promise<void>;
};

const DEFAULT_VERSION = 34; // MC_1_21_WD in this pin of cubiomes (biomes.h)
const LEGEND_IDS = [0, 1, 2, 4, 5, 7, 9, 37, 44, 179] as const;
const TILE_PX = 256;
const MAX_TILES = 160;

export function mountSeedMap(root: HTMLElement): SeedMapHandle {
	root.textContent = '';
	const stack = document.createElement('div');
	stack.style.position = 'relative';
	stack.style.overflow = 'hidden';
	stack.style.touchAction = 'none';
	stack.style.width = '100%';
	stack.style.height = '480px';
	stack.style.cursor = 'grab';

	const baseCanvas = document.createElement('canvas');
	const overlayCanvas = document.createElement('canvas');
	for (const canvas of [baseCanvas, overlayCanvas]) {
		canvas.style.position = 'absolute';
		canvas.style.inset = '0';
		canvas.style.width = '100%';
		canvas.style.height = '100%';
	}
	// Events read off the OVERLAY (topmost); hit-testing rides its pixels.
	root.appendChild(stack);
	stack.appendChild(baseCanvas);
	stack.appendChild(overlayCanvas);

	const legend = buildLegend(defaultPalette());
	legend.style.position = 'absolute';
	legend.style.left = '8px';
	legend.style.bottom = '8px';
	legend.style.fontSize = '12px';
	stack.appendChild(legend);

	// ---- engine wiring (pool -> manager -> view -> renderer) ------------
	if (!isWorkerRuntimeAvailable()) throw new Error('Web Workers unavailable');
	const pool = new WorkerPool({ createWorker: createSeedWorker });
	const manager = new TileManager({ pool, maxTiles: MAX_TILES });
	const view = new MapView(overlayCanvas as unknown as never);
	const renderer = new MapRenderer(
		baseCanvas as CanvasLike,
		overlayCanvas as CanvasLike,
	);
	const unbindView = view.attach(false);

	manager.onTileReady((entry) => renderer.onTileReady(entry));
	manager.onEvict((keyString) => renderer.onTileEvicted(keyString));
	manager.onError((message) => {
		// Status bar arrives in E6; surface through console for dev visibility.
		console.warn('[seed-map] tile error:', message);
	});

	let adjustGuard = 0;
	view.onViewChange((event) => {
		renderer.onViewChange(event);
		if (adjustGuard === 0) {
			adjustGuard++;
			try {
				// Viewport->manager only; renderer never reschedules generation.
				manager.setViewport({ rect: event.rect, scale: event.scale });
			} finally {
				adjustGuard--;
			}
		}
	});

	// Spawn result -> marker (Java spawn is exact, cubiomes getSpawn).
	const unsubPool = pool.onResult((result: PoolResult) => {
		if (result.kind !== 'spawn') return;
		renderer.setMarkers(renderer.markers.filter((m) => m.id !== 'spawn').concat(spawnMarker(result.x, result.z)));
	});

	renderer.start();
	// Initial camera emission once sizes are known (rAF after insertion).
	requestAnimationFrame(() => {
		view.syncSizes();
	});

	return {
		async setState({ seed, version = DEFAULT_VERSION, dim = 0 }: SeedMapState & { version?: number; dim?: number }) {
			const seedValue = asSeed64(seed); // validates the u64 range at the border
			renderer.clearTiles(); // skeleton until the first tile of the new state
			await manager.setState(seed, version, dim);
			// Refresh the viewport request against the NEW state.
			const rect = view.visibleRect();
			manager.setViewport({ rect, scale: view.lodScale() });
			emitSpawn(pool, seedValue, version, dim);
			// The spawn fetch is best-effort: on error the pool emits it; the
			// previous marker stays hidden until the next successful query.
		},
		setMarkers(markers) {
			renderer.setMarkers(markers);
		},
		setLegendVisible(visible) {
			legend.style.display = visible ? '' : 'none';
		},
		async dispose() {
			unbindView();
			unsubPool();
			manager.dispose();
			await pool.dispose();
			stack.remove();
			legend.remove();
		},
	};
}

// ------------------------------------------------------------------ pieces

function createPoolWorker() {
	return createSeedWorker();
}

function emitSpawn(pool: WorkerPool, seed: { hi: number; lo: number }, version: number, dim: number): void {
	const batch: PoolBatch = {
		kind: 'spawn',
		gen: (pool.generation | 0) + 1,
		seed,
		version,
		dim,
	};
	pool.submit(batch);
}

function spawnMarker(x: number, z: number): Marker {
	return { id: 'spawn', x, z, iconRadius: 7, label: 'SP' };
}

function buildLegend(palette: Palette): HTMLElement {
	const container = document.createElement('div');
	container.className = 'seed-map-legend';
	container.style.display = 'flex';
	container.style.gap = '6px';
	for (const id of LEGEND_IDS) {
		const item = document.createElement('span');
		item.title = `biome ${id}`;
		item.style.display = 'inline-block';
		item.style.width = '14px';
		item.style.height = '14px';
		item.style.borderRadius = '3px';
		item.style.background = biomeCssColor(palette, id);
		item.dataset.biome = String(id);
		container.appendChild(item);
	}
	return container;
}

/** Re-export for the E6 page: it only needs the palette for the sidebar. */
export { buildPalette };

// Type re-exports keep the ID-lists of E4/E6 away from module internals.
export type { TileEntry, ViewEvent, SeedVersion };
