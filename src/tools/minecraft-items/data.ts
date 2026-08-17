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

export async function loadData(): Promise<void> {
	try {
		const [itemsRes, recipesRes, blockItemIdsRes] = await Promise.all([
			fetch('/data/items.json'),
			fetch('/data/recipes.json'),
			fetch('/data/block-item-ids.json')
		]);
		if (!itemsRes.ok || !recipesRes.ok || !blockItemIdsRes.ok) {
			throw new Error(`Failed to load data: HTTP ${itemsRes.status}/${recipesRes.status}/${blockItemIdsRes.status}`);
		}
		allItems = await itemsRes.json();
		allRecipes = await recipesRes.json();
		const blockItemIdsArray = await blockItemIdsRes.json();
		blockItemIds = new Set(blockItemIdsArray);

		itemIds = new Set(allItems.map(i => i.id));
	} catch (err) {
		console.error('Failed to load data:', err);
		const t = translations[currentLang];
		const grid = document.getElementById('itemsGrid');
		if (grid) grid.innerHTML = `<p class="error">${t.error}</p>`;
	}
}

// ---- Lookups ----

export function isBlockItem(id: number): boolean {
	return blockItemIds.has(id);
}

export function getItemById(id: number): ItemData | undefined {
	return allItems.find(i => i.id === id);
}

let itemByDisplayName: Map<string, ItemData> | null = null;

export function getItemByDisplayName(name: string): ItemData | undefined {
	if (!itemByDisplayName) {
		itemByDisplayName = new Map<string, ItemData>();
		for (const item of allItems) itemByDisplayName.set(item.displayName, item);
	}
	return itemByDisplayName.get(name);
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

export function getTextureFallbacks(item: ItemData): string[] {
	const baseUrl = item.textureUrl;
	const fallbacks: string[] = [baseUrl];
	const isBlock = isBlockItem(item.id);

	if (isBlock) {
		const isSidePrimary = baseUrl.endsWith('_side.webp');

		if (isSidePrimary) {
			// Primary is _side.webp (e.g., grass_block_side.webp)
			// Fallbacks: _top, _bottom, then base without suffix, then other variants
			const base = baseUrl.replace(/_side\.webp$/, '');
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
			const base = baseUrl.replace(/\.webp$/, '');
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
			const base = baseUrl.replace(/\.webp$/, '');
			for (const variant of item.textureVariants) {
				fallbacks.push(`${base}${variant}.webp`);
			}
		}
	}

	// Final fallback: placeholder SVG
	fallbacks.push(`data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22 viewBox=%220 0 48 48%22%3E%3Crect fill=%22%23666%22 width=%2248%22 height=%2248%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22 font-family=%22monospace%22%3E?%3C/text%3E%3C/svg%3E`);

	return fallbacks;
}
