import type { Fetcher } from "@cloudflare/workers-types";

/**
 * Asset access helpers.
 *
 * Pages Functions cannot read the deployment filesystem (the node:fs shim only
 * exposes /bundle and /tmp), so all data is read through the ASSETS binding.
 * Parsed JSON is cached per isolate with a short TTL: JSON parsing is the only
 * meaningful CPU cost of these endpoints and the free Workers plan allows
 * 10 ms of CPU per request, so the first request per isolate pays the parse
 * and the rest are served from memory.
 */

const JSON_TTL_MS = 5 * 60 * 1000;

/** Origin used to address the ASSETS binding; only the pathname matters. */
const ASSET_ORIGIN = "https://assets.bedrocktools.internal";

const jsonCache = new Map<string, { expires: number; value: unknown }>();

/**
 * The ASSETS binding of the current request (handed over by the Pages
 * Function entry point before handling). Isolates run requests serially and
 * the binding object is the same for the whole isolate, so a module-level
 * slot is safe. Required because the Elysia app is compiled once per isolate
 * at startup, when no request context exists yet.
 */
let assetsBinding: Fetcher | null = null;

export function bindAssets(assets: Fetcher): void {
	assetsBinding = assets;
}

function getAssets(): Fetcher {
	if (!assetsBinding) throw new Error("ASSETS binding is not available");
	return assetsBinding;
}

/**
 * Normalize a path coming from user input and reject anything unsafe.
 * Returns `null` when the path must not be used.
 */
export function sanitizeAssetPath(raw: string): string | null {
	const cleaned = raw.replace(/\\/g, "/").trim();
	if (!cleaned) return null;
	if (cleaned.includes("..")) return null;
	if (!/^\/?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(cleaned)) return null;
	return `/${cleaned.replace(/^\/+/, "")}`;
}

/** Validate a bare resource name (used for model keys, not paths). */
export function sanitizeName(raw: string): string | null {
	const cleaned = raw.trim();
	if (!cleaned) return null;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned)) return null;
	return cleaned;
}

/** Build a request that the ASSETS binding will resolve by pathname. */
export function assetRequest(path: string): Request {
	return new Request(`${ASSET_ORIGIN}${path}`);
}

/** Load and cache a JSON document from the deployment assets. */
export async function loadJson<T>(path: string): Promise<T | null> {
	const now = Date.now();
	const cached = jsonCache.get(path);
	if (cached && cached.expires > now) return cached.value as T;

	const res = await getAssets().fetch(assetRequest(path));
	// Pages' ASSETS binding answers unknown paths with the SPA fallback
	// (index.html, 200), so require an actual JSON payload.
	if (!res.ok) return null;
	if (!res.headers.get("content-type")?.includes("json")) return null;

	const value = (await res.json()) as T;
	jsonCache.set(path, { expires: now + JSON_TTL_MS, value });
	return value;
}

/** Fetch a raw asset (textures); returns `null` when missing. */
export async function fetchAsset(path: string): Promise<Response | null> {
	const res = await getAssets().fetch(assetRequest(path));
	if (!res.ok || !res.body) return null;
	return res;
}

/** Test hook: drop the in-memory JSON cache. */
export function clearAssetCache(): void {
	jsonCache.clear();
}
