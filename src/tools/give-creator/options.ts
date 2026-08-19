// Option sections and fields for the /give Command Generator.
// Section/field labels reference i18n keys resolved at render time; the
// select options are Minecraft terms, so their labels stay English.

import type { FieldDef, FieldOption, SectionDef } from './types';
import {
	ATTRIBUTES, ATTRIBUTE_OPERATIONS, ATTRIBUTE_SLOTS, BANNER_PATTERNS,
	BEDROCK_COMMON_BLOCKS, CONSUMABLE_ANIMATIONS, DYE_COLORS, EFFECTS,
	ENCHANTMENTS, FIREWORK_SHAPES, GOAT_HORN_INSTRUMENTS, JUKEBOX_SONGS,
	MC_COLORS, POTIONS, RARITIES, TRIM_MATERIALS, TRIM_PATTERNS,
} from './data';

function opts(list: string[]): FieldOption[] {
	return list.map((value) => ({ value, label: value }));
}

const noneOption: FieldOption = { value: '', labelKey: 'optNone' };

// ---- Shared list-row sub-fields ----

const enchantmentRowFields: FieldDef[] = [
	{ key: 'enchantment', type: 'select', labelKey: 'rowEnchantment', options: opts(ENCHANTMENTS) },
	{ key: 'level', type: 'number', labelKey: 'rowLevel', min: 1, max: 255, step: 1, defaultValue: 1 },
];

const attributeRowFields: FieldDef[] = [
	{ key: 'attribute', type: 'select', labelKey: 'rowAttribute', options: opts(ATTRIBUTES) },
	{ key: 'slot', type: 'select', labelKey: 'rowSlot', options: opts(ATTRIBUTE_SLOTS) },
	{ key: 'operation', type: 'select', labelKey: 'rowOperation', options: opts(ATTRIBUTE_OPERATIONS) },
	{ key: 'amount', type: 'number', labelKey: 'rowAmount', step: 0.1, defaultValue: 1 },
	{ key: 'name', type: 'text', labelKey: 'rowId', rowPlaceholder: 'give:modifier_1' },
];

const effectRowFields: FieldDef[] = [
	{ key: 'effect', type: 'select', labelKey: 'rowEffect', options: opts(EFFECTS) },
	{ key: 'duration', type: 'number', labelKey: 'rowDuration', min: 1, max: 86400, defaultValue: 60 },
	{ key: 'amplifier', type: 'number', labelKey: 'rowAmplifier', min: 0, max: 255, defaultValue: 0 },
];

const stewRowFields: FieldDef[] = [
	{ key: 'effect', type: 'select', labelKey: 'rowEffect', options: opts(EFFECTS) },
	{ key: 'duration', type: 'number', labelKey: 'rowDuration', min: 1, max: 86400, defaultValue: 60 },
];

const explosionRowFields: FieldDef[] = [
	{ key: 'shape', type: 'select', labelKey: 'rowShape', options: opts(FIREWORK_SHAPES) },
	{ key: 'colors', type: 'text', labelKey: 'rowColors', rowPlaceholder: '#ff0000, #00ff00' },
	{ key: 'fade', type: 'text', labelKey: 'rowFade', rowPlaceholder: '#ffffff' },
	{ key: 'trail', type: 'checkbox', labelKey: 'rowTrail', defaultValue: false },
	{ key: 'twinkle', type: 'checkbox', labelKey: 'rowTwinkle', defaultValue: false },
];

const itemRowFields: FieldDef[] = [
	{ key: 'item', type: 'text', labelKey: 'rowItem', rowPlaceholder: 'minecraft:diamond' },
	{ key: 'count', type: 'number', labelKey: 'rowCount', min: 1, max: 64, defaultValue: 1 },
];

const bedrockBlockRowFields: FieldDef[] = [
	{ key: 'block', type: 'text', labelKey: 'rowBlock', rowPlaceholder: 'stone', datalist: BEDROCK_COMMON_BLOCKS },
];

// ---- Java sections ----

export const JAVA_SECTIONS: SectionDef[] = [
	{
		key: 'name', titleKey: 'secName', icon: '🏷️', fields: [
			{ key: 'customName', type: 'text', labelKey: 'fCustomName' },
			{ key: 'customNameColor', type: 'mcColor', labelKey: 'fCustomNameColor', options: opts(MC_COLORS) },
			{ key: 'customNameItalic', type: 'checkbox', labelKey: 'fCustomNameItalic', defaultValue: true },
			{ key: 'customNameBold', type: 'checkbox', labelKey: 'fCustomNameBold', defaultValue: false },
			{ key: 'lore', type: 'textarea', labelKey: 'fLore', helpKey: 'helpLore' },
		],
	},
	{
		key: 'ench', titleKey: 'secEnch', icon: '✨', fields: [
			{ key: 'enchantments', type: 'list', labelKey: 'fEnchantments', listFields: enchantmentRowFields },
			{ key: 'storedEnchantments', type: 'checkbox', labelKey: 'fStoredEnchantments', helpKey: 'helpStoredEnchantments', defaultValue: false },
		],
	},
	{
		key: 'durability', titleKey: 'secDurability', icon: '🔩', fields: [
			{ key: 'damage', type: 'number', labelKey: 'fDamage', helpKey: 'helpDamage', min: 0, max: 2147483647, step: 1 },
			{ key: 'maxDamage', type: 'number', labelKey: 'fMaxDamage', min: 1, max: 2147483647, step: 1 },
			{ key: 'unbreakable', type: 'checkbox', labelKey: 'fUnbreakable', defaultValue: false },
		],
	},
	{
		key: 'appearance', titleKey: 'secAppearance', icon: '🎨', fields: [
			{ key: 'rarity', type: 'select', labelKey: 'fRarity', options: [noneOption, ...opts(RARITIES)] },
			{ key: 'glint', type: 'select', labelKey: 'fGlint', options: [
				{ value: '', labelKey: 'optGlintDefault' },
				{ value: 'true', labelKey: 'optGlintOn' },
				{ value: 'false', labelKey: 'optGlintOff' },
			] },
			{ key: 'customModelData', type: 'number', labelKey: 'fCustomModelData', helpKey: 'helpCustomModelData', min: 0, max: 2147483647, step: 1 },
			{ key: 'itemModel', type: 'text', labelKey: 'fItemModel', placeholderKey: 'phItemModel' },
			{ key: 'dyedColor', type: 'color', labelKey: 'fDyedColor' },
			{ key: 'trimMaterial', type: 'select', labelKey: 'fTrimMaterial', options: [noneOption, ...opts(TRIM_MATERIALS)] },
			{ key: 'trimPattern', type: 'select', labelKey: 'fTrimPattern', options: [noneOption, ...opts(TRIM_PATTERNS)] },
			{ key: 'profileType', type: 'select', labelKey: 'fProfileType', options: [
				{ value: 'name', labelKey: 'optProfileName' },
				{ value: 'uuid', labelKey: 'optProfileUUID' },
			] },
			{ key: 'profileName', type: 'text', labelKey: 'fProfileName', placeholderKey: 'phProfileName' },
		],
	},
	{
		key: 'attributes', titleKey: 'secAttributes', icon: '⚔️', fields: [
			{ key: 'attributes', type: 'list', labelKey: 'fAttributes', listFields: attributeRowFields },
		],
	},
	{
		key: 'behavior', titleKey: 'secBehavior', icon: '🧩', fields: [
			{ key: 'canBreak', type: 'textarea', labelKey: 'fCanBreak', placeholderKey: 'phBlocks', helpKey: 'helpBlocksJava' },
			{ key: 'canPlaceOn', type: 'textarea', labelKey: 'fCanPlaceOn', placeholderKey: 'phBlocks', helpKey: 'helpBlocksJava' },
			{ key: 'lock', type: 'text', labelKey: 'fLock', placeholderKey: 'phLock', helpKey: 'helpLock' },
			{ key: 'fireResistant', type: 'checkbox', labelKey: 'fFireResistant', defaultValue: false },
			{ key: 'deathProtection', type: 'checkbox', labelKey: 'fDeathProtection', defaultValue: false },
			{ key: 'maxStackSize', type: 'number', labelKey: 'fMaxStackSize', min: 1, max: 99, step: 1 },
			{ key: 'repairCost', type: 'number', labelKey: 'fRepairCost', min: 0, max: 2147483647, step: 1 },
			{ key: 'hideTooltip', type: 'checkbox', labelKey: 'fHideTooltip', defaultValue: false },
			{ key: 'enchantable', type: 'number', labelKey: 'fEnchantable', helpKey: 'helpEnchantable', min: 1, max: 255, step: 1 },
		],
	},
	{
		key: 'special', titleKey: 'secSpecial', icon: '🧪', fields: [
			{ key: 'potion', type: 'select', labelKey: 'fPotion', options: [noneOption, ...opts(POTIONS), { value: 'custom', labelKey: 'optCustomEffects' }] },
			{ key: 'potionEffects', type: 'list', labelKey: 'fPotionEffects', helpKey: 'helpDurationSeconds', listFields: effectRowFields },
			{ key: 'stewEffects', type: 'list', labelKey: 'fStewEffects', helpKey: 'helpDurationSeconds', listFields: stewRowFields },
			{ key: 'fireworkFlight', type: 'number', labelKey: 'fFireworkFlight', min: 1, max: 127, step: 1 },
			{ key: 'fireworkExplosions', type: 'list', labelKey: 'fFireworkExplosions', helpKey: 'helpFireworkColors', listFields: explosionRowFields },
			{ key: 'fireworkStar', type: 'list', labelKey: 'fFireworkStar', helpKey: 'helpFireworkColors', listFields: explosionRowFields },
			{ key: 'bannerPatterns', type: 'list', labelKey: 'fBannerPatterns', listFields: [
				{ key: 'pattern', type: 'select', labelKey: 'rowPattern', options: opts(BANNER_PATTERNS) },
				{ key: 'color', type: 'select', labelKey: 'rowColor', options: opts(DYE_COLORS) },
			] },
			{ key: 'container', type: 'list', labelKey: 'fContainer', helpKey: 'helpContainer', listFields: [
				{ key: 'slot', type: 'number', labelKey: 'rowSlotNumber', min: 0, max: 255, step: 1, defaultValue: 0 },
				{ key: 'item', type: 'text', labelKey: 'rowItem', rowPlaceholder: 'minecraft:apple' },
				{ key: 'count', type: 'number', labelKey: 'rowCount', min: 1, max: 64, defaultValue: 1 },
			] },
			{ key: 'chargedProjectiles', type: 'list', labelKey: 'fChargedProjectiles', listFields: [
				{ key: 'item', type: 'text', labelKey: 'rowItem', rowPlaceholder: 'minecraft:spectral_arrow' },
			] },
			{ key: 'bundleContents', type: 'list', labelKey: 'fBundleContents', listFields: itemRowFields },
			{ key: 'bees', type: 'number', labelKey: 'fBees', helpKey: 'helpBees', min: 1, max: 16, step: 1 },
			{ key: 'beeName', type: 'text', labelKey: 'fBeeName' },
			{ key: 'blockState', type: 'textarea', labelKey: 'fBlockState', helpKey: 'helpBlockState', placeholderKey: 'phBlockState' },
			{ key: 'blockEntityData', type: 'textarea', labelKey: 'fBlockEntityData', placeholderKey: 'phBlockEntityData' },
			{ key: 'signText1', type: 'text', labelKey: 'fSignText', helpKey: 'helpSignText' },
			{ key: 'signText2', type: 'text', labelKey: 'fSignText' },
			{ key: 'signText3', type: 'text', labelKey: 'fSignText' },
			{ key: 'signText4', type: 'text', labelKey: 'fSignText' },
			{ key: 'signTextColor', type: 'select', labelKey: 'fSignTextColor', options: opts(MC_COLORS) },
			{ key: 'signTextGlow', type: 'checkbox', labelKey: 'fSignTextGlow', defaultValue: false },
			{ key: 'bookTitle', type: 'text', labelKey: 'fBookTitle', placeholderKey: 'phBookTitle' },
			{ key: 'bookAuthor', type: 'text', labelKey: 'fBookAuthor', placeholderKey: 'phBookAuthor' },
			{ key: 'bookPages', type: 'textarea', labelKey: 'fBookPages', placeholderKey: 'phBookPages' },
			{ key: 'bookWritablePages', type: 'textarea', labelKey: 'fBookWritablePages', placeholderKey: 'phBookWritablePages' },
			{ key: 'instrument', type: 'select', labelKey: 'fInstrument', options: [noneOption, ...opts(GOAT_HORN_INSTRUMENTS)] },
			{ key: 'jukebox', type: 'select', labelKey: 'fJukebox', options: [noneOption, ...opts(JUKEBOX_SONGS)] },
			{ key: 'mapId', type: 'number', labelKey: 'fMapId', min: 0, max: 2147483647, step: 1 },
			{ key: 'entityData', type: 'textarea', labelKey: 'fEntityData', placeholderKey: 'phEntityData' },
			{ key: 'potDecorations', type: 'list', labelKey: 'fPotDecorations', listFields: [
				{ key: 'item', type: 'text', labelKey: 'rowItem', rowPlaceholder: 'minecraft:angler_pottery_sherd' },
			] },
			{ key: 'foodNutrition', type: 'number', labelKey: 'fFoodNutrition', min: 1, max: 64, step: 1 },
			{ key: 'foodSaturation', type: 'number', labelKey: 'fFoodSaturation', min: 0, max: 100, step: 0.1 },
			{ key: 'foodCanAlwaysEat', type: 'checkbox', labelKey: 'fFoodCanAlwaysEat', defaultValue: false },
			{ key: 'consumableSeconds', type: 'number', labelKey: 'fConsumableSeconds', min: 0.1, max: 60, step: 0.1 },
			{ key: 'consumableAnimation', type: 'select', labelKey: 'fConsumableAnimation', options: opts(CONSUMABLE_ANIMATIONS) },
			{ key: 'useCooldown', type: 'number', labelKey: 'fUseCooldown', min: 0.1, max: 3600, step: 0.1 },
		],
	},
	{
		key: 'advanced', titleKey: 'secAdvanced', icon: '🧩', fields: [
			{ key: 'rawComponents', type: 'textarea', labelKey: 'fRawComponents', placeholderKey: 'phRawJava', helpKey: 'helpRawJava' },
		],
	},
];

// ---- Bedrock sections ----

export const BEDROCK_SECTIONS: SectionDef[] = [
	{
		key: 'blocks', titleKey: 'bedrockSecBlocks', icon: '🧱', fields: [
			{ key: 'bedrockCanDestroy', type: 'list', labelKey: 'fBedrockCanDestroy', helpKey: 'helpBedrockBlocks', listFields: bedrockBlockRowFields },
			{ key: 'bedrockCanPlaceOn', type: 'list', labelKey: 'fBedrockCanPlaceOn', helpKey: 'helpBedrockBlocks', listFields: bedrockBlockRowFields },
		],
	},
	{
		key: 'inventory', titleKey: 'bedrockSecInventory', icon: '🎒', fields: [
			{ key: 'bedrockItemLock', type: 'select', labelKey: 'fBedrockItemLock', options: [
				noneOption,
				{ value: 'lock_in_inventory', labelKey: 'optLockInventory' },
				{ value: 'lock_in_slot', labelKey: 'optLockSlot' },
			] },
			{ key: 'bedrockKeepOnDeath', type: 'checkbox', labelKey: 'fBedrockKeepOnDeath', defaultValue: false },
		],
	},
	{
		key: 'advanced', titleKey: 'bedrockSecAdvanced', icon: '🧩', fields: [
			{ key: 'bedrockRawComponents', type: 'textarea', labelKey: 'fBedrockRawComponents', placeholderKey: 'phRawBedrock', helpKey: 'helpRawBedrock' },
		],
	},
];

export function sectionsFor(platform: 'java' | 'bedrock'): SectionDef[] {
	return platform === 'java' ? JAVA_SECTIONS : BEDROCK_SECTIONS;
}
