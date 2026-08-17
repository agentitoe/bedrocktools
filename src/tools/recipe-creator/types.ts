// Shared types for the Recipe Creator tool.

export interface ItemData {
	id: number;
	name: string;
	displayName: string;
	displayNameEs?: string;
	stackSize: number;
	textureUrl: string;
	renderAs?: 'block' | 'item' | 'layered';
	modelName?: string;
}

/** A custom item/block extracted from an imported addon. Negative ids (never collide with vanilla). */
export interface CustomItemData {
	id: number;             // negative
	identifier: string;     // e.g. "mypack:custom_sword"
	displayName: string;
	displayNameEs?: string;
	textureUrl?: string;    // blob URL to the extracted texture (if any)
	kind: 'item' | 'block';
}

export type AnyItem = ItemData | CustomItemData;

export type RecipeType = 'shaped' | 'shapeless' | 'furnace';

/** A pack extracted from an imported .mcpack / .mcaddon. */
export interface ImportedPack {
	type: 'behavior' | 'resource';
	manifest: any;
	files: Map<string, Uint8Array>; // relative path -> bytes
	archivePath: string;           // path inside the outer archive ('' when the pack IS the imported file)
	recipeFiles: string[];         // original recipe file paths (removed/replaced on export)
}

/** A Java data pack extracted from an imported .zip. */
export interface ImportedDataPack {
	mcmeta: any;                   // parsed pack.mcmeta
	files: Map<string, Uint8Array>; // relative path -> bytes
	recipeFiles: string[];         // original data/*/recipe/*.json paths
}

export const FURNACE_TAGS = ['furnace', 'blast_furnace', 'smoker', 'campfire'] as const;
export type FurnaceTag = (typeof FURNACE_TAGS)[number];

export interface RecipeState {
	id: string;
	type: RecipeType;
	identifier: string;
	grid: (number | null)[];   // shaped: 9 slots
	ingredients: number[];     // shapeless: item ids (max 9)
	input: number | null;      // furnace input
	output: number | null;     // furnace output
	furnaceTag: FurnaceTag;
	resultId: number | null;   // shaped/shapeless result
	resultCount: number;
	sourceFile?: string;       // original path in the imported pack (e.g. "recipes/foo.json")
	sourcePackIndex?: number;  // index into importedPacks for round-tripping
	preserveIdentifier?: boolean; // don't auto-rename identifier when the result changes (imported recipes)
}

import type { I18nDict } from '../../shared/ui';

export interface RecipeTranslations extends I18nDict {
	[key: string]: string; // Allow dynamic key access
}

export type TranslationTable = Record<string, RecipeTranslations>;
