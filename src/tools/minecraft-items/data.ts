import type { ItemData, RecipeData } from './types';
import { translations } from './translations';

// ---- Mutable app state ----

export let allItems: ItemData[] = [];
export let allRecipes: Record<number, RecipeData[]> = {};
export let itemIds: Set<number> = new Set();
export let blockItemIds: Set<number> = new Set();

export let currentLang = 'es';

/** Update the active language (imports are read-only, so state changes go through setters). */
export function setCurrentLang(lang: string): void {
	currentLang = lang;
}

// ---- O(1) indexes (invalidated on loadData) ----

/** id -> item for O(1) lookups (replaces O(n) Array.find). */
let itemById = new Map<number, ItemData>();
/** displayName -> item, built lazily and invalidated on loadData. */
let itemByDisplayName: Map<string, ItemData> | null = null;

function rebuildIndexes(): void {
	const byId = new Map<number, ItemData>();
	// Reserve iteration once; keep first occurrence on duplicate ids.
	for (let i = 0; i < allItems.length; i++) {
		const it = allItems[i];
		if (!byId.has(it.id)) byId.set(it.id, it);
	}
	itemById = byId;
	// Invalidate lazy displayName index; rebuilt on next lookup.
	itemByDisplayName = null;
}

function ensureDisplayNameIndex(): Map<string, ItemData> {
	let m = itemByDisplayName;
	if (m) return m;
	m = new Map<string, ItemData>();
	for (let i = 0; i < allItems.length; i++) {
		const it = allItems[i];
		if (!m.has(it.displayName)) m.set(it.displayName, it);
	}
	itemByDisplayName = m;
	return m;
}

// ---- Loading with force-cache + inflight dedup ----

let loadDataInflight: Promise<void> | null = null;

async function fetchJson(url: string): Promise<unknown> {
	const res = await fetch(url, { cache: 'force-cache' } as RequestInit);
	if (!res.ok) {
		throw new Error(`${url} -> HTTP ${res.status}`);
	}
	return res.json();
}

function showInlineError(message: string): void {
	const grid = document.getElementById('itemsGrid');
	if (!grid) return;
	// Build with textContent (no HTML injection from status text).
	grid.innerHTML = '';
	const p = document.createElement('p');
	p.className = 'error';
	const t = translations[currentLang] ?? translations['en'] ?? translations[Object.keys(translations)[0]];
	p.textContent = `${t.error} (${message})`;
	grid.appendChild(p);
}

async function doLoadData(): Promise<void> {
	const [items, recipes, blockItemIdsArray] = await Promise.all([
		fetchJson('/data/items.json'),
		fetchJson('/data/recipes.json'),
		fetchJson('/data/block-item-ids.json'),
	]);
	allItems = items as ItemData[];
	allRecipes = recipes as Record<number, RecipeData[]>;
	blockItemIds = new Set(blockItemIdsArray as number[]);
	itemIds = new Set<number>();
	for (let i = 0; i < allItems.length; i++) itemIds.add(allItems[i].id);
	rebuildIndexes();
}

export async function loadData(): Promise<void> {
	if (loadDataInflight) return loadDataInflight;
	const p = doLoadData().catch((err: unknown) => {
		console.error('Failed to load data:', err);
		const message = err instanceof Error ? err.message : String(err);
		showInlineError(message);
	});
	loadDataInflight = p;
	try {
		await p;
	} finally {
		if (loadDataInflight === p) loadDataInflight = null;
	}
}

// ---- Lookups ----

export function isBlockItem(id: number): boolean {
	return blockItemIds.has(id);
}

export function getItemById(id: number): ItemData | undefined {
	const hit = itemById.get(id);
	if (hit !== undefined) return hit;
	// Fallback for tests / direct allItems mutation without loadData:
	// do a single scan and backfill the index.
	if (allItems.length > 0 && itemById.size === 0) {
		rebuildIndexes();
		return itemById.get(id);
	}
	return undefined;
}

export function getItemByDisplayName(name: string): ItemData | undefined {
	if (allItems.length > 0 && !itemByDisplayName && itemById.size === 0) {
		rebuildIndexes();
	}
	return ensureDisplayNameIndex().get(name);
}

export function getItemName(item: ItemData): string {
	return currentLang === 'es' && item.displayNameEs ? item.displayNameEs : item.displayName;
}

export function getRecipeForItem(itemId: number): RecipeData[] | null {
	return allRecipes[itemId] || null;
}

export function hasRecipe(itemId: number): boolean {
	return itemId in allRecipes && allRecipes[itemId].length > 0;
}

// ---- Texture fallbacks ----

// Precompiled patterns (avoid re-compiling regex per call).
const SIDE_SUFFIX_RE = /_side\.webp$/;
const WEBP_SUFFIX_RE = /\.webp$/;
const PLACEHOLDER_SVG =
	`data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22 viewBox=%220 0 48 48%22%3E%3Crect fill=%22%23666%22 width=%2248%22 height=%2248%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22 font-family=%22monospace%22%3E?%3C/text%3E%3C/svg%3E`;

export function getTextureFallbacks(item: ItemData): string[] {
	const baseUrl = item.textureUrl;
	const fallbacks: string[] = [baseUrl];
	const isBlock = isBlockItem(item.id);

	if (isBlock) {
		const isSidePrimary = baseUrl.endsWith('_side.webp');

		if (isSidePrimary) {
			// Primary is _side.webp (e.g., grass_block_side.webp)
			// Fallbacks: _top, _bottom, then base without suffix, then other variants
			const base = baseUrl.replace(SIDE_SUFFIX_RE, '');
			fallbacks.push(`${base}_top.webp`);
			fallbacks.push(`${base}_bottom.webp`);
			fallbacks.push(`${base}.webp`);
			// Add any other discovered variants
			if (item.textureVariants && item.textureVariants.length > 0) {
				for (const variant of item.textureVariants) {
					if (variant !== '_side' && variant !== '_top' && variant !== '_bottom') {
						fallbacks.push(`${base}${variant}.webp`);
					}
				}
			}
		} else {
			// Primary is base.webp (e.g., stone.webp)
			// Fallbacks: _side, _top, _bottom, then other discovered variants
			const base = baseUrl.replace(WEBP_SUFFIX_RE, '');
			fallbacks.push(`${base}_side.webp`);
			fallbacks.push(`${base}_top.webp`);
			fallbacks.push(`${base}_bottom.webp`);
			if (item.textureVariants && item.textureVariants.length > 0) {
				for (const variant of item.textureVariants) {
					if (variant !== '_side' && variant !== '_top' && variant !== '_bottom') {
						fallbacks.push(`${base}${variant}.webp`);
					}
				}
			}
		}
	} else {
		// Items: use pre-discovered variants from build time
		if (item.textureVariants && item.textureVariants.length > 0) {
			const base = baseUrl.replace(WEBP_SUFFIX_RE, '');
			for (const variant of item.textureVariants) {
				fallbacks.push(`${base}${variant}.webp`);
			}
		}
	}

	// Final fallback: placeholder SVG
	fallbacks.push(PLACEHOLDER_SVG);

	return fallbacks;
}
