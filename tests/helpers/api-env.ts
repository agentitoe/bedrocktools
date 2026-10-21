import { join } from "node:path";
import type { Fetcher } from "@cloudflare/workers-types";
import { createApp } from "../../functions/api/app";
import { bindAssets } from "../../functions/api/lib/assets";

/**
 * Integration-style tests against the real `public/` data through a mock
 * ASSETS fetcher (the Pages binding resolves requests by pathname).
 */
export const publicDir = join(import.meta.dir, "..", "..", "public");

export function mockAssets(publicRoot: string = publicDir): Fetcher {
	// Mirrors the real ASSETS binding: missing paths fall back to index.html
	// with 200 (SPA fallback), so handlers must not trust `ok` alone.
	const spaFallback = Bun.file(join(publicRoot, "index.html"));
	return {
		fetch: async (input: RequestInfo | URL) => {
			const raw = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			const { pathname } = new URL(raw);
			const file = Bun.file(join(publicRoot, pathname));
			if (await file.exists()) {
				// Set the content-type explicitly: Bun only materializes it lazily
				// when constructing a Response from a BunFile.
				return new Response(file, { headers: { "content-type": file.type ?? "application/octet-stream" } });
			}
			if (await spaFallback.exists()) return new Response(spaFallback, { headers: { "content-type": "text/html" } });
			return new Response("Not found", { status: 404 });
		},
		connect: () => Promise.reject(new Error("not implemented"))
	} as unknown as Fetcher;
}

/** Binds the shared mock ASSETS fetcher (the `bindAssets` side-effect singleton). */
export function setupTestAssets(): void {
	bindAssets(mockAssets());
}

export function apiRequest(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, init);
}

export async function getJson(app: { handle: (request: Request) => Promise<Response> }, path: string) {
	const res = await app.handle(apiRequest(path));
	return { status: res.status, body: await res.json(), headers: res.headers };
}

/** Full API test environment: mock ASSETS bound + app ready to handle requests. */
export function createTestEnv() {
	setupTestAssets();
	return createApp();
}
