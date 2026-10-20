/*
 * Seed Map — wasm/manifest.ts
 * SSOT of the compiled WebAssembly artifacts consumed by the tool.
 *
 * Pure data (same rule as the tool manifests): no logic, no imports — the
 * build imports it with a plain dynamic import. The hashes mirror
 * public/wasm/checksums.json (written by scripts/build-wasm.mjs); a test in
 * tests/seed-map/ asserts both stay in sync so a stale manifest fails CI.
 *
 * The glue .mjs is a COMMITTED asset, never bundled: the worker imports it by
 * URL (dynamic import of a same-origin static path) and Emscripten resolves
 * the sibling .wasm file relative to the glue's own import.meta.url. This is
 * why the glue must be served next to its .wasm and must not pass through
 * Bun.build (it would change the script directory the glue computes).
 */

export type WasmModuleId = 'biomes' | 'bedrock';

/** Root-relative path where build-wasm.mjs drops the artifacts. */
export const WASM_BASE = '/wasm/';

export type WasmModuleManifest = {
	id: WasmModuleId;
	/** Same-origin ES module (the Emscripten glue). Imported by URL. */
	glueUrl: string;
	/** SHA-256 of the artifacts, mirrors public/wasm/checksums.json. */
	sha256: {
		glue: string;
		wasm: string;
	};
};

export const WASM_MODULES: Record<WasmModuleId, WasmModuleManifest> = {
	biomes: {
		id: 'biomes',
		glueUrl: WASM_BASE + 'biomes-java-gen.mjs',
		sha256: {
			glue: '34610699acb4e08be57cea4f992641e9a311ba3712af65283d764ff7f5b34bd1',
			wasm: '5c838593c059a74c4051bd0174dfe45cf4b5cee0976a85c2e1c8319dcd3784ba',
		},
	},
	bedrock: {
		id: 'bedrock',
		glueUrl: WASM_BASE + 'bedrock-structures.mjs',
		sha256: {
			glue: 'c531149fbc8aa5a68f587120777a1812af10bea8a5b9eb73f4c492a922c600cb',
			wasm: '8838f68fd96e5dc2cecf2e1b635bf55e5201614a7f571f2662bfd064f7946899',
		},
	},
};
