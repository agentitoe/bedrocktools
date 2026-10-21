import { loadJson } from "./assets";

/**
 * Item catalog helpers.
 *
 * Shape mirrors `src/tools/minecraft-items/types.ts` (the client type); the
 * server is the source of projections and filtering, clients ask for exactly
 * the fields they need instead of downloading the full 385 KB catalog.
 */

export interface ItemLayer {
	url: string;
	tint?: string;
}

export interface ItemData {
	id: number;
	name: string;
	displayName: string;
	displayNameEs?: string;
	stackSize: number;
	textureUrl: string;
	textureVariants?: string[];
	renderAs?: "block" | "item" | "layered";
	modelName?: string;
	layers?: ItemLayer[];
}

export type ItemKind = "block" | "item" | "layered";
export type Lang = "en" | "es";

const COMPACT_FIELDS = ["id", "name", "displayName", "textureUrl", "renderAs"] as const;

export async function loadItems(): Promise<ItemData[]> {
	return (await loadJson<ItemData[]>("/data/items.json")) ?? [];
}

export async function loadBlockItemIds(): Promise<Set<number>> {
	const ids = await loadJson<number[]>("/data/block-item-ids.json");
	return new Set(ids ?? []);
}

export interface ProjectionOptions {
	lang: Lang;
	fields?: readonly string[];
}

/**
 * Project an item to a plain response object.
 * `lang: "es"` swaps displayName for the Spanish name when available and
 * preserves the English one as `displayNameEn`.
 */
export function projectItem(item: ItemData, { lang, fields }: ProjectionOptions): Record<string, unknown> {
	const keys = fields && fields.length > 0 ? fields : undefined;
	if (!keys) {
		const out: Record<string, unknown> = { ...item };
		if (lang === "es" && item.displayNameEs) {
			out.displayNameEn = item.displayName;
			out.displayName = item.displayNameEs;
		}
		return out;
	}
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (key === "displayName") {
			out.displayName = lang === "es" && item.displayNameEs ? item.displayNameEs : item.displayName;
			if (lang === "es" && item.displayNameEs) out.displayNameEn = item.displayName;
		} else if (key in item) {
			out[key] = item[key as keyof ItemData];
		}
	}
	return out;
}

export function compactFields(): readonly string[] {
	return COMPACT_FIELDS;
}

export interface FilterOptions {
	search?: string;
	kind?: string;
	limit: number;
}

/** Lightweight in-memory filter over the catalog (no index build: CPU budget). */
export function filterItems(items: ItemData[], { search, kind, limit }: FilterOptions): ItemData[] {
	const needle = search?.trim().toLowerCase() ?? "";
	return items
		.filter((item) => {
			if (kind && item.renderAs !== kind) return false;
			if (!needle) return true;
			return (
				item.name.toLowerCase().includes(needle) ||
				item.displayName.toLowerCase().includes(needle) ||
				(item.displayNameEs?.toLowerCase().includes(needle) ?? false)
			);
		})
		.slice(0, limit);
}

/** Resolve an item by numeric id or by exact name (case-insensitive). */
export function findItemByIdOrName(items: ItemData[], key: string): ItemData | undefined {
	if (/^\d+$/.test(key)) {
		const id = Number.parseInt(key, 10);
		const byId = items.find((item) => item.id === id);
		if (byId) return byId;
	}
	const lower = key.toLowerCase();
	return items.find((item) => item.name.toLowerCase() === lower);
}
