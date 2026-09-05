// Mutable app state for the /give Command Generator.
// Every write goes through a setter so mutations stay traceable.
//
// The exported `state` object is kept for backwards compatibility, but new
// code should prefer the setters/selectors below: they validate input, clone
// arrays on reset (so `DEFAULT_VALUES` is never mutated through a shared
// reference), and expose memoized read selectors.

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

/** Deep-ish clone of the defaults (arrays are copied so resets never alias). */
function cloneDefaults(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_VALUES)) {
		const v = DEFAULT_VALUES[key];
		out[key] = Array.isArray(v) ? [...(v as unknown[])] : v;
	}
	return out;
}

export const state: GiveState = {
	platform: 'java',
	target: '@p',
	customTarget: '',
	itemId: 'minecraft:diamond_sword',
	count: 1,
	dataValue: 0,
	dataOverridden: false,
	values: cloneDefaults(),
};

export function setPlatform(platform: Platform): void {
	if (platform !== 'java' && platform !== 'bedrock') return;
	state.platform = platform;
}

export function setValue(key: string, value: unknown): void {
	if (typeof key !== 'string' || !key) return;
	// Guard against prototype-pollution keys coming from dynamic field names.
	if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
	state.values[key] = value;
}

/** Validated setters for the top-level scalar fields. */
export function setItemId(id: string): void {
	if (typeof id !== 'string') return;
	state.itemId = id;
}

export function setCount(n: number): void {
	state.count = Number.isFinite(n) ? n : 1;
}

export function setTarget(target: string, customTarget?: string): void {
	if (typeof target !== 'string' || !target) return;
	state.target = target;
	if (customTarget !== undefined && typeof customTarget === 'string') {
		state.customTarget = customTarget;
	}
}

export function setDataValue(n: number, overridden = true): void {
	state.dataValue = Number.isFinite(n) ? n : 0;
	state.dataOverridden = overridden;
}

/** Reset every option back to its default (keeps platform, item and target). */
export function resetValues(): void {
	state.values = cloneDefaults();
}

// ---- Memoized selectors (cheap reads for render functions) ----

let selValuesRef: Record<string, unknown> | null = null;
let selValuesKeys = '';

/** Read a single option value. */
export function getValue(key: string): unknown {
	return state.values[key];
}

/** Shallow snapshot of the values object (same ref while untouched). */
export function getValues(): Record<string, unknown> {
	return state.values;
}

/** Comma-joined sorted keys; lets renderers skip work when nothing changed. */
export function valuesFingerprint(): string {
	if (selValuesRef === state.values) return selValuesKeys;
	selValuesKeys = Object.keys(state.values).sort().join(',');
	selValuesRef = state.values;
	return selValuesKeys;
}

export function getPlatform(): Platform {
	return state.platform;
}

export function getItemId(): string {
	return state.itemId;
}

export function getCount(): number {
	return state.count;
}
