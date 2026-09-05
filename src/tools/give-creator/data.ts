// Static option data for the /give Command Generator.
// Values are Minecraft identifiers/terms, so they stay in English on every
// language of the site (same convention as the game itself).
//
// Performance notes:
// - `Set` views of the option lists give O(1) membership checks for validation.
// - The item catalogue index (`setCatalogue` / `getById` / `getByName`) avoids
//   linear `Array.find` scans in the picker and preview paths.

import type { ItemData } from './types';

export const ENCHANTMENTS = [
	'sharpness', 'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect',
	'looting', 'sweeping_edge', 'efficiency', 'silk_touch', 'fortune',
	'unbreaking', 'protection', 'fire_protection', 'blast_protection',
	'projectile_protection', 'feather_falling', 'respiration', 'aqua_affinity',
	'depth_strider', 'frost_walker', 'soul_speed', 'swift_sneak', 'thorns',
	'curse_of_binding', 'curse_of_vanishing', 'mending', 'loyalty', 'channeling',
	'riptide', 'impaling', 'power', 'punch', 'flame', 'infinity',
	'luck_of_the_sea', 'lure', 'multishot', 'quick_charge', 'piercing',
	'density', 'breach', 'wind_burst',
];

export const ATTRIBUTES = [
	'minecraft:max_health', 'minecraft:follow_range', 'minecraft:knockback_resistance',
	'minecraft:movement_speed', 'minecraft:attack_damage', 'minecraft:armor',
	'minecraft:armor_toughness', 'minecraft:attack_speed', 'minecraft:attack_knockback',
	'minecraft:luck', 'minecraft:block_interaction_range', 'minecraft:entity_interaction_range',
	'minecraft:step_height', 'minecraft:player.block_break_speed',
	'minecraft:player.mining_efficiency', 'minecraft:player.sneaking_speed',
	'minecraft:player.submerged_mining_speed', 'minecraft:player.sweeping_damage_ratio',
];

export const ATTRIBUTE_SLOTS = [
	'any', 'hand', 'mainhand', 'offhand', 'armor', 'head', 'chest', 'legs', 'feet', 'body',
];

export const ATTRIBUTE_OPERATIONS = [
	'add_value', 'add_multiplied_base', 'add_multiplied_total',
];

export const RARITIES = ['common', 'uncommon', 'rare', 'epic'];

export const MC_COLORS = [
	'black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple',
	'gold', 'gray', 'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple',
	'yellow', 'white',
];

export const DYE_COLORS = [
	'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
	'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];

export const TRIM_MATERIALS = [
	'quartz', 'iron', 'netherite', 'redstone', 'copper', 'gold', 'emerald',
	'diamond', 'lapis', 'amethyst', 'resin',
];

export const TRIM_PATTERNS = [
	'sentry', 'dune', 'coast', 'wild', 'ward', 'eye', 'vex', 'tide', 'snout',
	'rib', 'spire', 'wayfinder', 'shaper', 'silence', 'raiser', 'host', 'flow', 'bolt',
];

export const GOAT_HORN_INSTRUMENTS = [
	'ponder_goat_horn', 'sing_goat_horn', 'seek_goat_horn', 'feel_goat_horn',
	'admire_goat_horn', 'call_goat_horn', 'yearn_goat_horn', 'dream_goat_horn',
];

export const JUKEBOX_SONGS = [
	'13', 'cat', 'blocks', 'chirp', 'far', 'mall', 'mellohi', 'stal', 'strad',
	'ward', '11', 'wait', 'otherside', 'relic', 'five', 'pigstep', 'creator',
	'creator_music_box', 'precious', 'seeker',
];

export const BANNER_PATTERNS = [
	'base', 'square_bottom_left', 'square_bottom_right', 'square_top_left',
	'square_top_right', 'stripe_bottom', 'stripe_top', 'stripe_left', 'stripe_right',
	'stripe_center', 'stripe_middle', 'stripe_downright', 'stripe_downleft',
	'small_stripes', 'cross', 'straight_cross', 'diagonal_left', 'diagonal_up_right',
	'diagonal_up_left', 'diagonal_right', 'half_vertical', 'half_vertical_right',
	'half_horizontal', 'half_horizontal_bottom', 'triangle_top', 'triangle_bottom',
	'triangles_top', 'triangles_bottom', 'border', 'curly_border', 'brick',
	'gradient', 'gradient_up', 'creeper', 'skull', 'flower', 'mojang', 'globe', 'piglin',
];

export const EFFECTS = [
	'speed', 'slowness', 'haste', 'mining_fatigue', 'strength', 'instant_health',
	'instant_damage', 'jump_boost', 'nausea', 'regeneration', 'resistance',
	'fire_resistance', 'water_breathing', 'invisibility', 'blindness',
	'night_vision', 'hunger', 'weakness', 'poison', 'wither', 'health_boost',
	'absorption', 'saturation', 'glowing', 'levitation', 'luck', 'unluck',
	'slow_falling', 'conduit_power', 'dolphins_grace', 'bad_omen',
	'hero_of_the_village', 'darkness', 'trial_omen', 'raid_omen', 'wind_charged',
	'weaving', 'oozing', 'infested',
];

export const POTIONS = [
	'swiftness', 'long_swiftness', 'strong_swiftness', 'slowness', 'long_slowness',
	'strong_slowness', 'leaping', 'long_leaping', 'strong_leaping', 'healing',
	'strong_healing', 'harming', 'strong_harming', 'night_vision', 'long_night_vision',
	'invisibility', 'long_invisibility', 'fire_resistance', 'long_fire_resistance',
	'water_breathing', 'long_water_breathing', 'poison', 'long_poison', 'strong_poison',
	'regeneration', 'long_regeneration', 'strong_regeneration', 'strength',
	'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'turtle_master',
	'long_turtle_master', 'strong_turtle_master', 'luck', 'slow_falling',
	'long_slow_falling', 'wind_charged', 'weaving', 'oozing', 'infested',
];

export const FIREWORK_SHAPES = ['small_ball', 'large_ball', 'star', 'creeper', 'burst'];

export const CONSUMABLE_ANIMATIONS = [
	'none', 'eat', 'drink', 'block', 'bow', 'spear', 'crossbow', 'spyglass',
	'toot_horn', 'brush', 'bundle', 'trident',
];

export const PLAYER_SELECTORS = ['@p', '@a', '@r', '@s'];

/** Common blocks for the can_break / can_place_on suggestions. */
export const COMMON_BLOCKS = [
	'minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:sand',
	'minecraft:oak_planks', 'minecraft:cobblestone', 'minecraft:glass',
	'minecraft:obsidian', 'minecraft:bedrock', 'minecraft:chest',
];

/** Block tags often used with can_break / can_place_on (Java). */
export const COMMON_BLOCK_TAGS = [
	'#mineable/pickaxe', '#mineable/axe', '#mineable/shovel', '#mineable/hoe',
	'#minecraft:logs', '#minecraft:planks', '#minecraft:stone_bricks',
	'#minecraft:leaves', '#minecraft:wool',
];

/** Common blocks for the Bedrock can_destroy / can_place_on components. */
export const BEDROCK_COMMON_BLOCKS = [
	'stone', 'dirt', 'grass_block', 'sand', 'gravel', 'cobblestone',
	'oak_planks', 'oak_log', 'glass', 'obsidian', 'bedrock', 'chest',
	'crafting_table', 'furnace', 'wool', 'concrete', 'deepslate', 'tnt',
];

// ---- O(1) membership Sets (same contents as the lists above) ----

export const ENCHANTMENT_SET: ReadonlySet<string> = new Set(ENCHANTMENTS);
export const ATTRIBUTE_SET: ReadonlySet<string> = new Set(ATTRIBUTES);
export const ATTRIBUTE_SLOT_SET: ReadonlySet<string> = new Set(ATTRIBUTE_SLOTS);
export const ATTRIBUTE_OPERATION_SET: ReadonlySet<string> = new Set(ATTRIBUTE_OPERATIONS);
export const RARITY_SET: ReadonlySet<string> = new Set(RARITIES);
export const MC_COLOR_SET: ReadonlySet<string> = new Set(MC_COLORS);
export const DYE_COLOR_SET: ReadonlySet<string> = new Set(DYE_COLORS);
export const EFFECT_SET: ReadonlySet<string> = new Set(EFFECTS);
export const POTION_SET: ReadonlySet<string> = new Set(POTIONS);
export const FIREWORK_SHAPE_SET: ReadonlySet<string> = new Set(FIREWORK_SHAPES);
export const SELECTOR_SET: ReadonlySet<string> = new Set(PLAYER_SELECTORS);

// ---- Item catalogue index (replaces linear Array.find scans) ----

let catalogueById = new Map<number, ItemData>();
let catalogueByName = new Map<string, ItemData>();

/**
 * (Re)build the catalogue lookup Maps. Call once per `loadItems()` with the
 * full vanilla list plus once more when synthetic potion items are appended.
 * Lookups below are O(1); the source arrays stay untouched for iteration.
 */
export function setCatalogue(items: readonly ItemData[]): void {
	const byId = new Map<number, ItemData>();
	const byName = new Map<string, ItemData>();
	for (const item of items) {
		if (!byId.has(item.id)) byId.set(item.id, item);
		const key = item.name.toLowerCase();
		if (!byName.has(key)) byName.set(key, item);
	}
	catalogueById = byId;
	catalogueByName = byName;
}

/** O(1) lookup by numeric catalogue id. */
export function catalogueGetById(id: number): ItemData | undefined {
	return catalogueById.get(id);
}

/** O(1) lookup by bare item name (case-insensitive, no `minecraft:` prefix). */
export function catalogueGetByName(bareName: string): ItemData | undefined {
	return catalogueByName.get(bareName.toLowerCase());
}

/** Number of indexed catalogue entries (mainly useful for tests). */
export function catalogueSize(): number {
	return catalogueById.size;
}
