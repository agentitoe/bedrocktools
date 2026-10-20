/*
 * Seed Map — biome-colors.ts
 * Biome byte → RGBA lookup table for the Canvas 2D renderer.
 *
 * Color source of record (task 3.1): the render layers shipped with the
 * cubiomes submodule — `third_party/cubiomes/util.c::initBiomeColors()`
 * (colors[256][3], lines ~445-558 of the pinned submodule). That table is
 * itself "largely inspired by the AMIDST program:
 * https://github.com/toolbox4minecraft/amidst/wiki/Biome-Color-Table, with
 * additional biomes for 1.18+ and subtle contrast changes" (comment in
 * util.c). Ids come from `third_party/cubiomes/biomes.h` (enum BiomeID);
 * mutated variants are base id + 128, and renamed aliases (snowy_plains,
 * windswept_hills, old_growth_*, ...) resolve to their base ids through the
 * enum aliases.
 *
 * The map layer stores ONE byte of biome id per cell; this module is the
 * single place that expands bytes into pixels, so the table is O(1) lookup
 * (Uint32Array indexed by byte) and endianness is solved exactly once.
 *
 * Themes: a single dark-friendly palette ships in the MVP. The Theme
 * parameter is part of the interface so a light/dark fork is a table swap,
 * not a renderer change (E6).
 */

import { TILE_INVALID_BIOME } from './workers/protocol';

export type PaletteTheme = 'light' | 'dark';

export type Palette = {
	theme: PaletteTheme;
	/**
	 * id (0..255) -> RGBA packed for direct Uint32Array writes into
	 * ImageData backing stores of the CURRENT platform (see packicolor).
	 * Index 255 (TILE_INVALID_BIOME) holds the neutral unknown color.
	 */
	lut: Uint32Array;
};

/** biome id (cubiomes enum) -> 0xRRGGBB, from initBiomeColors (util.c). */
const BIOME_COLORS: ReadonlyArray<readonly [number, number]> = [
	// 0-9
	[0 /*ocean*/, 0x000070],
	[1 /*plains*/, 0x8db360],
	[2 /*desert*/, 0xfa9418],
	[3 /*windswept_hills (mountains)*/, 0x606060],
	[4 /*forest*/, 0x056621],
	[5 /*taiga*/, 0x0b6a5f],
	[6 /*swamp*/, 0x07f9b2],
	[7 /*river*/, 0x0000ff],
	[8 /*nether_wastes*/, 0x572526],
	[9 /*the_end*/, 0x8080ff],
	// 10-19
	[10 /*frozen_ocean*/, 0x7070d6],
	[11 /*frozen_river*/, 0xa0a0ff],
	[12 /*snowy_plains (snowy_tundra)*/, 0xffffff],
	[13 /*snowy_mountains*/, 0xa0a0a0],
	[14 /*mushroom_fields*/, 0xff00ff],
	[15 /*mushroom_field_shore*/, 0xa000ff],
	[16 /*beach*/, 0xfade55],
	[17 /*desert_hills*/, 0xd25f12],
	[18 /*wooded_hills*/, 0x22551c],
	[19 /*taiga_hills*/, 0x163933],
	// 20-29
	[20 /*mountain_edge*/, 0x72789a],
	[21 /*jungle*/, 0x507b0a],
	[22 /*jungle_hills*/, 0x2c4205],
	[23 /*sparse_jungle (jungle_edge)*/, 0x60930f],
	[24 /*deep_ocean*/, 0x000030],
	[25 /*stony_shore (stone_shore)*/, 0xa2a284],
	[26 /*snowy_beach*/, 0xfaf0c0],
	[27 /*birch_forest*/, 0x307444],
	[28 /*birch_forest_hills*/, 0x1f5f32],
	[29 /*dark_forest*/, 0x40511a],
	// 30-39
	[30 /*snowy_taiga*/, 0x31554a],
	[31 /*snowy_taiga_hills*/, 0x243f36],
	[32 /*old_growth_pine_taiga (giant_tree_taiga)*/, 0x596651],
	[33 /*giant_tree_taiga_hills*/, 0x454f3e],
	[34 /*windswept_forest (wooded_mountains)*/, 0x5b7352],
	[35 /*savanna*/, 0xbdb25f],
	[36 /*savanna_plateau*/, 0xa79d64],
	[37 /*badlands*/, 0xd94515],
	[38 /*wooded_badlands (wooded_badlands_plateau)*/, 0xb09765],
	[39 /*badlands_plateau*/, 0xca8c65],
	// 40-50 (End + ocean variants, 1.13)
	[40 /*small_end_islands*/, 0x4b4bab],
	[41 /*end_midlands*/, 0xc9c959],
	[42 /*end_highlands*/, 0xb5b536],
	[43 /*end_barrens*/, 0x7070cc],
	[44 /*warm_ocean*/, 0x0000ac],
	[45 /*lukewarm_ocean*/, 0x000090],
	[46 /*cold_ocean*/, 0x202070],
	[47 /*deep_warm_ocean*/, 0x000050],
	[48 /*deep_lukewarm_ocean*/, 0x000040],
	[49 /*deep_cold_ocean*/, 0x202038],
	[50 /*deep_frozen_ocean*/, 0x404090],
	// 51-53 (Alpha 1.2 - Beta 1.7)
	[51 /*seasonal_forest*/, 0x2f560f],
	[52 /*rainforest*/, 0x47840e],
	[53 /*shrubland*/, 0x789e31],
	// 127
	[127 /*the_void*/, 0x000000],
	// mutated variants (base + 128)
	[129 /*sunflower_plains*/, 0xb5db88],
	[130 /*desert_lakes*/, 0xffbc40],
	[131 /*windswept_gravelly_hills (gravelly_mountains)*/, 0x888888],
	[132 /*flower_forest*/, 0x2d8e49],
	[133 /*taiga_mountains*/, 0x339287],
	[134 /*swamp_hills*/, 0x2fffda],
	[140 /*ice_spikes*/, 0xb4dcdc],
	[149 /*modified_jungle*/, 0x78a332],
	[151 /*modified_jungle_edge*/, 0x88bb37],
	[155 /*old_growth_birch_forest (tall_birch_forest)*/, 0x589c6c],
	[156 /*tall_birch_hills*/, 0x47875a],
	[157 /*dark_forest_hills*/, 0x687942],
	[158 /*snowy_taiga_mountains*/, 0x597d72],
	[160 /*old_growth_spruce_taiga (giant_spruce_taiga)*/, 0x818e79],
	[161 /*giant_spruce_taiga_hills*/, 0x6d7766],
	[162 /*modified_gravelly_mountains*/, 0x839b7a],
	[163 /*windswept_savanna (shattered_savanna)*/, 0xe5da87],
	[164 /*shattered_savanna_plateau*/, 0xcfc58c],
	[165 /*eroded_badlands*/, 0xff6d3d],
	[166 /*modified_wooded_badlands_plateau*/, 0xd8bf8d],
	[167 /*modified_badlands_plateau*/, 0xf2b48d],
	// 168-175 (1.14-1.16)
	[168 /*bamboo_jungle*/, 0x849500],
	[169 /*bamboo_jungle_hills*/, 0x5c6c04],
	[170 /*soul_sand_valley*/, 0x4d3a2e],
	[171 /*crimson_forest*/, 0x981a11],
	[172 /*warped_forest*/, 0x49907b],
	[173 /*basalt_deltas*/, 0x645f63],
	[174 /*dripstone_caves*/, 0x4e3012],
	[175 /*lush_caves*/, 0x283c00],
	// 177-186 (1.18-1.21 Winter Drop)
	[177 /*meadow*/, 0x60a445],
	[178 /*grove*/, 0x47726c],
	[179 /*snowy_slopes*/, 0xc4c4c4],
	[180 /*jagged_peaks*/, 0xdcdcc8],
	[181 /*frozen_peaks*/, 0xb0b3ce],
	[182 /*stony_peaks*/, 0x7b8f74],
	[183 /*deep_dark*/, 0x031f29],
	[184 /*mangrove_swamp*/, 0x2ccc8e],
	[185 /*cherry_grove*/, 0xff91c8],
	[186 /*pale_garden*/, 0x696d95],
	// 187-188 (26.x)
	[187 /*sulfur_caves*/, 0xc8d232],
	[188 /*dappled_forest*/, 0xeb9234],
];

/**
 * Unknown-slot colors: byte 0xff (TILE_INVALID_BIOME) renders as near-black
 * in both themes; it exists so a partially covered viewport never paints
 * garbage as a "real" biome. Legend entries (UI, E6) pick from here too.
 */
const UNKNOWN_DARK = 0x14141c;
const UNKNOWN_LIGHT = 0xe8e8e8;

/** Detects the byte order of Uint32Array-backed stores, once. */
let littleEndian: boolean | null = null;
function isLittleEndian(): boolean {
	if (littleEndian === null) {
		const probe = new ArrayBuffer(4);
		new Uint32Array(probe)[0] = 1;
		littleEndian = new Uint8Array(probe)[0] === 1;
	}
	return littleEndian;
}

/**
 * Packs RGBA so that writing the uint32 through the Uint32Array view of an
 * ImageData buffer lands r in byte 0, g in byte 1, b in byte 2, a in byte 3
 * — on the current platform, whatever its endianness is.
 */
export function packRgba(r: number, g: number, b: number, a: number): number {
	return isLittleEndian()
		? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
		: ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/**
 * Builds the palette. Every biome id WITHOUT an entry in initBiomeColors
 * (non-generated ids such as 0xff, developer biomes, unmapped holes) falls
 * back to the unknown color — a tile byte never reaches the renderer mapped
 * to stale numeric garbage.
 */
export function buildPalette(theme: PaletteTheme = 'dark'): Palette {
	const lut = new Uint32Array(256);
	const unknown = theme === 'dark' ? UNKNOWN_DARK : UNKNOWN_LIGHT;
	for (let id = 0; id < 256; id++) lut[id] = packRgba((unknown >> 16) & 0xff, (unknown >> 8) & 0xff, unknown & 0xff, 0xff);
	lut[TILE_INVALID_BIOME] = packRgba((unknown >> 16) & 0xff, (unknown >> 8) & 0xff, unknown & 0xff, 0xff);
	for (const [id, hex] of BIOME_COLORS) {
		lut[id] = packRgba((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff, 0xff);
	}
	return { theme, lut };
}

/** Shared palette for renderer consumers that don't need theme switching. */
export function defaultPalette(): Palette {
	return buildPalette('dark');
}

/** CSS hex color of a biome slot id, for DOM legends (E6 consumed). */
export function biomeCssColor(palette: Palette, id: number): string {
	const packed = palette.lut[id & 0xff];
	const r = isLittleEndian() ? packed & 0xff : (packed >>> 24) & 0xff;
	const g = isLittleEndian() ? (packed >>> 8) & 0xff : (packed >>> 16) & 0xff;
	const b = isLittleEndian() ? (packed >>> 16) & 0xff : (packed >>> 8) & 0xff;
	return '#' + to2(r) + to2(g) + to2(b);
}

const to2 = (v: number) => v.toString(16).padStart(2, '0');
