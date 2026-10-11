import { fetchAsset, sanitizeAssetPath } from "./assets";
import { loadItems, loadBlockItemIds, type ItemData } from "./items";

/**
 * Texture resolution.
 *
 * Server-side port of the client fallback chain
 * (`src/tools/minecraft-items/data.ts#getTextureFallbacks`): the client tries
 * several URLs per item and the browser pays for each 404. The API resolves
 * the chain once and returns the bytes.
 */

export interface TextureHit {
	path: string;
	response: Response;
}

const TEXTURE_ROOTS = ["block", "item", "entity/banner", "entity/bed", "entity/shield"] as const;

function cleanTextureName(raw: string): string {
	let name = raw.trim().toLowerCase();
	name = name.replace(/^minecraft:/, "");
	name = name.replace(/\.(webp|png)$/, "");
	return name;
}

/** Build the same fallback chain the client builds for an item. */
export function buildItemCandidates(item: ItemData, isBlock: boolean): string[] {
	const baseUrl = item.textureUrl;
	if (!baseUrl.startsWith("/textures/")) return [baseUrl];

	const candidates: string[] = [baseUrl];
	if (isBlock) {
		const isSidePrimary = baseUrl.endsWith("_side.webp");
		const base = isSidePrimary ? baseUrl.replace(/_side\.webp$/, "") : baseUrl.replace(/\.webp$/, "");
		if (isSidePrimary) {
			candidates.push(`${base}_top.webp`, `${base}_bottom.webp`, `${base}.webp`);
		} else {
			candidates.push(`${base}_side.webp`, `${base}_top.webp`, `${base}_bottom.webp`);
		}
		for (const variant of item.textureVariants ?? []) {
			if (variant !== "_side" && variant !== "_top" && variant !== "_bottom") {
				candidates.push(`${base}${variant}.webp`);
			}
		}
	} else {
		const base = baseUrl.replace(/\.webp$/, "");
		for (const variant of item.textureVariants ?? []) {
			candidates.push(`${base}${variant}.webp`);
		}
	}
	return candidates;
}

/** Guess plausible locations for a bare texture name. */
export function buildNameCandidates(name: string): string[] {
	const cleaned = cleanTextureName(name);
	const candidates = new Set<string>();
	const withExt = (base: string) => {
		candidates.add(`${base}.webp`);
		candidates.add(`${base}.png`);
	};

	if (cleaned.includes("/")) {
		// Namespaced or nested name, e.g. "block/stone" or "entity/bed/red".
		withExt(`/textures/${cleaned}`);
		// banner/bed/shield live under textures/entity/
		if (/^(bed|banner|shield)\//.test(cleaned)) withExt(`/textures/entity/${cleaned}`);
		const last = cleaned.split("/").pop() ?? cleaned;
		for (const root of TEXTURE_ROOTS) withExt(`/textures/${root}/${last}`);
	} else {
		for (const root of TEXTURE_ROOTS) withExt(`/textures/${root}/${cleaned}`);
	}

	return [...candidates];
}

async function firstExisting(candidates: string[]): Promise<TextureHit | null> {
	for (const candidate of candidates) {
		const path = sanitizeAssetPath(candidate);
		if (!path) continue;
		const response = await fetchAsset(path);
		// Pages' ASSETS binding answers unknown paths with the SPA fallback
		// (index.html, 200), so only real image payloads count as a hit.
		if (response && response.headers.get("content-type")?.startsWith("image/")) {
			return { path, response };
		}
	}
	return null;
}

/**
 * Resolve a texture by item name/id (uses the item's own fallback chain) or by
 * bare texture name (tries the standard texture roots).
 */
export async function resolveTexture(rawName: string): Promise<TextureHit | null> {
	const items = await loadItems();
	const item = items.find(
		(candidate) =>
			candidate.name.toLowerCase() === rawName.toLowerCase() ||
			(/^\d+$/.test(rawName) && candidate.id === Number.parseInt(rawName, 10))
	);

	if (item) {
		const blockIds = await loadBlockItemIds();
		const isBlock = blockIds.has(item.id) || item.renderAs === "block";
		const hit = await firstExisting(buildItemCandidates(item, isBlock));
		if (hit) return hit;
	}

	return firstExisting(buildNameCandidates(rawName));
}
