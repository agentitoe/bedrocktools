// Java → Bedrock item resolution for the /give Command Generator.
//
// Item NAMES come from the official Geyser mappings (public/data/geyser-item-
// map.json, fetched at tool startup from https://github.com/GeyserMC/mappings):
// every Bedrock name difference is listed there by bedrock_identifier.
//
// What Geyser cannot provide stays local:
//  • Availability — Geyser lists every Java item (falling back to the Java name
//    when Bedrock uses the same identifier), so it cannot say whether an item
//    is missing in Bedrock. UNAVAILABLE below is the Java-only item list.
//  • Data values — potion/tipped-arrow metadata and the cauldron states.

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

/** Shape of the generated Geyser map (see scripts/fetch-geyser-mappings.mjs). */
export interface GeyserItemMap {
	source?: string;
	commit?: string;
	renames: Record<string, string>;
}

let geyserMap: GeyserItemMap | null = null;

/**
 * Load the Geyser mappings (no argument: fetch from the site assets; with an
 * argument: inject a pre-parsed map, used by tests).
 */
export async function loadBedrockItemMap(map?: GeyserItemMap): Promise<void> {
	if (map) {
		geyserMap = map;
		return;
	}
	try {
		const res = await fetch('/data/geyser-item-map.json');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as GeyserItemMap;
		if (data && typeof data.renames === 'object') geyserMap = data;
	} catch (err) {
		// Without the map every item falls back to its Java name; the tool
		// still works for the (vast) majority of items that share names.
		console.error('Failed to load Geyser item map:', err);
	}
}

export function isBedrockItemMapLoaded(): boolean {
	return geyserMap !== null;
}

/**
 * Renames for Java names Geyser does not list yet (old Java names Geyser
 * dropped, and block states that exist as items only in Java). Geyser wins
 * whenever it knows the name; these entries are a bridge until it does.
 */
const EXTRA_RENAMES: Record<string, string> = {
	// Java 26.1 renamed monster_spawner → spawner; Geyser only tracks "spawner".
	monster_spawner: 'mob_spawner',
	// Java renamed turtle_scute → scute; Bedrock still uses the old name.
	scute: 'turtle_scute',
	// Leveled-cauldron block states (not items in Java, but accepted as input).
	water_cauldron: 'cauldron',
	powder_snow_cauldron: 'cauldron'
};

/**
 * Java items that do not exist in Bedrock (computed against the April 2025
 * data values; mostly Java 26.1 "Copper Age" content Bedrock has not received).
 * Note: Geyser cannot derive this list — it maps every Java item to *some*
 * Bedrock identifier.
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
	'glow_berries'
]);

/** Fixed data values for items whose Bedrock variant needs one. */
const DATA_VALUES: Record<string, number> = {
	cauldron: 0,
	water_cauldron: 1,
	powder_snow_cauldron: 3,
	tipped_arrow: 6 // first tipped variant (Arrow of Night Vision); range is 6-47
};

/** Bedrock data value per dye color (beds, banners). Order = data value. */
const COLOR_ORDER = [
	'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
	'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];
const COLOR_DATA = new Map(COLOR_ORDER.map((c, i) => [c, i]));

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
	infested: [46, -1, -1]
};

const POTION_BASE_DATA: Record<string, number> = {
	water_bottle: 0,
	mundane_potion: 1,
	thick_potion: 3,
	awkward_potion: 4
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
	{ base: 'awkward', data: 4 }
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

/** Bedrock name for a Java item: Geyser first, local bridge names second. */
function bedrockNameFor(name: string): { id: string; renamed: boolean } {
	const mapped = geyserMap?.renames?.[name];
	if (mapped) return { id: mapped, renamed: mapped !== name };
	const extra = EXTRA_RENAMES[name];
	if (extra) return { id: extra, renamed: extra !== name };
	return { id: name, renamed: false };
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

	if (UNAVAILABLE.has(name)) return { id: name, available: false };

	const { id, renamed } = bedrockNameFor(name);
	const data = DATA_VALUES[name];
	return data !== undefined
		? { id, data, available: true, ...(renamed ? { renamed } : {}) }
		: { id, available: true, ...(renamed ? { renamed } : {}) };
}
