/*
 * Seed Map — workers/seed-worker.ts
 * Worker RUNTIME entry (compiled to public/tools/seed-map/seed-worker.js by
 * scripts/build.mjs and started as a module Web Worker). This file only wires
 * the runtime: every behavior lives in seed-worker-core.ts, every WASM access
 * in wasm/bridge.ts. No map logic in here.
 *
 * Loading path (never bundled): dynamic import("/wasm/biomes-java-gen.mjs")
 * by URL — the glue resolves its sibling .wasm relative to its own
 * import.meta.url over the same origin. The worker keeps exactly ONE module
 * instance; buffer reuse and grow-once allocations live in the bridge.
 */

import { BiomesBridge } from '../wasm/bridge';
import { WASM_MODULES } from '../wasm/manifest';
import { SeedWorkerCore } from './seed-worker-core';
import type { WorkerInbound, WorkerResult } from './protocol';

/** The env whose glue the worker serves; the Bedrock module joins in E5. */
const BIOMES_MODULE = WASM_MODULES.biomes;

const core = new SeedWorkerCore(() => BiomesBridge.load(BIOMES_MODULE.glueUrl));

interface WorkerSelf {
	postMessage(msg: WorkerResult, transfer?: Transferable[]): void;
	onmessage: ((event: { data: WorkerInbound }) => void) | null;
}

const scope = self as unknown as WorkerSelf;

scope.onmessage = (event) => {
	const inbound = event.data;
	core.handle(inbound).then((outbound) => {
		for (const result of outbound) {
			// Tile pixels are transferred (zero-copy main/worker hop); the raw
			// WASM memory stays owned by the module in this worker.
			if (result.kind === 'tiles' && result.results.length > 0) {
				scope.postMessage(result, [result.results[0].pixels.buffer]);
			} else {
				scope.postMessage(result);
			}
		}
	}).catch((err) => {
		// handle() maps its own errors; this catches a broken runtime itself.
		const requestId = 'id' in inbound ? inbound.id : 0;
		scope.postMessage({
			id: requestId,
			kind: 'error',
			message: err instanceof Error ? err.message : String(err),
		});
	});
};
