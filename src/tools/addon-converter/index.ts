import { unzipSync, zipSync } from "fflate";
import { normalizePath } from "../../shared/path";
import { decodeUtf8Sig, encodeUtf8 } from "../../shared/encoding";
import { stripJsonComments } from "../../shared/json";

export function isBehaviorPack(manifestText: string): boolean {
	const cleaned = stripJsonComments(manifestText);
	let data: any;
	try {
		data = JSON.parse(cleaned);
	} catch {
		return false;
	}

	const modules = Array.isArray(data.modules) ? data.modules : [];
	for (const m of modules) {
		if (typeof m === "object" && m !== null && m.type === "data") {
			return true;
		}
	}

	const header = typeof data.header === "object" && data.header !== null ? data.header : {};
	if (header.module_type === "data") {
		return true;
	}

	return false;
}

export function updateManifest(data: Uint8Array): Uint8Array {
	const cleaned = stripJsonComments(decodeUtf8Sig(data));
	const manifest = JSON.parse(cleaned);
	if (!manifest || typeof manifest !== "object") {
		return data;
	}
	if (!manifest.metadata || typeof manifest.metadata !== "object") {
		manifest.metadata = {};
	}
	manifest.metadata.product_type = "addon";
	return encodeUtf8(JSON.stringify(manifest, null, 4));
}

export async function processPack(data: Uint8Array): Promise<Uint8Array> {
	const raw = unzipSync(data);
	const toZip: Record<string, Uint8Array> = {};

	for (const [path, content] of Object.entries(raw)) {
		const p = normalizePath(path);
		if (p.endsWith("/")) {
			continue;
		}

		if (p.toLowerCase().endsWith(".mcpack")) {
			toZip[p] = await processPack(content);
			continue;
		}

		const lower = p.toLowerCase();
		if (lower === "manifest.json" || /\/manifest\.json$/.test(lower)) {
			const text = decodeUtf8Sig(content);
			if (isBehaviorPack(text)) {
				toZip[p] = updateManifest(content);
				continue;
			}
		}

		toZip[p] = content;
	}

	return zipSync(toZip, { level: 6 });
}