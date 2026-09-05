import type { AnyItem, CustomItemData, ImportedDataPack, ImportedPack, ItemData, RecipeState } from './types';

// ---- Mutable app state (shared across the tool's modules) ----
// Imports are read-only in ES modules, so every write goes through a setter
// below. This keeps the state mutations in one place and easy to trace.
//
// Performance: vanilla + custom items are also held in O(1) lookup Maps that
// are rebuilt by `setAllItems` / `setCustomItems` (and kept in sync by
// `registerCustomItem`), so `getItemById` / identifier resolution never scans
// linear arrays. Prefer the indexed getters over manual `Array.find`.

export let allItems: ItemData[] = [];
export let customItems: CustomItemData[] = [];
export let nextCustomId = -1;
export let importedPacks: ImportedPack[] = [];
export let importedDataPack: ImportedDataPack | null = null;
export let importedSourceName = ''; // original filename (e.g. "MyAddon.mcaddon")
export let currentLang = 'es';
export let recipes: RecipeState[] = [];
export let selectedIndex = 0;
export let packName = 'Custom Recipes';
export let identifierManuallyEdited = false;
export let platform: 'bedrock' | 'java' = 'bedrock';
export let javaPackFormat = 71; // target pack_format for Java data packs (default 1.21.5)

// ---- Indexed lookups (rebuilt on load / import) ----

let vanillaById = new Map<number, ItemData>();
let vanillaByName = new Map<string, ItemData>(); // lower bare name -> item
let customById = new Map<number, CustomItemData>();
let customByIdentifier = new Map<string, CustomItemData>(); // lower identifier -> item

function rebuildVanillaIndex(): void {
	const byId = new Map<number, ItemData>();
	const byName = new Map<string, ItemData>();
	for (const item of allItems) {
		if (!byId.has(item.id)) byId.set(item.id, item);
		const key = item.name.toLowerCase();
		if (!byName.has(key)) byName.set(key, item);
	}
	vanillaById = byId;
	vanillaByName = byName;
}

function rebuildCustomIndex(): void {
	const byId = new Map<number, CustomItemData>();
	const byIdent = new Map<string, CustomItemData>();
	for (const item of customItems) {
		if (!byId.has(item.id)) byId.set(item.id, item);
		const key = item.identifier.toLowerCase();
		if (!byIdent.has(key)) byIdent.set(key, item);
	}
	customById = byId;
	customByIdentifier = byIdent;
}

export function setAllItems(items: ItemData[]): void {
	allItems = items;
	rebuildVanillaIndex();
}

export function setCustomItems(items: CustomItemData[]): void {
	customItems = items;
	rebuildCustomIndex();
}

/** Append a custom item and keep the lookup Maps in sync (no full rebuild). */
export function registerCustomItem(item: CustomItemData): void {
	customItems.push(item);
	if (!customById.has(item.id)) customById.set(item.id, item);
	const key = item.identifier.toLowerCase();
	if (!customByIdentifier.has(key)) customByIdentifier.set(key, item);
}

/** O(1) vanilla lookup by numeric id. */
export function vanillaGetById(id: number): ItemData | undefined {
	return vanillaById.get(id);
}

/** O(1) vanilla lookup by bare name (case-insensitive). */
export function vanillaGetByName(name: string): ItemData | undefined {
	return vanillaByName.get(name.toLowerCase());
}

/** O(1) custom lookup by negative id. */
export function customGetById(id: number): CustomItemData | undefined {
	return customById.get(id);
}

/** O(1) custom lookup by full identifier (case-insensitive). */
export function customGetByIdentifier(identifier: string): CustomItemData | undefined {
	return customByIdentifier.get(identifier.toLowerCase());
}

/** O(1) lookup across vanilla + custom items by numeric id. */
export function indexedGetById(id: number): AnyItem | undefined {
	if (id >= 0) return vanillaById.get(id);
	return customById.get(id);
}

/** Allocate the next negative custom item id (used when importing addons). */
export function allocateCustomId(): number {
	return nextCustomId--;
}

export function resetCustomItems(): void {
	customItems = [];
	nextCustomId = -1;
	customById = new Map();
	customByIdentifier = new Map();
}

export function setImportedPacks(packs: ImportedPack[]): void { importedPacks = packs; }
export function setImportedDataPack(pack: ImportedDataPack | null): void { importedDataPack = pack; }
export function setImportedSourceName(name: string): void { importedSourceName = name; }

export function setRecipes(list: RecipeState[]): void { recipes = list; }
export function setSelectedIndex(index: number): void { selectedIndex = index; }
export function setPackName(name: string): void { packName = name; }
export function setIdentifierManuallyEdited(value: boolean): void { identifierManuallyEdited = value; }
export function setPlatform(value: 'bedrock' | 'java'): void { platform = value; }
export function setJavaPackFormat(value: number): void { javaPackFormat = value; }

export function setCurrentLang(lang: string): void {
	currentLang = lang;
}

// ---- Memoized selectors ----

/** Currently selected recipe (undefined when the list is empty). */
export function getSelectedRecipe(): RecipeState | undefined {
	if (recipes.length === 0) return undefined;
	return recipes[Math.max(0, Math.min(selectedIndex, recipes.length - 1))];
}

/** Reset the whole editor back to a blank state (no imports, one fresh recipe). */
export function resetEditorState(): void {
	importedPacks = [];
	importedDataPack = null;
	importedSourceName = '';
	customItems = [];
	nextCustomId = -1;
	customById = new Map();
	customByIdentifier = new Map();
	recipes = [];
	packName = 'Custom Recipes';
	selectedIndex = 0;
	identifierManuallyEdited = false;
}
