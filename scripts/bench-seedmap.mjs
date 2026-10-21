/*
 * Seed Map — performance benchmark (plan E8 budgets, task 7.3 companion).
 *
 * Measures the generation side of the plan's budget table against the
 * COMMITTED artifacts (public/wasm/biomes-java-gen.*), instantiated in the
 * Bun main thread via the { wasmBinary: bytes } trick (same path the parity
 * test uses). This sidesteps the glue's XHR binary fetch, which Bun lacks;
 * the runtime in the browser fetches the .wasm over the network instead.
 *
 * NOT measurable here (browser-only; a later browser perf pass covers them —
 * the plan keeps "verified in Chrome DevTools" criteria for those):
 *   - network download + JS parse of glue/wasm
 *   - canvas tile composition (drawImage / rAF frame path)
 *   - main-thread pan/zoom frame latency
 *   - real Worker pool parallelism: everything below runs sequentially on
 *     one thread, so the viewport metric is a conservative single-thread
 *     upper bound (the pool splits tile work across min(cores-1, 5) workers,
 *     and the reset barrier runs one set_seed per worker in parallel).
 *
 * Stats: warm-up runs are discarded, then min / p50 / p95 over the measured
 * runs (p50/p95 = upper-median / 95th percentile of the sorted samples).
 * Per-seed samples are pooled across the bench seeds so percentile claims
 * cover the worst seed as well.
 *
 * Run: bun scripts/bench-seedmap.mjs   (or: bun run bench:seed-map)
 * Budget test (gated): RUN_PERF=1 bun test tests/seed-map/perf-budget.test.ts
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { BiomesBridge } from '../src/tools/seed-map/wasm/bridge';
// types.ts is DOM-free (pure geometry + key helpers), so the bench reuses the
// canonical tile math instead of re-inventing sizes.
import { TILE_SIZE, tileWorldSize } from '../src/tools/seed-map/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GLUE_MJS = join(ROOT, 'public', 'wasm', 'biomes-java-gen.mjs');
const WASM_FILE = join(ROOT, 'public', 'wasm', 'biomes-java-gen.wasm');

/** Catalog MC enum for the 1.18+-era bench target: MC_26_3 = 35 (MC_NEWEST). */
export const MC_LATEST = 35;

/** Bench seeds: small, > 2^53 negative, > 2^53 positive (plan task 2.1 mix). */
export const BENCH_SEEDS = [123456789n, -2898418569583981710n, 3257840388504953787n];

/** ext_gen_biome_tile legal scales (ext_bindings.c validates this exact set). */
export const TILE_SCALES = [1, 4, 16, 256];

/** Tile-manager viewport margin (tile-manager.ts DEFAULT_MARGIN). */
export const TILE_MARGIN = 1;

/**
 * The full-repaint viewport: 1920x1080 CSS px at scale 4 (1:4) is a
 * 7680x4320 block world rect. At tileWorldSize(4) = 1024 blocks per tile that
 * is 8 (+1 x-margin) x 5 (+1 z-margin) = 70 tiles of 256x256 cells.
 */
export const BENCH_VIEWPORT_RECT = { x0: 0, z0: 0, w: 1920 * 4, h: 1080 * 4 };
export const BENCH_VIEWPORT_SCALE = 4;

/** Plan budget table (ms) — the acceptance criteria under measurement. */
export const BUDGETS_MS = {
	/** Initial tool load: WASM instantiation + first tile. */
	loadFirstTile: 150,
	/** Full 1920x1080 viewport repaint at 1:4 (generation only, no composition). */
	viewportRepaint14: 60,
	/** Seed change: reset barrier + flush + first visible tiles. */
	seedChange: 1000,
};

/** Test tolerance applied to budgets for CI/laptop variability (plan E8). */
export const BUDGET_TOLERANCE = 1.5;

// --------------------------------------------------------------- statistics

function statsOf(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const pick = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
	return { n: sorted.length, min: sorted[0], p50: pick(0.5), p95: pick(0.95) };
}

const now = () => performance.now();

/**
 * Runs `fn` with warm-up discard then records per-run wall time (ms).
 * Returns the RAW samples so callers can pool across seeds.
 */
async function collectSamples(fn, { warmup = 3, runs = 10 } = {}) {
	for (let i = 0; i < warmup; i++) await fn();
	const samples = [];
	for (let i = 0; i < runs; i++) {
		const t0 = now();
		await fn();
		samples.push(now() - t0);
	}
	return samples;
}

// ------------------------------------------------------------- viewport math

/**
 * Tiles the TileManager would request for a viewport, replicating the
 * margin/clip math of tile-manager.ts visibleTileKeys() (private there) on
 * top of the canonical helpers of types.ts (tileWorldSize). Kept as a mirror
 * on purpose: if the manager's margin math changes, this bench documents the
 * flow the budget was measured for.
 */
export function viewportTiles(rect, scale, margin = TILE_MARGIN) {
	const size = tileWorldSize(scale);
	const tx0 = Math.floor(rect.x0 / size) - margin;
	const tx1 = Math.floor((rect.x0 + rect.w - 1) / size) + margin;
	const tz0 = Math.floor(rect.z0 / size) - margin;
	const tz1 = Math.floor((rect.z0 + rect.h - 1) / size) + margin;
	const tiles = [];
	for (let tz = tz0; tz <= tz1; tz++) {
		for (let tx = tx0; tx <= tx1; tx++) {
			tiles.push({ x: tx * size, z: tz * size, scale, w: TILE_SIZE, h: TILE_SIZE });
		}
	}
	return tiles;
}

// ------------------------------------------------------------------- metrics

async function loadGlue() {
	return import(pathToFileURL(GLUE_MJS).href);
}

/**
 * Metric 1: "initial tool load" — WASM instantiation from bytes + seed reset
 * + the first 256x256 tile at 1:4. Network/JS download is excluded (header
 * note); this is what a Worker pays per instance once the bytes are local.
 */
export async function benchLoadSamples(wasmBytes) {
	const glue = await loadGlue();
	return collectSamples(
		async () => {
			const module = await glue.default({ wasmBinary: wasmBytes });
			const bridge = BiomesBridge.fromModule(module);
			bridge.reset(BENCH_SEEDS[0], MC_LATEST, 0);
			const out = new Uint8Array(TILE_SIZE * TILE_SIZE);
			bridge.genTile({ scale: 4, x: 0, z: 0, w: TILE_SIZE, h: TILE_SIZE }, out);
		},
		{ warmup: 2, runs: 5 },
	);
}

/**
 * Metric 2: per-scale genTile 256x256 (per-tile ms + throughput cells/ms).
 * The bridge must already be reset to a seeded state.
 */
export async function benchTileScaleSamples(bridge, out, scale, { runs = 10 } = {}) {
	return collectSamples(
		() => bridge.genTile({ scale, x: 0, z: 0, w: TILE_SIZE, h: TILE_SIZE }, out),
		{ warmup: 3, runs },
	);
}

/**
 * Metric 3: "full viewport repaint at 1:4" — one run generates every tile the
 * TileManager would request for the 1920x1080@1:4 viewport (generation only;
 * canvas composition is browser-side and excluded per the plan note).
 */
export async function benchViewportSamples(bridge, out, { runs = 10 } = {}) {
	const tiles = viewportTiles(BENCH_VIEWPORT_RECT, BENCH_VIEWPORT_SCALE);
	return {
		samples: await collectSamples(() => {
			for (const tile of tiles) bridge.genTile(tile, out);
		}, { warmup: 2, runs }),
		tiles: tiles.length,
	};
}

/**
 * Metric 4: typical structure scans (plan E4 wiring). "village 10x10 regions"
 * mirrors a scan window around the viewport center on the native region grid;
 * mineshaft is chunk-based and sized to the scanner's skip budget
 * (scanner.ts maxChunksPerScan default 4096 chunk cells = 64x64 chunks) to
 * show what the skip decision saves the worker ms.
 */
export function structureScanCases() {
	return [
		{ id: 'village 10x10 regions (grain 544)', type: 5, region: { x0: -5, z0: -5, w: 10, h: 10 } },
		{ id: 'ancient_city 10x10 regions (grain 384)', type: 13, region: { x0: -5, z0: -5, w: 10, h: 10 } },
		{ id: 'shipwreck 10x10 regions (grain 384)', type: 7, region: { x0: -5, z0: -5, w: 10, h: 10 } },
		{ id: 'mineshaft 64x64 chunks (skip budget cap)', type: 15, region: { x0: -32, z0: -32, w: 64, h: 64 } },
	];
}

export async function benchStructureSamples(bridge, scan, { runs = 10 } = {}) {
	const request = { ...scan, flags: 0 };
	await collectSamples(() => bridge.findStructures(request), { warmup: 3, runs: 2 });
	return {
		samples: await collectSamples(() => bridge.findStructures(request), { warmup: 0, runs }),
		hits: bridge.findStructures(request).length,
	};
}

/** Metric 5: full stronghold ring (128, vanilla order, biome-checked). */
export async function benchStrongholdSamples(bridge, { runs = 10 } = {}) {
	await collectSamples(() => bridge.findStrongholds(128), { warmup: 3, runs: 2 });
	return {
		samples: await collectSamples(() => bridge.findStrongholds(128), { warmup: 0, runs }),
	};
}

/**
 * Metric 6: seed change — the pool barrier is one ext_set_seed per worker
 * (min(cores-1, 5) here); on the main thread they run sequentially = worst
 * case. Then a simulated tile-manager flushAll() (LRU Map drain, JS-only)
 * and the first visible tile (256x256 @ 1:4) generate. One run per seed
 * change, cycling seeds: plan task 2.4 requires < 1 s per change across
 * 10 rapid changes.
 */
export async function benchSeedChangeSamples(bridge, out, { runs = 10, cacheKeys = 160 } = {}) {
	const workers = Math.max(1, Math.min(navigator.hardwareConcurrency ? navigator.hardwareConcurrency - 1 : 3, 5));
	const samples = [];
	for (let i = 0; i < runs; i++) {
		const seed = BENCH_SEEDS[i % BENCH_SEEDS.length];
		const t0 = now();
		for (let w = 0; w < workers; w++) bridge.reset(seed, MC_LATEST, 0);
		// Simulated TileManager.flushAll(): the LRU is an insertion-ordered
		// Map; dropping entries is O(n) JS with no WASM round-trip.
		const fake = new Map();
		for (let k = 0; k < cacheKeys; k++) fake.set('k' + k, { k });
		while (fake.size > 0) fake.delete(fake.keys().next().value);
		bridge.genTile({ scale: 4, x: 0, z: 0, w: TILE_SIZE, h: TILE_SIZE }, out);
		samples.push(now() - t0);
	}
	return samples;
}

/**
 * Metric 7: background-scan stability — 100 village re-scans of the typical
 * region (the scanner re-issues scans per debounce window; this models
 * sustained background scanning without a result cache).
 */
export async function benchVillageRescanSamples(bridge, { runs = 100 } = {}) {
	const scan = { type: 5, region: { x0: -5, z0: -5, w: 10, h: 10 }, flags: 0 };
	return collectSamples(() => bridge.findStructures(scan), { warmup: 3, runs });
}

// -------------------------------------------------------------------- report

/** Budget verdict rows: { metric, budgetMs, p50, p95, margin, pass }. */
export function evaluateBudgets(report) {
	const rows = [];
	const row = (metric, budget, stat) => {
		rows.push({
			metric,
			budgetMs: budget,
			p50: +stat.p50.toFixed(3),
			p95: +stat.p95.toFixed(3),
			/** Headroom factor: how many times the budget the median uses. */
			margin: +(budget / stat.p50).toFixed(2),
			// PASS = p50 inside the raw budget AND p95 inside the same 1.5x
			// tolerance the gated per-budget test asserts.
			pass: stat.p50 < budget && stat.p95 < budget * BUDGET_TOLERANCE,
		});
	};
	const tiles = report.viewport.tiles;
	row('load: instantiate + first tile 256x256 @1:4', BUDGETS_MS.loadFirstTile, report.load);
	row('viewport 1920x1080 @1:4 (' + tiles + ' tiles, gen only)', BUDGETS_MS.viewportRepaint14, report.viewport);
	row('seed change: 5x set_seed + flush + first tile', BUDGETS_MS.seedChange, report.seedChange);
	return rows;
}

/**
 * Full bench run. Options override the bench shape (used by the gated test):
 *   { seeds, mc, metricRuns }
 * Returns the report; budget metrics are load/viewport/seedChange, the rest
 * (tiles/scans/strongholds/rescan) are diagnostics for tuning decisions.
 */
export async function runSeedMapBench(opts = {}) {
	const seeds = opts.seeds ?? BENCH_SEEDS;
	const mc = opts.mc ?? MC_LATEST;
	const runs = opts.metricRuns ?? 10;
	const wasmBytes = new Uint8Array(readFileSync(WASM_FILE));

	// Timing overhead: budget metrics keep { runs } default; the skip-budget
	// mineshaft probe and the scale 1 tile are the two hot spots — they run
	// fewer iterations so a full CLI pass stays comfortably under ~3 min.
	const runsFor = (id) => (id === 'mineshaft' || id === 'scale1' ? Math.min(runs, 3) : runs);
	const progress = (msg) => console.error('[bench] ' + msg);
	progress('load metric...');

	const report = {
		meta: {
			date: new Date().toISOString(),
			bun: Bun.version,
			mc,
			seeds: seeds.map(String),
			committedModule: 'public/wasm/biomes-java-gen.wasm',
		},
	};

	report.load = statsOf(await benchLoadSamples(wasmBytes));

	// One persistent module for the steady-state metrics (mirrors one worker
	// runtime handling many requests without re-instantiation).
	const glue = await loadGlue();
	const module = await glue.default({ wasmBinary: wasmBytes });
	const bridge = BiomesBridge.fromModule(module);
	const out = new Uint8Array(TILE_SIZE * TILE_SIZE);

	const pooled = {
		tiles: {}, // scale -> samples pooled across seeds
		viewportSamples: [],
		scans: {}, // scan id -> { samples, hits }
		strongholdSamples: [],
	};
	for (const scale of TILE_SCALES) pooled.tiles[scale] = [];
	for (const scan of structureScanCases()) pooled.scans[scan.id] = { samples: [], hits: 0 };

	let viewportTilesCount = 0;
	for (const seed of seeds) {
		bridge.reset(seed, mc, 0);
		for (const scale of TILE_SCALES) {
			progress('seed ' + seed + ' scale ' + scale + '...');
			const samples = await benchTileScaleSamples(bridge, out, scale, { runs: runsFor(scale === 1 ? 'scale1' : scale) });
			pooled.tiles[scale].push(...samples);
		}
		progress('seed ' + seed + ' viewport...');
		const viewport = await benchViewportSamples(bridge, out, { runs: runsFor('viewport') });
		pooled.viewportSamples.push(...viewport.samples);
		viewportTilesCount = viewport.tiles;
		for (const scan of structureScanCases()) {
			const id = scan.id.startsWith('mineshaft') ? 'mineshaft' : scan.id;
			progress('seed ' + seed + ' scan ' + scan.id + '...');
			const res = await benchStructureSamples(bridge, scan, { runs: runsFor(id) });
			pooled.scans[scan.id].samples.push(...res.samples);
			pooled.scans[scan.id].hits = res.hits;
		}
		progress('seed ' + seed + ' strongholds...');
		pooled.strongholdSamples.push(...(await benchStrongholdSamples(bridge, { runs: runsFor('strongholds') })).samples);
	}

	report.tiles = {};
	for (const scale of TILE_SCALES) {
		const stats = statsOf(pooled.tiles[scale]);
		stats.cellsPerMs = +((TILE_SIZE * TILE_SIZE) / stats.p50).toFixed(1);
		report.tiles[scale] = stats;
	}
	report.viewport = { ...statsOf(pooled.viewportSamples), tiles: viewportTilesCount };
	report.scans = {};
	for (const [id, entry] of Object.entries(pooled.scans)) {
		report.scans[id] = { ...statsOf(entry.samples), hits: entry.hits };
	}
	report.strongholds = statsOf(pooled.strongholdSamples);
	report.strongholds.ring = 128; // vanilla 1.18+ ring length (full scan)

	progress('seed change metric (10 rapid changes)...');
	report.seedChange = statsOf(await benchSeedChangeSamples(bridge, out));
	progress('village rescan stability (100 runs)...');
	report.villageRescan = statsOf(await benchVillageRescanSamples(bridge));

	report.budgets = evaluateBudgets(report);
	return report;
}

// ------------------------------------------------------------- output (CLI)

function pad(text, width) {
	return String(text).padEnd(width);
}

function fmtMs(v) {
	return v >= 100 ? v.toFixed(1) + 'ms' : v.toFixed(2) + 'ms';
}

/** Renders the report as the plan-facing text table (kept ASCII, no emoji). */
export function formatReport(report) {
	const lines = [];
	const { meta } = report;
	lines.push('Seed Map bench — ' + meta.date + ' (bun ' + meta.bun + ', mc ' + meta.mc
		+ ', seeds: ' + meta.seeds.join(', ') + ')');
	lines.push('Module: ' + meta.committedModule + ' ({ wasmBinary } in Bun main; browser-only');
	lines.push('costs NOT included: network/JS fetch, canvas composition, rAF frame path,');
	lines.push('real worker-pool parallelism — single-thread worst case here).');
	lines.push('');
	lines.push('Budget metrics:');
	lines.push('  ' + pad('metric', 52) + pad('p50', 11) + pad('p95', 11) + pad('budget', 10) + 'verdict');
	for (const b of report.budgets) {
		lines.push('  ' + pad(b.metric, 52)
			+ pad(fmtMs(b.p50), 11) + pad(fmtMs(b.p95), 11) + pad('< ' + b.budgetMs + 'ms', 10)
			+ (b.pass ? 'PASS x' + b.margin : 'FAIL x' + b.margin));
	}
	lines.push('');
	lines.push('Diagnostics (per-tile generation):');
	lines.push('  ' + pad('genTile 256x256 scale', 30) + pad('p50', 11) + pad('p95', 11) + pad('cells/ms', 12));
	for (const scale of TILE_SCALES) {
		const t = report.tiles[scale];
		lines.push('  ' + pad('1:' + scale, 30) + pad(fmtMs(t.p50), 11) + pad(fmtMs(t.p95), 11) + pad(String(t.cellsPerMs), 12));
	}
	lines.push('  viewport total: ' + report.viewport.tiles + ' tiles x 256x256 cells');
	lines.push('');
	lines.push('Structures (generation side):');
	lines.push('  ' + pad('scan', 44) + pad('p50', 11) + pad('p95', 11) + pad('hits', 6));
	for (const [id, s] of Object.entries(report.scans)) {
		lines.push('  ' + pad(id, 44) + pad(fmtMs(s.p50), 11) + pad(fmtMs(s.p95), 11) + pad(String(s.hits), 6));
	}
	lines.push('  ' + pad('stronghold ring (128, biome-checked)', 44)
		+ pad(fmtMs(report.strongholds.p50), 11) + pad(fmtMs(report.strongholds.p95), 11));
	lines.push('  ' + pad('village rescan stability (100 runs)', 44)
		+ pad(fmtMs(report.villageRescan.p50), 11) + pad(fmtMs(report.villageRescan.p95), 11));
	return lines.join('\n');
}

// ------------------------------------------------------------------ CLI main

if (import.meta.main) {
	const performed = await runSeedMapBench();
	console.log(formatReport(performed));
}
