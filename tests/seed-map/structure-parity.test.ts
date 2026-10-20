/*
 * Seed Map — structure parity test (drift guard, gated by RUN_PARITY=1).
 *
 * PURPOSE: guards two drift risks the unit tests cannot see:
 *   1. C→WASM compilation drift: tests/fixtures/structure-parity.c repliCATE
 *      the ext_find_structures / ext_find_strongholds semantics DIRECTLY on
 *      the cubiomes public API (setupGenerator/applySeed/getStructurePos/
 *      isViableStructurePos + StrongholdIter). It is compiled to a throwaway
 *      ES module (tests/fixtures/build/, gitignored — NOT the committed
 *      production artifacts) and its position dump is compared against the
 *      COMMITTED module. If ext_bindings.c drifts from raw cubiomes, or the
 *      committed .wasm stops matching what ext_bindings.c claims, positions
 *      diverge here.
 *   2. Catalog/transfer drift: the same positions flow through
 *      BiomesBridge.fromModule(...) exactly as the worker consumes them
 *      (reset with {hi,lo}-reassembled uint64, findStructures region rect,
 *      findStrongholds ring cap), so ABI/transfer changes surface here too.
 *
 * Run manually: bun run test with RUN_PARITY=1 (requires Emscripten:
 * env EMCC overrides, default <home>/emsdk/upstream/emscripten/emcc.exe).
 * Without RUN_PARITY=1 the whole file skips with a message.
 */

import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { BiomesBridge, type RawCubiomesExports } from '../../src/tools/seed-map/wasm/bridge';

const RUN_PARITY = process.env.RUN_PARITY === '1';
const ROOT = join(import.meta.dir, '..', '..');
const BUILD_DIR = join(ROOT, 'tests', 'fixtures', 'build');
const FIXTURE_C = join(ROOT, 'tests', 'fixtures', 'structure-parity.c');
const FIXTURE_MJS = join(BUILD_DIR, 'structure-parity.mjs');
const FIXTURE_WASM = join(BUILD_DIR, 'structure-parity.wasm');
const COMMITTED_MJS = join(ROOT, 'public', 'wasm', 'biomes-java-gen.mjs');
const COMMITTED_WASM = join(ROOT, 'public', 'wasm', 'biomes-java-gen.wasm');

/** Mirror of ext_find_strongholds' parity cap in the fixture (STRonghold_CAP). */
const STRONGHOLD_CAP = 16;

type ScanLine = {
	kind: 'scan';
	seed: string;
	mc: number;
	type: number;
	rx: number;
	rz: number;
	w: number;
	h: number;
	pos: string;
};
type StrongholdLine = { kind: 'strongholds'; seed: string; mc: number; pos: string };
type ParityLine = ScanLine | StrongholdLine;

function resolveEmcc(): string | null {
	const name = process.platform === 'win32' ? 'emcc.exe' : 'emcc';
	const candidates = [process.env.EMCC || null, join(homedir(), 'emsdk', 'upstream', 'emscripten', name)];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

function cubiomesSources(): string[] {
	const cubiomesDir = join(ROOT, 'third_party', 'cubiomes');
	const skip = new Set(['tests.c']);
	const sources: string[] = [];
	for (const name of readdirSync(cubiomesDir).sort()) {
		if (!name.endsWith('.c') || skip.has(name)) continue;
		if (!statSync(join(cubiomesDir, name)).isFile()) continue;
		sources.push(join(cubiomesDir, name));
	}
	for (const name of readdirSync(join(cubiomesDir, 'features')).sort()) {
		if (name.endsWith('.c')) sources.push(join(cubiomesDir, 'features', name));
	}
	return sources;
}

/** Rebuilds only when the fixture or any cubiomes source is newer than the dump module. */
function buildFixture(emcc: string): void {
	mkdirSync(BUILD_DIR, { recursive: true });
	if (existsSync(FIXTURE_MJS) && existsSync(FIXTURE_WASM)) {
		const built = statSync(FIXTURE_MJS).mtimeMs;
		const stale = [FIXTURE_C, ...cubiomesSources()].some((p) => statSync(p).mtimeMs > built);
		if (!stale) return;
	}
	// Same source set as the production build minus ext_bindings.c: the
	// fixture must prove itself against RAW cubiomes, not against the
	// wrapper it is guarding.
	const args = [
		...cubiomesSources(),
		FIXTURE_C,
		'-O2',
		'-fwrapv',
		'-DNDEBUG',
		'-I' + join(ROOT, 'third_party', 'cubiomes'),
		'-sENVIRONMENT=node',
		'-sMODULARIZE',
		'-sEXPORT_ES6',
		'-sALLOW_MEMORY_GROWTH=1',
		'-sWASM_ASYNC_COMPILATION=0',
		'-sSTACK_SIZE=2097152',
		'-sEXPORTED_FUNCTIONS=[_parity_dump]',
		'--no-entry',
		'-o',
		FIXTURE_MJS,
	];
	// eslint-disable-next-line no-console
	console.info('[structure-parity] compiling fixture (this can take a few seconds)...');
	const probe = Bun.spawnSync([emcc, ...args], { cwd: ROOT });
	if (probe.exitCode !== 0 || !existsSync(FIXTURE_MJS)) {
		throw new Error('emcc failed (exit ' + probe.exitCode + '):\n' + probe.stderr.toString());
	}
}

function parsePos(pos: string): { x: number; z: number }[] {
	if (pos === '') return [];
	return pos.split('|').map((pair) => {
		const [x, z] = pair.split(',').map(Number);
		return { x, z };
	});
}

/** Exact ordered/toto comparison with a parity-specific failure context. */
function expectSamePositions(
	actual: { x: number; z: number }[],
	expected: { x: number; z: number }[],
	context: string,
): void {
	const mismatch = actual.length !== expected.length
		|| actual.some((p, i) => p.x !== expected[i].x || p.z !== expected[i].z);
	if (mismatch) {
		throw new Error(
			'parity mismatch (' + context + ')\n'
				+ '  fixture (raw cubiomes): ' + JSON.stringify(expected) + '\n'
				+ '  committed module wasm : ' + JSON.stringify(actual),
		);
	}
}

const emccResolved = resolveEmcc();
const canRun = RUN_PARITY && emccResolved !== null;
if (RUN_PARITY && emccResolved === null) {
	// eslint-disable-next-line no-console
	console.info('[structure-parity] RUN_PARITY=1 but no Emscripten found (set env EMCC) — skipping.');
}

test.skipIf(!canRun)(
	'parity: committed wasm positions match raw cubiomes for the full fixture matrix',
	async () => {
		// Arrange --------------------------------------------------------------

		const emcc = emccResolved!;
		buildFixture(emcc);

		// 10-minute window: the throwaway emcc build dominates (cache makes
		// later runs load-only).
		const dumpLines: string[] = [];
		const fixtureGlue = (await import(pathToFileURL(FIXTURE_MJS).href)) as {
			default: (arg?: object) => Promise<{ _parity_dump: () => number }>;
		};
		const fixtureModule = await fixtureGlue.default({
			print: (s: string) => dumpLines.push(s),
			wasmBinary: new Uint8Array(readFileSync(FIXTURE_WASM)),
		});

		const committedGlue = (await import(pathToFileURL(COMMITTED_MJS).href)) as {
			default: (arg?: object) => Promise<RawCubiomesExports>;
		};
		const committedModule = await committedGlue.default({
			wasmBinary: new Uint8Array(readFileSync(COMMITTED_WASM)),
		});
		const bridge = BiomesBridge.fromModule(committedModule);

		const rc = fixtureModule._parity_dump();
		expect(rc).toBe(0);
		const lines = dumpLines.map((raw) => JSON.parse(raw) as ParityLine);
		// 5 seeds x (14 region kinds + 3 chunk kinds + strongholds + 2 old-MC probes).
		expect(lines).toHaveLength(100);
		for (const line of lines) {
			expect(line.seed).toBeDefined();
			expect(Number.isFinite(line.mc)).toBe(true);
			expect(line.mc === 22 || line.mc === 32).toBe(true);
		}

		// Act + Assert: replay every scan through the committed module, keyed so
		// each (seed, mc) triggers exactly one bridge.reset (the worker reuse path).
		let checked = 0;
		let lastStateKey: string | null = null;
		for (const line of lines) {
			const stateKey = line.seed + '|' + line.mc;
			if (stateKey !== lastStateKey) {
				bridge.reset(BigInt(line.seed), line.mc, 0);
				lastStateKey = stateKey;
			}
			if (line.kind === 'scan') {
				const context = 'seed=' + line.seed + ' mc=' + line.mc + ' type=' + line.type
					+ ' region=[' + line.rx + ',' + line.rz + ',' + line.w + ',' + line.h + ']';
				expectSamePositions(
					bridge.findStructures({
						type: line.type,
						region: { x0: line.rx, z0: line.rz, w: line.w, h: line.h },
						flags: 0,
					}),
					parsePos(line.pos),
					context,
				);
			} else {
				const context = 'strongholds seed=' + line.seed + ' mc=' + line.mc + ' cap=' + STRONGHOLD_CAP;
				expectSamePositions(bridge.findStrongholds(STRONGHOLD_CAP), parsePos(line.pos), context);
			}
			checked++;
		}
		expect(checked).toBe(100);
	},
	600_000,
);
