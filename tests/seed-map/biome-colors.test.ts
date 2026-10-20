/*
 * Seed Map — biome palette + TileKey/geometry tests (static parts of E3).
 * No DOM: colors are plain packing math, keys are pure string functions.
 */

import { test, expect } from 'bun:test';
import {
	biomeCssColor,
	defaultPalette,
	packRgba,
} from '../../src/tools/seed-map/biome-colors';
import {
	lodScaleFor,
	parseTileKey,
	tileKeyToString,
	worldToTileCoord,
	TILE_SIZE,
	WORLD_LIMIT,
} from '../../src/tools/seed-map/types';
import { seedToHex, splitSeed } from '../../src/tools/seed-map/wasm/seed64';

// ------------------------------------------------------------ biome colors

const pal = defaultPalette();

/** Reads the r/g/b bytes a renderer would see through the Uint32Array view. */
function colorBytes(id: number): [number, number, number, number] {
	const packed = pal.lut[id & 0xff];
	const le = packRgba(1, 2, 3, 4) === (((4 << 24) | (3 << 16) | (2 << 8) | 1) >>> 0);
	return le
		? [packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff, (packed >>> 24) & 0xff]
		: [(packed >>> 24) & 0xff, (packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff];
}

test('table covers the main biomes with the sourced colors (util.c initBiomeColors)', () => {
	expect(colorBytes(0 /*ocean*/).slice(0, 3)).toEqual([0x00, 0x00, 0x70]);
	expect(colorBytes(1 /*plains*/).slice(0, 3)).toEqual([0x8d, 0xb3, 0x60]);
	expect(colorBytes(4 /*forest*/).slice(0, 3)).toEqual([0x05, 0x66, 0x21]);
	expect(colorBytes(2 /*desert*/).slice(0, 3)).toEqual([0xfa, 0x94, 0x18]);
	expect(colorBytes(37 /*badlands*/).slice(0, 3)).toEqual([0xd9, 0x45, 0x15]);
	expect(colorBytes(179 /*snowy_slopes*/).slice(0, 3)).toEqual([0xc4, 0xc4, 0xc4]);
	expect(colorBytes(188 /*dappled_forest, 26.x*/).slice(0, 3)).toEqual([0xeb, 0x92, 0x34]);
});

test('every palette byte is fully opaque', () => {
	for (let id = 0; id < 256; id++) {
		expect(colorBytes(id)[3]).toBe(0xff);
	}
	// Coverage (plan criterion): every generated-family id carries a color
	// from the source table; holes fall back to the deterministic unknown.
	expect(colorBytes(12 /*snowy_plains*/).slice(0, 3)).toEqual([0xff, 0xff, 0xff]);
	expect(colorBytes(127 /*the_void*/).slice(0, 3)).toEqual([0, 0, 0]);
	expect(colorBytes(174)/*dripstone_caves*/.slice(0, 3)).toEqual([0x4e, 0x30, 0x12]);
});

test('slot 0xff (TILE_INVALID_BIOME) has a dedicated, distinct neutral color', () => {
	const invalid = colorBytes(0xff);
	expect(invalid[3]).toBe(0xff);
	const known = colorBytes(0);
	expect(invalid.slice(0, 3)).not.toEqual(known.slice(0, 3));
});

test('biomeCssColor round-trips through the palette (legend use)', () => {
	expect(biomeCssColor(pal, 7 /*river*/)).toMatch(/^#[0-9a-f]{6}$/);
	// river is pure blue in the source table.
	const css = biomeCssColor(pal, 7);
	expect(css.endsWith('0000ff')).toBe(true);
});

// -------------------------------------------------------------- TileKey

test('TileKey canonicalizes and round-trips for huge seeds', () => {
	const seed = -2898418569583981710n; // > 2^53 in magnitude, negative
	const key = { seed: splitSeed(seed), version: 32, dim: 0, scale: 4, tx: -3, tz: 4096 };
	const str = tileKeyToString(key);
	expect(str.split('|')[0]).toBe(seedToHex(seed));
	const back = parseTileKey(str);
	expect(back.version).toBe(32);
	expect(back.tx).toBe(-3);
	expect(tiKeySame(back, key)).toBe(true);
});

function tiKeySame(a: { seed: { hi: number; lo: number }; tx: number; tz: number; scale: number; version: number; dim: number },
	b: typeof a): boolean {
	return a.seed.hi === b.seed.hi && a.seed.lo === b.seed.lo && a.scale === b.scale
		&& a.tx === b.tx && a.tz === b.tz && a.version === b.version && a.dim === b.dim;
}

test('keys cannot collide between seeds differing above 2^53', () => {
	const a = { seed: splitSeed((2n ** 53n) + 1n), version: 32, dim: 0, scale: 4, tx: 0, tz: 0 };
	const b = { seed: splitSeed((2n ** 53n) + 2n), version: 32, dim: 0, scale: 4, tx: 0, tz: 0 };
	expect(tileKeyToString(a)).not.toBe(tileKeyToString(b));
});

// -------------------------------------------------------------- geometry

test('minecraft chunk/block conversions respect the tile grid floor', () => {
	expect(worldToTileCoord(-1, -1, 4)).toEqual({ tx: -1, tz: -1 });
	expect(worldToTileCoord(TILE_SIZE * 4, 0, 4)).toEqual({ tx: 1, tz: 0 });
	expect(worldToTileCoord(-1, 0, 1)).toEqual({ tx: -1, tz: 0 });
});

test('LOD thresholds match the documented table', () => {
	expect(lodScaleFor(4096)).toBe(256);
	expect(lodScaleFor(32)).toBe(256);
	expect(lodScaleFor(31.9)).toBe(4);
	expect(lodScaleFor(4)).toBe(4);
	expect(lodScaleFor(1.6)).toBe(4);
	expect(lodScaleFor(1.59)).toBe(1);
	expect(lodScaleFor(1)).toBe(1);
});

test('world limits are sane', () => {
	expect(WORLD_LIMIT).toBe(30_000_000);
});
