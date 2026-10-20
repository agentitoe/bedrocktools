/*
 * Seed Map — wasm/bridge.ts
 * The SINGLE place that knows the WASM ABI of public/wasm/biomes-java-gen
 * (the narrow cubiomes wrapper in third_party/cubiomes-extensions).
 *
 * Runs inside one Web Worker per caller (or in tests / a smoke script): one
 * module instance per worker, no shared state between workers.
 *
 * Design rules (docs/seed-map-architecture.md):
 *   - BigInt never leaves the border; the bridge receives {hi, lo} pairs.
 *   - Output buffers are pre-allocated in the WASM heap and reused (grow-once,
 *     like the C-side cache). No malloc/free per call in steady state.
 *   - A result buffer owned by JS (Uint8ClampedArray) receives exactly ONE
 *     copy from the WASM heap — that array later rides a postMessage as a
 *     transferable (zero-copy main/worker hop).
 *   - C return codes map to typed BridgeError failures; tiles must never
 *     propagate partial contents silently.
 */

import { asSeed64, type Seed64 } from './seed64';
import type { RegionRect } from '../workers/protocol';

/** C codes from third_party/cubiomes-extensions/ext_bindings.h. */
export type BridgeErrorCode = 'einval' | 'ecache' | 'enomem' | 'egen';

export class BridgeError extends Error {
	readonly code: BridgeErrorCode;
	/** Negative C return code (EXT_*), when it came from a wrapper call. */
	readonly rc: number;

	constructor(code: BridgeErrorCode, rc = 0, context?: string) {
		super('WASM call failed (' + code + ')' + (context ? ': ' + context : ''));
		this.code = code;
		this.rc = rc;
	}
}

export type BiomeTileRequest = {
	scale: number;
	x: number;
	z: number;
	w: number;
	h: number;
};

export type StructureScanRequest = {
	type: number;
	region: RegionRect;
	flags: number;
};

export type SpawnPoint = { x: number; z: number };
export type StructurePos = { x: number; z: number };

/** (type, mc) structure configuration slice exposed by ext_get_structure_config. */
export type StructureConfigValues = {
	/** Structure salt (matches the catalog provenance table). */
	salt: number;
	/** Region size in chunks (the scanner granularity source of truth). */
	regionSize: number;
	/** Separation range in chunks (interior attempt span). */
	chunkRange: number;
};

/**
 * Shape of the exports Emscripten's MODULARIZE glue exposes for our build
 * (see -sEXPORTED_FUNCTIONS and -sEXPORTED_RUNTIME_METHODS in
 * scripts/build-wasm.mjs). Deliberately loose — it is C ABI over numbers.
 */
export interface RawCubiomesExports {
	_ext_set_seed(mc: number, flags: number, dim: number, seed_hi: number, seed_lo: number): number;
	_ext_gen_biome_tile(scale: number, x: number, z: number, w: number, h: number, out: number): number;
	_ext_find_structures(
		type: number, regX0: number, regZ0: number, regW: number, regH: number,
		flags: number, out: number, outCap: number,
	): number;
	_ext_get_spawn(out: number): number;
	_ext_ensure_cache(nInts: number): number;
	_malloc(size: number): number;
	_free(ptr: number): void;
	/** Uint8 view over linear memory (re-created by the glue on growth). */
	HEAPU8: Uint8Array;
	/** Int32 view over linear memory (re-created by the glue on growth). */
	HEAP32: Int32Array;
	_ext_find_strongholds(out: number, maxCount: number): number;
	_ext_get_structure_config(type: number, mc: number, out: number): number;
}

/** The glue module shape: default export is the (async) module factory. */
export interface CubiomesGlue {
	default: (moduleArg?: object) => Promise<RawCubiomesExports>;
}

type ModuleLoader = (glueUrl: string) => Promise<RawCubiomesExports>;

/** Default loader: dynamic import by URL (never bundled), then factory(). */
const defaultLoader: ModuleLoader = async (glueUrl) => {
	const glue = (await import(glueUrl)) as CubiomesGlue;
	return glue.default();
};

export class BiomesBridge {
	private module: RawCubiomesExports;

	// Reused WASM-side buffers (grow-once; steady state has zero allocation).
	private tileCap = 0;
	private tilePtr = 0;
	private scanCap = 0; // capacity in int32 values
	private scanPtr = 0;
	private spawnPtr = 0;
	private configPtr = 0;

	private constructor(module: RawCubiomesExports) {
		this.module = module;
	}

	/** Loads the glue by URL and instantiates the module (once per worker). */
	static async load(glueUrl: string, loader: ModuleLoader = defaultLoader): Promise<BiomesBridge> {
		return new BiomesBridge(await loader(glueUrl));
	}

	/** Wraps already-instantiated exports (tests, smoke script, main thread). */
	static fromModule(module: RawCubiomesExports): BiomesBridge {
		return new BiomesBridge(module);
	}

	/**
	 * Reconfigures the generator for a new seed/state. Calls ext_set_seed
	 * (setupGenerator + applySeed inside) — no WASM re-instantiation needed.
	 * flags = 0 for standard world generation (LARGE_BIOMES etc. later, E4).
	 */
	reset(seed: bigint | Seed64, version: number, dim: number, flags = 0): void {
		const { hi, lo } = asSeed64(seed);
		const rc = this.module._ext_set_seed(version, flags, dim, hi, lo);
		this.throwIfNok(rc, 'ext_set_seed');
	}

	/**
	 * Generates a biome tile into `out` (must hold >= w*h bytes). The tile is
	 * written row-major, one byte of biome id per cell (0xFF = EXT_BIOME_NONE).
	 */
	genTile(req: BiomeTileRequest, out: Uint8ClampedArray | Uint8Array): void {
		const cells = req.w * req.h;
		if (out.length < cells) {
			throw new BridgeError('einval', 0, 'buffer smaller than tile (' + out.length + ' < ' + cells + ')');
		}
		const ptr = this.tileBuffer(cells);
		const rc = this.module._ext_gen_biome_tile(req.scale, req.x, req.z, req.w, req.h, ptr);
		this.throwIfNok(rc, 'ext_gen_biome_tile');
		// Single copy WASM heap -> JS-owned buffer (the "one copy" of the doc).
		out.set(this.module.HEAPU8.subarray(ptr, ptr + cells));
	}

	/**
	 * Scans a structure rectangle; returns the viable positions found
	 * (cubiomes numeric enum as `type`; the typed catalog lives in E4).
	 */
	findStructures(req: StructureScanRequest): StructurePos[] {
		const { region, type, flags } = req;
		const maxHits = region.w * region.h;
		const ptr = this.scanBuffer(maxHits * 2); // (x, z) i32 pairs
		const n = this.module._ext_find_structures(
			type, region.x0, region.z0, region.w, region.h, flags, ptr, maxHits * 2,
		);
		if (n < 0) {
			this.throwIfNok(n, 'ext_find_structures');
		}
		const heap = this.module.HEAP32;
		const hits: StructurePos[] = new Array(n);
		for (let i = 0; i < n; i++) {
			hits[i] = { x: heap[ptr / 4 + 2 * i], z: heap[ptr / 4 + 2 * i + 1] };
		}
		return hits;
	}

	/** World spawn of the current state (calls cubiomes getSpawn). */
	getSpawn(): SpawnPoint {
		this.ensureSpawnBuffer();
		const rc = this.module._ext_get_spawn(this.spawnPtr);
		this.throwIfNok(rc, 'ext_get_spawn');
		const heap = this.module.HEAP32;
		return { x: heap[this.spawnPtr / 4], z: heap[this.spawnPtr / 4 + 1] };
	}

	/**
	 * Ring-walks ALL strongholds (vanilla order, up to 128 on 1.18+) with
	 * accurate biome-checked positions. Strongholds are not region-based, so
	 * they ride their own call (ext_find_strongholds) instead of the scan
	 * rectangles of findStructures().
	 */
	findStrongholds(maxCount = 128): StructurePos[] {
		if (maxCount <= 0) throw new BridgeError('einval', 0, 'maxCount');
		const ptr = this.scanBuffer(maxCount * 2); // (x, z) i32 pairs
		const n = this.module._ext_find_strongholds(ptr, maxCount);
		if (n < 0) {
			this.throwIfNok(n, 'ext_find_strongholds');
		}
		const heap = this.module.HEAP32;
		const hits: StructurePos[] = new Array(n);
		for (let i = 0; i < n; i++) {
			hits[i] = { x: heap[ptr / 4 + 2 * i], z: heap[ptr / 4 + 2 * i + 1] };
		}
		return hits;
	}

	/**
	 * Structure region configuration for one (type, mc) pair: from cubiomes'
	 * getStructureConfig — the numbers the typed catalog asserts against
	 * (region granularity of the scanner and the 1.18+-era region sizes).
	 */
	getStructureConfig(type: number, mc: number): StructureConfigValues {
		this.ensureConfigBuffer();
		const rc = this.module._ext_get_structure_config(type, mc, this.configPtr);
		this.throwIfNok(rc, 'ext_get_structure_config');
		const heap = this.module.HEAP32;
		return {
			salt: heap[this.configPtr / 4],
			regionSize: heap[this.configPtr / 4 + 1],
			chunkRange: heap[this.configPtr / 4 + 2],
		};
	}

	private throwIfNok(rc: number, context: string): void {
		if (rc === 0) return;
		const code = rc >= 0 ? 'egen' : rc === -1 ? 'einval' : rc === -2 ? 'ecache' : rc === -3 ? 'enomem' : 'egen';
		throw new BridgeError((code as BridgeErrorCode), rc, context);
	}

	/** Grow-once scratch space of `need` bytes for tile output. */
	private tileBuffer(need: number): number {
		if (this.tileCap >= need) return this.tilePtr;
		const ptr = this.module._malloc(need);
		if (ptr === 0) throw new BridgeError('enomem', 0, 'tile buffer ' + need + ' bytes');
		if (this.tilePtr !== 0) this.module._free(this.tilePtr);
		this.tilePtr = ptr;
		this.tileCap = need;
		return ptr;
	}

	/** Grow-once scratch space of `needValues` int32s for structure scans. */
	private scanBuffer(needValues: number): number {
		if (this.scanCap >= needValues) return this.scanPtr;
		const bytes = needValues * 4;
		const ptr = this.module._malloc(bytes);
		if (ptr === 0) throw new BridgeError('enomem', 0, 'scan buffer ' + bytes + ' bytes');
		if (this.scanPtr !== 0) this.module._free(this.scanPtr);
		this.scanPtr = ptr;
		this.scanCap = needValues;
		return ptr;
	}

	private ensureSpawnBuffer(): void {
		if (this.spawnPtr === 0) {
			this.spawnPtr = this.module._malloc(8);
			if (this.spawnPtr === 0) throw new BridgeError('enomem', 0, 'spawn buffer');
		}
	}

	/** Fixed-sized (3 i32) configuration buffer, used once per request. */
	private ensureConfigBuffer(): void {
		if (this.configPtr === 0) {
			this.configPtr = this.module._malloc(12);
			if (this.configPtr === 0) throw new BridgeError('enomem', 0, 'structure config buffer');
		}
	}
}
