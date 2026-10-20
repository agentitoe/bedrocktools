/*
 * Seed Map — workers/worker-factory.ts
 * Browser adapter: builds the real module Web Worker for the pool. Kept in
 * its own file so tests can import worker-pool.ts without touching the
 * Worker constructor via module-level side effects.
 *
 * The worker bundle lives at public/tools/seed-map/seed-worker.js (an
 * entrypoint compiled by scripts/build.mjs like every tool bundle). It is
 * loaded as an ES module by URL: its own dynamic import() fetches the glue
 * and then the .wasm, all same-origin, never bundled.
 */

import type { WorkerLike } from './worker-pool';
import type { WorkerResult } from './protocol';

export const SEED_WORKER_URL = '/tools/seed-map/seed-worker.js';

export function isWorkerRuntimeAvailable(): boolean {
	return typeof Worker !== 'undefined';
}

export function createSeedWorker(): WorkerLike {
	// Runtime guard: the URL is static and same-origin (Cloudflare Pages),
	// so this is as portable as a module worker gets.
	if (typeof Worker === 'undefined') {
		throw new Error('Web Workers are not available in this environment');
	}
	const raw = new Worker(SEED_WORKER_URL, { type: 'module' });
	return {
		postMessage(msg, transfer) {
			raw.postMessage(msg, transfer ?? []);
		},
		terminate() {
			raw.terminate();
			return Promise.resolve();
		},
		set onResult(handler: (result: WorkerResult) => void) {
			raw.onmessage = (event) => handler(event.data);
			raw.onerror = (event) => {
				handler({
					id: 0,
					kind: 'error',
					message: event.message || 'worker error',
				});
			};
		},
	};
}
