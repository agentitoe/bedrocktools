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
			glue: '6a6b4920973bce760a641dc1d888232e7dee9b3141bea606c4b972f02a03af61',
			wasm: '01f315df64156283cc7b38504e4685413dd41f80143ace90c2bcc596d57534e5',
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
