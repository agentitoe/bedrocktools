// Shared types for the /give Command Generator tool.

export type Platform = 'java' | 'bedrock';

/** Every field type the generic option renderer understands. */
export type FieldType =
	| 'text'      // single-line text
	| 'number'    // numeric input
	| 'checkbox'  // boolean toggle
	| 'select'    // <select> with options
	| 'color'     // HTML color picker (hex #rrggbb)
	| 'mcColor'   // Minecraft named color (select)
	| 'textarea'  // multi-line text
	| 'list';     // repeatable rows of sub-fields

export interface FieldOption {
	value: string;
	/** Literal label (Minecraft terms stay English). */
	label?: string;
	/** i18n key for the label (resolved at render time). */
	labelKey?: string;
}

export interface FieldDef {
	key: string;
	type: FieldType;
	labelKey: string;
	placeholderKey?: string;
	helpKey?: string;
	options?: FieldOption[];
	min?: number;
	max?: number;
	step?: number;
	defaultValue?: unknown;
	/** Sub-fields for `type: 'list'` rows. */
	listFields?: FieldDef[];
	/** Placeholder text for list row inputs (not i18n, usually an example). */
	rowPlaceholder?: string;
	/** Autocomplete suggestions for text inputs (rendered as a <datalist>). */
	datalist?: string[];
}

export interface SectionDef {
	key: string;
	titleKey: string;
	icon: string;
	fields: FieldDef[];
}

/** The mutable form state. `values` holds every option keyed by field key. */
export interface GiveState {
	platform: Platform;
	target: string;      // "@p" | "@a" | "@r" | "@s" | "name"
	customTarget: string; // used when target === 'name'
	itemId: string;      // e.g. "minecraft:diamond_sword"
	count: number;
	dataValue: number;   // Bedrock data (aux) argument
	dataOverridden: boolean; // true once the user edits the data value manually
	values: Record<string, unknown>;
}

/** Result of building a command from the current state. */
export interface BuildResult {
	command: string;
	error?: string;
}

/** A single entry from /data/items.json (matches the full shape used by the Items & Blocks tool). */
export interface ItemData {
	id: number;
	name: string;
	displayName: string;
	displayNameEs?: string;
	stackSize?: number;
	textureUrl: string;
	textureVariants?: string[];
	renderAs?: 'block' | 'item' | 'layered';
	modelName?: string;
	layers?: { url: string; tint?: string }[];
}

import type { I18nDict } from '../../shared/ui';

export interface GiveTranslations extends I18nDict {
	[key: string]: string; // Allow dynamic key access
}

export type TranslationTable = Record<string, GiveTranslations>;
