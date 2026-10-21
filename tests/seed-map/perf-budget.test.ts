/*
 * Seed Map — performance budgets vs the committed WASM module (opt-in).
 *
 * Gate with `RUN_PERF=1 bun test tests/seed-map/perf-budget.test.ts`.
 * Skipped silently otherwise so the normal suite stays fast and hermetic.
 *
 * WHAT IS ASSERTABLE HERE (Bun main thread, { wasmBinary } instantiation,
 * single worker equivalent):
 *   - "Cambio de seed < 1 s" (plan budget table): ext_set_seed + first
 *     256x256 tile at 1:4, p50.
 *   - Generation throughput floors per tile (documented, with 1.5x headroom
 *     over the bench output of scripts/bench-seedmap.mjs so CI laptops do
 *     not flake): genTile 256x256 at 1:1 and 1:4.
 *
 * WHAT IS NOT (browser-only, covered by the bench header note):
 *   - "Carga inicial < 150 ms" (page shell + asset fetch + first paint).
 *   - "Repaint 1:4 < 60 ms" and "pan/zoom <= 50 ms": those budgets are
 *     composition-path numbers (warm tile cache -> drawImage + rAF). A fresh
 *     viewport fill is PROGRESSIVE by design — exact cubiomes generation
 *     costs ~355 ms per 256x256 tile at 1:4 single-thread (~184k cells/s;
 *     the worker pool streams independent misses, the canvas repaints what
 *     is cached in <= a frame). Measuring the composition path needs a real
 *     browser harness.
 */
import { describe, test, expect } from 'bun:test';
import { runSeedMapBench } from '../../scripts/bench-seedmap.mjs';

const RUN_PERF = process.env.RUN_PERF === '1';
const SEED = -2898418569583981710n;

/**
 * One seed keeps the gated run around ~4 min; metricRuns 3 is the smallest
 * sample set that still reports a stable p50 for the hot metrics.
 */
const report = RUN_PERF
	? await runSeedMapBench({ seeds: [SEED], metricRuns: 3 })
	: null;

describe('performance budgets (RUN_PERF=1)', () => {
	test.skipIf(!RUN_PERF)('plan budget: seed change (reset + first 1:4 tile) < 1 s', () => {
		expect(report!.seedChange.p50).toBeLessThan(1000);
	});

	test.skipIf(!RUN_PERF)('generation floor: genTile 256x256 at 1:1 (measured ~64ms)', () => {
		expect(report!.tiles['1'].p50).toBeLessThan(250);
	});

	test.skipIf(!RUN_PERF)('generation floor: genTile 256x256 at 1:4 (measured ~355ms, exact noise cost)', () => {
		expect(report!.tiles['4'].p50).toBeLessThan(900);
	});
});
