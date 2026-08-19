// Java → Bedrock item ID resolution for the /give Command Generator.
// Source: minecraft.wiki "Bedrock Edition data values" (Items/Items2/Blocks/
// Blocks2, April 2025 snapshot). After the 1.20.30 ID renames most names match
// Java; this module only lists the remaining differences and the items that
// do not exist in Bedrock at all.

export interface BedrockItemResolution {
	/** Bedrock item name (no namespace). */
	id: string;
	/** Data value the Bedrock item needs (beds, banners, potions, cauldrons...). */
	data?: number;
	/** False when the item does not exist in Bedrock. */
	available: boolean;
	/** True when the Bedrock name differs from the Java name. */
	renamed?: boolean;
}

/** Java item name → Bedrock item name (names that still differ). */
const RENAMES: Record<string, string> = {
	// Blocks
	snow: 'snow_layer',                                  // Java snow layer
	snow_block: 'snow',                                  // Bedrock "snow" is the full block
	spawner: 'mob_spawner',                              // Java 26.1 rename of monster_spawner
	monster_spawner: 'mob_spawner',
	end_stone_bricks: 'end_bricks',
	magma_block: 'magma',
	note_block: 'noteblock',
	nether_bricks: 'nether_brick',
	red_nether_bricks: 'red_nether_brick',
	bricks: 'brick_block',
	slime_block: 'slime',
	melon: 'melon_block',
	lily_pad: 'waterlily',
	dead_bush: 'deadbush',
	cobweb: 'web',
	nether_quartz_ore: 'quartz_ore',
	rooted_dirt: 'dirt_with_roots',
	flowering_azalea_leaves: 'azalea_leaves_flowered',
	small_dripleaf: 'small_dripleaf_block',
	jack_o_lantern: 'lit_pumpkin',
	terracotta: 'hardened_clay',
	dirt_path: 'grass_path',
	oak_button: 'wooden_button',
	oak_pressure_plate: 'wooden_pressure_plate',
	oak_door: 'wooden_door',
	oak_trapdoor: 'trapdoor',
	oak_fence_gate: 'fence_gate',
	powered_rail: 'golden_rail',
	cobblestone_stairs: 'stone_stairs',
	prismarine_brick_stairs: 'prismarine_bricks_stairs',
	end_stone_brick_stairs: 'end_brick_stairs',
	light_gray_glazed_terracotta: 'silver_glazed_terracotta',
	light: 'light_block',
	water_cauldron: 'cauldron',
	powder_snow_cauldron: 'cauldron',
	// Items
	item_frame: 'frame',
	glow_item_frame: 'glow_frame',
	map: 'empty_map',
	scute: 'turtle_scute',
	frogspawn: 'frog_spawn',
	tipped_arrow: 'arrow',
	zombified_piglin_spawn_egg: 'zombie_pigman_spawn_egg',
};

/** Fixed data values for items whose Bedrock variant needs one. */
const DATA_VALUES: Record<string, number> = {
	cauldron: 0,
	water_cauldron: 1,
	powder_snow_cauldron: 3,
	tipped_arrow: 6, // first tipped variant (Arrow of Night Vision); range is 6-47
};

/** Bedrock data value per dye color (beds, banners). Order = data value. */
const COLOR_ORDER = [
	'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
	'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];
const COLOR_DATA = new Map(COLOR_ORDER.map((c, i) => [c, i]));

/**
 * Java items that do not exist in Bedrock (computed against the April 2025
 * data values; mostly Java 26.1 "Copper Age" content Bedrock has not received).
 */
const UNAVAILABLE = new Set([
	'white_harness', 'orange_harness', 'magenta_harness', 'light_blue_harness',
	'yellow_harness', 'lime_harness', 'pink_harness', 'gray_harness',
	'light_gray_harness', 'cyan_harness', 'purple_harness', 'blue_harness',
	'brown_harness', 'green_harness', 'red_harness', 'black_harness',
	'furnace_minecart', 'test_block', 'test_instance_block',
	'copper_sword', 'copper_shovel', 'copper_pickaxe', 'copper_axe', 'copper_hoe',
	'copper_helmet', 'copper_chestplate', 'copper_leggings', 'copper_boots',
	'blue_egg', 'brown_egg',
	'bundle', 'white_bundle', 'orange_bundle', 'magenta_bundle', 'light_blue_bundle',
	'yellow_bundle', 'lime_bundle', 'pink_bundle', 'gray_bundle', 'light_gray_bundle',
	'cyan_bundle', 'purple_bundle', 'blue_bundle', 'brown_bundle', 'green_bundle',
	'red_bundle', 'black_bundle',
	'nautilus_spawn_egg', 'copper_golem_spawn_egg', 'camel_husk_spawn_egg',
	'parched_spawn_egg', 'zombie_nautilus_spawn_egg', 'happy_ghast_spawn_egg',
	'copper_horse_armor', 'netherite_horse_armor',
	'spectral_arrow',
	'wooden_spear', 'stone_spear', 'copper_spear', 'iron_spear', 'golden_spear',
	'diamond_spear', 'netherite_spear',
	'copper_nugget', 'knowledge_book', 'debug_stick',
	'music_disc_lava_chicken', 'music_disc_tears',
	'iron_nautilus_armor', 'golden_nautilus_armor', 'diamond_nautilus_armor',
	'netherite_nautilus_armor', 'copper_nautilus_armor',
	'glow_berries',
]);

/**
 * Bedrock potion data values (regular / extended / level II). Splash adds 64,
 * lingering adds 128. Source: minecraft.wiki Potion page (Bedrock metadata).
 */
const POTION_EFFECT_DATA: Record<string, [number, number, number]> = {
	night_vision: [5, 6, -1],
	invisibility: [7, 8, -1],
	leaping: [9, 10, 11],
	fire_resistance: [12, 13, -1],
	swiftness: [14, 15, 16],
	slowness: [17, 18, 42],
	water_breathing: [19, 20, -1],
	healing: [21, -1, 22],
	harming: [23, -1, 24],
	poison: [25, 26, 27],
	regeneration: [28, 29, 30],
	strength: [31, 32, 33],
	weakness: [34, 35, -1],
	decay: [36, -1, -1],
	turtle_master: [37, 38, 39],
	slow_falling: [40, 41, -1],
	wind_charged: [43, -1, -1],
	weaving: [44, -1, -1],
	oozing: [45, -1, -1],
	infested: [46, -1, -1],
};

const POTION_BASE_DATA: Record<string, number> = {
	water_bottle: 0,
	mundane_potion: 1,
	thick_potion: 3,
	awkward_potion: 4,
};

/** One selectable entry for the Bedrock potion / tipped-arrow dropdown. */
export interface BedrockPotionEntry {
	data: number;
	/** Potion-effect key (swiftness, night_vision...). */
	effect?: string;
	variant?: 'II' | 'extended';
	/** Base potion / arrow key (water, mundane, arrow, splashing...). */
	base?: string;
}

const POTION_BASES: { base: string; data: number }[] = [
	{ base: 'water', data: 0 },
	{ base: 'mundane', data: 1 },
	{ base: 'long_mundane', data: 2 },
	{ base: 'thick', data: 3 },
	{ base: 'awkward', data: 4 },
];

/**
 * Every valid Bedrock data value for a potion or tipped-arrow item, ordered by
 * data value. Arrow values are the potion values + 1 (source: minecraft.wiki
 * Potion / Tipped Arrow metadata tables).
 */
export function bedrockPotionDataList(kind: 'potion' | 'arrow'): BedrockPotionEntry[] {
	const out: BedrockPotionEntry[] = [];
	const offset = kind === 'arrow' ? 1 : 0;

	if (kind === 'arrow') {
		out.push({ data: 0, base: 'arrow' });
		out.push({ data: 1, base: 'splashing' });
		// The plain arrow / splashing entries replace the water base.
		for (const b of POTION_BASES) {
			if (b.base === 'water') continue;
			out.push({ data: b.data + 1, base: b.base });
		}
	} else {
		for (const b of POTION_BASES) out.push({ data: b.data, base: b.base });
	}

	for (const [effect, [regular, extended, strong]] of Object.entries(POTION_EFFECT_DATA)) {
		if (regular >= 0) out.push({ data: regular + offset, effect, variant: undefined });
		if (extended >= 0) out.push({ data: extended + offset, effect, variant: 'extended' });
		if (strong >= 0) out.push({ data: strong + offset, effect, variant: 'II' });
	}

	out.sort((a, b) => a.data - b.data);
	return out;
}

/**
 * Resolve the catalogue potion names (potion_of_swiftness_II,
 * splash_potion_of_healing, ...) to Bedrock potion data values.
 */
function resolvePotion(name: string): BedrockItemResolution | null {
	if (POTION_BASE_DATA[name] !== undefined) {
		return { id: 'potion', data: POTION_BASE_DATA[name], available: true, renamed: true };
	}
	const m = name.match(/^(?:(splash|lingering)_)?potion_of_([a-z_]+?)(?:_(II|extended))?$/);
	if (!m) return null;
	const [, form, effect, variant] = m;
	const data = POTION_EFFECT_DATA[effect];
	if (!data) return null;
	let value: number;
	if (variant === 'II') value = data[2];
	else if (variant === 'extended') value = data[1];
	else value = data[0];
	if (value < 0) return null;
	if (form === 'splash') value += 64;
	if (form === 'lingering') value += 128;
	return { id: form === 'splash' ? 'splash_potion' : form === 'lingering' ? 'lingering_potion' : 'potion', data: value, available: true, renamed: true };
}

/** Beds and banners are `bed` / `banner` + a color data value in Bedrock. */
function resolveColored(name: string): BedrockItemResolution | null {
	const bed = name.match(/^([a-z_]+)_bed$/);
	if (bed) {
		const data = COLOR_DATA.get(bed[1]);
		if (data !== undefined) return { id: 'bed', data, available: true, renamed: true };
	}
	const banner = name.match(/^([a-z_]+)_banner$/);
	if (banner) {
		const data = COLOR_DATA.get(banner[1]);
		if (data !== undefined) return { id: 'banner', data, available: true, renamed: true };
	}
	return null;
}

/**
 * Resolve a Java item ID (with or without the minecraft: prefix) to the item
 * Bedrock /give should receive. Unknown names pass through unchanged.
 */
export function resolveBedrockItem(javaId: string): BedrockItemResolution {
	const name = javaId.replace(/^minecraft:/, '').trim();
	if (!name) return { id: '', available: false };

	const potion = resolvePotion(name);
	if (potion) return potion;

	const colored = resolveColored(name);
	if (colored) return colored;

	const renamed = RENAMES[name];
	if (renamed) {
		return {
			id: renamed,
			data: DATA_VALUES[name],
			available: true,
			renamed: true,
		};
	}

	if (UNAVAILABLE.has(name)) return { id: name, available: false };

	// Same name in Bedrock; still apply a fixed data value when one exists.
	const data = DATA_VALUES[name];
	return data !== undefined ? { id: name, data, available: true } : { id: name, available: true };
}