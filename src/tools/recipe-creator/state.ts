import type { CustomItemData, ImportedDataPack, ImportedPack, ItemData, RecipeState } from './types';

// ---- Mutable app state (shared across the tool's modules) ----
// Imports are read-only in ES modules, so every write goes through a setter
// below. This keeps the state mutations in one place and easy to trace.

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

export function setAllItems(items: ItemData[]): void { allItems = items; }
export function setCustomItems(items: CustomItemData[]): void { customItems = items; }

/** Allocate the next negative custom item id (used when importing addons). */
export function allocateCustomId(): number {
	return nextCustomId--;
}

export function resetCustomItems(): void {
	customItems = [];
	nextCustomId = -1;
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

/** Reset the whole editor back to a blank state (no imports, one fresh recipe). */
export function resetEditorState(): void {
	importedPacks = [];
	importedDataPack = null;
	importedSourceName = '';
	customItems = [];
	nextCustomId = -1;
	recipes = [];
	packName = 'Custom Recipes';
	selectedIndex = 0;
	identifierManuallyEdited = false;
}
