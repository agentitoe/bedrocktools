import { unzipSync, zipSync } from "fflate";
import { sanitizeZipPath } from "../../shared/path";
import { decodeUtf8Sig, encodeUtf8 } from "../../shared/encoding";
import { stripJsonComments } from "../../shared/json";

/** Anti zip-bomb limits (surfaced as UI errors by the page's catch). */
export const MAX_ENTRIES = 2000;
export const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
export const MAX_FILE = 50 * 1024 * 1024;
/** Max nesting depth for `.mcpack` files inside the archive. */
const MAX_NESTING = 3;

const MANIFEST_SUFFIX = "/manifest.json";

/** Parse JSON with comments; returns `null` on invalid input. */
function tryParseJson(text: string): any | null {
	let data: any;
	try {
		data = JSON.parse(stripJsonComments(text));
	} catch {
		return null;
	}
	return data;
}

/** Shared behavior-pack check over an already-parsed manifest object. */
function isBehaviorManifest(data: any): boolean {
	if (!data || typeof data !== "object") return false;
	const modules = Array.isArray(data.modules) ? data.modules : [];
	for (let i = 0; i < modules.length; i++) {
		const m = modules[i];
		if (typeof m === "object" && m !== null && m.type === "data") {
			return true;
		}
	}
	const header =
		typeof data.header === "object" && data.header !== null ? data.header : null;
	if (header !== null && header.module_type === "data") {
		return true;
	}
	return false;
}

export function isBehaviorPack(manifestText: string): boolean {
	const data = tryParseJson(manifestText);
	if (data === null) return false;
	return isBehaviorManifest(data);
}

export function updateManifest(data: Uint8Array): Uint8Array {
	let manifest: any;
	try {
		const cleaned = stripJsonComments(decodeUtf8Sig(data));
		manifest = JSON.parse(cleaned);
	} catch {
		return data;
	}
	if (!manifest || typeof manifest !== "object") {
		return data;
	}
	if (!manifest.metadata || typeof manifest.metadata !== "object") {
		manifest.metadata = {};
	}
	manifest.metadata.product_type = "addon";
	return encodeUtf8(JSON.stringify(manifest, null, 4));
}

/**
 * Single-parse path: decode + strip + parse once, then decide + update.
 * Returns updated bytes when the manifest is a behavior pack, `null`
 * otherwise (not a manifest, invalid JSON, or not a behavior pack).
 */
function convertManifestOnce(content: Uint8Array): Uint8Array | null {
	const data = tryParseJson(decodeUtf8Sig(content));
	if (data === null || !isBehaviorManifest(data)) return null;
	if (!data.metadata || typeof data.metadata !== "object") {
		data.metadata = {};
	}
	data.metadata.product_type = "addon";
	return encodeUtf8(JSON.stringify(data, null, 4));
}

function safeUnzip(data: Uint8Array): Record<string, Uint8Array> {
	let raw: Record<string, Uint8Array>;
	try {
		raw = unzipSync(data);
	} catch {
		throw new Error("Invalid pack file (could not unzip)");
	}
	const names = Object.keys(raw);
	if (names.length > MAX_ENTRIES) {
		throw new Error(`Pack too large: exceeds ${MAX_ENTRIES} files limit`);
	}
	let total = 0;
	for (let i = 0; i < names.length; i++) {
		const size = raw[names[i]].length;
		if (size > MAX_FILE) {
			throw new Error("Pack too large: a file exceeds 50 MB");
		}
		total += size;
		if (total > MAX_TOTAL_UNCOMPRESSED) {
			throw new Error("Pack too large: exceeds 200 MB uncompressed");
		}
	}
	return raw;
}

async function processPackInner(data: Uint8Array, depth: number): Promise<Uint8Array> {
	const raw = safeUnzip(data);
	const toZip: Record<string, Uint8Array> = {};

	for (const path of Object.keys(raw)) {
		if (path.endsWith("/")) continue;
		const p = sanitizeZipPath(path);
		// Drop Zip-Slip / absolute entries instead of writing them out.
		if (p === null) continue;
		const content = raw[path];
		const lower = p.toLowerCase();

		if (lower.endsWith(".mcpack")) {
			if (depth >= MAX_NESTING) {
				toZip[p] = content;
				continue;
			}
			toZip[p] = await processPackInner(content, depth + 1);
			continue;
		}

		if (lower === "manifest.json" || lower.endsWith(MANIFEST_SUFFIX)) {
			const updated = convertManifestOnce(content);
			toZip[p] = updated ?? content;
			continue;
		}

		toZip[p] = content;
	}

	return zipSync(toZip, { level: 6 });
}

export async function processPack(data: Uint8Array): Promise<Uint8Array> {
	return processPackInner(data, 0);
}