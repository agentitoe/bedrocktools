/*
 * Seed Map — manifest ↔ checksums.json sync test.
 * The TS manifest hard-codes the SHA-256 hashes of the committed artifacts
 * (SSOT-of-record is public/wasm/checksums.json, written by build-wasm.mjs).
 * A rebuild that changes artifacts without updating the manifest fails here —
 * stale cached modules would otherwise ship silently.
 */

import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WASM_MODULES } from '../../src/tools/seed-map/wasm/manifest';

const root = process.env.PROJECT_ROOT ?? process.cwd();
const checksums = JSON.parse(
	readFileSync(join(root, 'public', 'wasm', 'checksums.json'), 'utf8'),
) as Record<string, string>;

test('checksums.json contains exactly the four committed artifacts', () => {
	expect(Object.keys(checksums).sort()).toEqual([
		'bedrock-structures.mjs',
		'bedrock-structures.wasm',
		'biomes-java-gen.mjs',
		'biomes-java-gen.wasm',
	]);
});

test('the TS manifest mirrors checksums.json', () => {
	expect(Object.keys(WASM_MODULES).sort()).toEqual(['bedrock', 'biomes']);
	for (const mod of Object.values(WASM_MODULES)) {
		const glueName = mod.glueUrl.split('/').pop()!;
		const wasmName = glueName.replace(/\.mjs$/, '.wasm');
		expect(checksums[glueName]).toBeDefined();
		expect(checksums[wasmName]).toBeDefined();
		expect(mod.sha256.glue).toBe(checksums[glueName]);
		expect(mod.sha256.wasm).toBe(checksums[wasmName]);
		// URLs are root-relative same-origin paths (doc requirement).
		expect(mod.glueUrl.startsWith('/wasm/')).toBe(true);
	}
});
