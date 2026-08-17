// Shared types for the Items & Blocks browser.

export interface ItemData {
	id: number;
	name: string;
	displayName: string;
	displayNameEs?: string; // localized Spanish display name
	stackSize: number;
	textureUrl: string;
	textureVariants?: string[]; // e.g. ['_0', '_1', '_eating_0']
	renderAs?: 'block' | 'item' | 'layered'; // how the inventory icon is rendered
	modelName?: string;           // block model name when renderAs === 'block'
	layers?: { url: string; tint?: string }[]; // layered flat items (potions, arrows)
}

export type RecipeType =
	| 'crafting_shaped'
	| 'crafting_shapeless'
	| 'smelting'
	| 'blasting'
	| 'smoking'
	| 'campfire_cooking'
	| 'stonecutting'
	| 'smithing'
	| 'brewing';

export interface RecipeData {
	type: RecipeType;
	// crafting_shaped
	inShape?: Array<Array<number | null>>;
	// crafting_shapeless
	ingredients?: Array<number>;
	// smelting / blasting / smoking / campfire_cooking / stonecutting / brewing
	ingredient?: number;
	// smithing
	template?: number | null;
	base?: number;
	addition?: number | null;
	// brewing
	baseLabel?: string;
	resultLabel?: string;
	steps?: Array<{ ingredient: number; baseLabel: string; resultLabel: string }>;
	result?: { id: number; count: number };
	experience?: number;
	cookingtime?: number;
}

import type { I18nDict } from '../../shared/ui';

/** One language entry of the translation table (allows dynamic key access). */
export interface ItemTranslations extends I18nDict {
	[key: string]: string;
}

export type TranslationTable = Record<string, ItemTranslations>;
