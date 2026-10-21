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
import { StructureScanner } from './structures/scanner';
import { STRUCTURE_CATALOG, structuresForMc } from './structures/catalog';
import type { ViewEvent } from './map-view';
import type { WorldRect } from './types';
import type { SeedVersion } from './workers/protocol';
import { initUi } from '../../shared/ui';
import { translations } from './translations';
import { mountControls } from './ui/controls';
import { LEGEND_IDS } from './ui/legend';

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
	/** Toggle structure types (client-side filter, no rescan). */
	setStructuresEnabled(ids: string[]): void;
	/** Marker pick callback (click via renderer hitTest; tooltips arrive in E6). */
	onMarkerPick(handler: (marker: Marker | null) => void): void;
	/** Toggle the legend strip visibility. */
	setLegendVisible(visible: boolean): void;
	/** Cursor world position over the map (floored), null when off-map. */
	onCursorMove(handler: (pos: WorldPos | null) => void): () => void;
	/** Tiles currently queued/running in the pool (status bar, controls). */
	tilesPending(): number;
	dispose(): Promise<void>;
};

/** Floored world coordinates reported by onCursorMove. */
export type WorldPos = { x: number; z: number };

const DEFAULT_VERSION = 32; // MC_1_21 (= MC_1_21_11) in this pin of cubiomes (biomes.h)
const TILE_PX = 256;
const MAX_TILES = 160;

export function mountSeedMap(root: HTMLElement): SeedMapHandle {
	root.textContent = '';
	const stack = document.createElement('div');
	stack.style.position = 'relative';
	stack.style.overflow = 'hidden';
	stack.style.touchAction = 'none';
	stack.style.width = '100%';
	stack.style.height = 'var(--seed-map-height, 480px)';
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

	// Seed/version/dimension currently driving scans & catalog filtering.
	let currentState: SeedVersion | null = null;
	/** User toggle state: ids the user turned OFF (all default to on). */
	let disabledIds = new Set<string>();

	// The structure relay shares the pool: debounced scans + hit decanting.
	const scanner = new StructureScanner({ pool });
	const unsubScanner = scanner.onMarkersChanged((entries) => {
		// Structure hits -> overlay markers with per-variety catalog styling.
		// The spawn marker shares the overlay; the renderer dedups by id.
		const spawn = renderer.markers.find((m) => m.id === 'spawn');
		const structureMarkers: Marker[] = entries
			.filter((entry) => !disabledIds.has(entry.structureId))
			.map((entry): Marker => ({
				id: entry.id,
				x: entry.x,
				z: entry.z,
				iconRadius: 7,
				label: entry.label,
				color: entry.color,
			}));
		renderer.setMarkers((spawn ? [spawn] : []).concat(structureMarkers));
	});

	let adjustGuard = 0;
	view.onViewChange((event) => {
		renderer.onViewChange(event);
		if (adjustGuard === 0) {
			adjustGuard++;
			try {
				// Viewport->manager only; renderer never reschedules generation.
				manager.setViewport({ rect: event.rect, scale: event.scale });
				// The structure relay shares the view (debounced, pool-batched).
				scanner.onScrollView(event.rect);
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

	// Marker pick: overlay click routes through the renderer hit-test and the
	// catalog selectors light the picked marker (tooltips/status land in E6).
	const pickHandlers = new Set<(marker: Marker | null) => void>();
	const onOverlayClick = (event: MouseEvent) => {
		const bounds = overlayCanvas.getBoundingClientRect();
		const marker = renderer.hitTest(event.clientX - bounds.left, event.clientY - bounds.top);
		const previous = renderer.markers.find((m) => m.selected);
		if (previous !== undefined) previous.selected = false;
		if (marker !== null) marker.selected = true;
		renderer.setMarkers(renderer.markers); // re-paint with the new highlight
		for (const handler of pickHandlers) handler(marker);
	};
	overlayCanvas.addEventListener('click', onOverlayClick);

	// Cursor: pointer-move over the overlay reports the FLOORED world block
	// through screenToWorld (status bar reads it; view stays camera-keyed).
	const cursorHandlers = new Set<(pos: WorldPos | null) => void>();
	const onOverlayPointerMove = (event: PointerEvent) => {
		const bounds = overlayCanvas.getBoundingClientRect();
		const world = view.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top);
		const pos = { x: Math.floor(world.x), z: Math.floor(world.z) };
		for (const handler of cursorHandlers) handler(pos);
	};
	const onOverlayPointerLeave = () => {
		for (const handler of cursorHandlers) handler(null);
	};
	overlayCanvas.addEventListener('pointermove', onOverlayPointerMove);
	overlayCanvas.addEventListener('pointerleave', onOverlayPointerLeave);

	return {
		async setState({ seed, version = DEFAULT_VERSION, dim = 0 }: SeedMapState & { version?: number; dim?: number }) {
			const seedValue = asSeed64(seed); // validates the u64 range at the border
			renderer.clearTiles(); // skeleton until the first tile of the new state
			await manager.setState(seed, version, dim);
			// Refresh the viewport request against the NEW state.
			const rect = view.visibleRect();
			manager.setViewport({ rect, scale: view.lodScale() });
			// Structure relay: feed world state + version-filtered catalog.
			currentState = { seed: seedValue, version, dim };
			scanner.setEnabled(
				structuresForMc(version)
					.filter((entry) => !disabledIds.has(entry.id))
					.map((entry) => entry.id),
			);
			scanner.setWorldState(currentState);
			emitSpawn(pool, seedValue, version, dim);
			// The spawn fetch is best-effort: on error the pool emits it; the
			// previous marker stays hidden until the next successful query.
		},
		setMarkers(markers) {
			renderer.setMarkers(markers);
		},
		setStructuresEnabled(ids) {
			disabledIds = new Set(STRUCTURE_CATALOG.filter((e) => !ids.includes(e.id)).map((e) => e.id));
			if (currentState !== null) {
				scanner.setEnabled(
					structuresForMc(currentState.version)
						.filter((entry) => !disabledIds.has(entry.id))
						.map((entry) => entry.id),
				);
			}
		},
		onMarkerPick(handler) {
			pickHandlers.add(handler);
		},
		setLegendVisible(visible) {
			legend.style.display = visible ? '' : 'none';
		},
		onCursorMove(handler) {
			cursorHandlers.add(handler);
			return () => void cursorHandlers.delete(handler);
		},
		tilesPending() {
			return manager.pendingCount;
		},
		async dispose() {
			overlayCanvas.removeEventListener('click', onOverlayClick);
			overlayCanvas.removeEventListener('pointermove', onOverlayPointerMove);
			overlayCanvas.removeEventListener('pointerleave', onOverlayPointerLeave);
			unbindView();
			unsubPool();
			unsubScanner();
			scanner.dispose();
			manager.dispose();
			await pool.dispose();
			stack.remove();
			legend.remove();
		},
	};
}

// ------------------------------------------------------------ page bootstrap

let handle: SeedMapHandle | null = null;

/**
 * Entry point wired by public/tools/seed-map/index.html. Mounts the shared
 * UI chrome (language/theme) plus the map into #smMap, and applies the seed
 * from the ?seed= query param (already canonical decimal via controls) or a
 * sensible default so the first paint is instant.
 */
export function init(): void {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initTool);
	} else {
		initTool();
	}
}

function initTool(): void {
	initUi(translations);
	const target = document.getElementById('smMap');
	handle = target === null ? null : mountSeedMap(target);
	if (handle !== null) mountControls(handle);
}

// ------------------------------------------------------------------ pieces

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
