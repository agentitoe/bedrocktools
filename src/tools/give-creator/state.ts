// Mutable app state for the /give Command Generator.
// Every write goes through a setter so mutations stay traceable.

import type { GiveState, Platform } from './types';

export const DEFAULT_VALUES: Record<string, unknown> = {
	// Java — name & lore
	customName: '',
	customNameColor: 'white',
	customNameItalic: true,
	customNameBold: false,
	lore: '',
	// Java — enchantments
	enchantments: [],
	storedEnchantments: false,
	// Java — durability
	damage: '',
	maxDamage: '',
	unbreakable: false,
	// Java — appearance
	rarity: '',
	glint: '',
	customModelData: '',
	itemModel: '',
	dyedColor: '#813f3f',
	trimMaterial: '',
	trimPattern: '',
	profileType: 'name',
	profileName: '',
	// Java — attributes
	attributes: [],
	// Java — behavior
	canBreak: '',
	canPlaceOn: '',
	lock: '',
	fireResistant: false,
	deathProtection: false,
	maxStackSize: '',
	repairCost: '',
	hideTooltip: false,
	enchantable: '',
	// Java — special items
	potion: '',
	potionEffects: [],
	stewEffects: [],
	fireworkFlight: '',
	fireworkExplosions: [],
	fireworkStar: [],
	bannerPatterns: [],
	container: [],
	chargedProjectiles: [],
	bundleContents: [],
	bees: '',
	beeName: '',
	blockState: '',
	blockEntityData: '',
	signText1: '',
	signText2: '',
	signText3: '',
	signText4: '',
	signTextColor: 'black',
	signTextGlow: false,
	bookTitle: '',
	bookAuthor: '',
	bookPages: '',
	bookWritablePages: '',
	instrument: '',
	jukebox: '',
	mapId: '',
	entityData: '',
	potDecorations: [],
	foodNutrition: '',
	foodSaturation: '',
	foodCanAlwaysEat: false,
	consumableSeconds: '',
	consumableAnimation: 'eat',
	useCooldown: '',
	// Java — advanced
	rawComponents: '',
	// Bedrock
	bedrockCanDestroy: [],
	bedrockCanPlaceOn: [],
	bedrockItemLock: '',
	bedrockKeepOnDeath: false,
	bedrockRawComponents: '',
};

export const state: GiveState = {
	platform: 'java',
	target: '@p',
	customTarget: '',
	itemId: 'minecraft:diamond_sword',
	count: 1,
	dataValue: 0,
	dataOverridden: false,
	values: { ...DEFAULT_VALUES },
};

export function setPlatform(platform: Platform): void {
	state.platform = platform;
}

export function setValue(key: string, value: unknown): void {
	state.values[key] = value;
}

/** Reset every option back to its default (keeps platform, item and target). */
export function resetValues(): void {
	state.values = { ...DEFAULT_VALUES };
}
