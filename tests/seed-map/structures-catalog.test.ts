/*
 * Seed Map — structures/catalog.ts tests (pure config/table assertions).
 * The catalog is a provenance table over cubiomes (finders.h StructureType
 * enum + finders.c 1.18+-era region config): the enum values here are
 * HARDCODED against the pinned submodule header on purpose — a catalog
 * renumbering against an updated pin must fail loudly here.
 */

import { test, expect } from 'bun:test';
import {
	CATALOG_SIZE,
	STRUCTURE_CATALOG,
	STRUCTURE_STRONGHOLD,
	STRUCTURE_FEATURE_NUM,
	MC_1_18,
	MC_1_20,
	MC_1_21_1,
	structureById,
	structureByEnumId,
	structuresForMc,
	scanConfigFor,
	type StructureEntry,
} from '../../src/tools/seed-map/structures/catalog';

/** finders.h enum StructureType values (pinned submodule) for catalog types. */
const FINDERS_H_ENUM: Record<string, number> = {
	Desert_Pyramid: 1,
	Jungle_Temple: 2,
	Swamp_Hut: 3,
	Igloo: 4,
	Village: 5,
	Ocean_Ruin: 6,
	Shipwreck: 7,
	Monument: 8,
	Mansion: 9,
	Outpost: 10,
	Ruined_Portal: 11,
	Ancient_City: 13,
	Treasure: 14,
	Mineshaft: 15,
	Geode: 17,
	Trail_Ruins: 24,
	Trial_Chambers: 25,
	Stronghold: 27, // cubiomes constant, not region-based
	FEATURE_NUM: 28, // validation bound
};

/** catalog id -> finders.h enum name. */
const ID_TO_ENUM_NAME: Record<string, string> = {
	village: 'Village',
	pillager_outpost: 'Outpost',
	mineshaft: 'Mineshaft',
	desert_pyramid: 'Desert_Pyramid',
	jungle_temple: 'Jungle_Temple',
	swamp_hut: 'Swamp_Hut',
	igloo: 'Igloo',
	ocean_monument: 'Monument',
	woodland_mansion: 'Mansion',
	ruined_portal: 'Ruined_Portal',
	shipwreck: 'Shipwreck',
	ocean_ruin: 'Ocean_Ruin',
	buried_treasure: 'Treasure',
	ancient_city: 'Ancient_City',
	amethyst_geode: 'Geode',
	trail_ruins: 'Trail_Ruins',
	trial_chambers: 'Trial_Chambers',
	stronghold: 'Stronghold',
};

test('catalog size is exactly the 18 UI-facing types', () => {
	expect(CATALOG_SIZE).toBe(STRUCTURE_CATALOG.length);
	expect(STRUCTURE_CATALOG.length).toBe(18);
	expect(Object.keys(ID_TO_ENUM_NAME).length).toBe(18);
});

test('every enumId matches the real finders.h enum, uniques inside [0, FEATURE_NUM)', () => {
	const seen = new Set<number>();
	for (const entry of STRUCTURE_CATALOG) {
		const headerName = ID_TO_ENUM_NAME[entry.id];
		expect(headerName).toBeDefined();
		expect(entry.enumId).toBe(FINDERS_H_ENUM[headerName]);
		expect(FINDERS_H_ENUM[headerName]).toBeDefined();
		seen.add(entry.enumId);
	}
	expect(seen.size).toBe(18);
	for (const entry of STRUCTURE_CATALOG) {
		expect(entry.enumId).toBeGreaterThanOrEqual(0);
		expect(entry.enumId).toBeLessThan(STRUCTURE_FEATURE_NUM);
	}
});

test('region-scanned ids stay below Stronghold (27); stronghold carries the constant', () => {
	for (const entry of STRUCTURE_CATALOG) {
		if (entry.enumId !== STRUCTURE_STRONGHOLD) expect(entry.enumId).toBeLessThan(STRUCTURE_STRONGHOLD);
	}
	expect(structureById('stronghold').enumId).toBe(STRUCTURE_STRONGHOLD);
	expect(STRUCTURE_STRONGHOLD).toBe(FINDERS_H_ENUM.Stronghold);
});

test('derivative kinds: village->regions 544, chunk kinds->16, stronghold->special', () => {
	const mc = 32;
	const cfg = (id: string, version = mc) => {
		const entry = structureById(id);
		return scanConfigFor(entry, version);
	};

	// village: 34-chunk regions = 544 world blocks of granularity.
	expect(cfg('village')).toEqual({ kind: 'regions', granularity: 544 });
	expect(cfg('woodland_mansion')).toEqual({ kind: 'regions', granularity: 80 * 16 });
	expect(structureById('village').regionSize).toBe(34);

	// regionSize 1 == the region grid IS the chunk grid -> 'chunks', grain 16.
	for (const entry of [structureById('buried_treasure'), structureById('mineshaft'), structureById('amethyst_geode')]) {
		expect(entry.regionSize).toBe(1);
		const config = scanConfigFor(entry, mc)!;
		expect(config.kind).toBe('chunks');
		expect(config.granularity).toBe(16);
	}

	// stronghold: never a region scan; the ring walk owns it.
	expect(cfg('stronghold')).toEqual({ kind: 'special', granularity: 0 });
	expect(structureById('stronghold').regionSize).toBe(0);
	expect(structureById('stronghold').granularity).toBe(0);
});

test('version ranges: trail_ruins >= 1.20 (25), trial_chambers >= 1.21.1 (26), basics 1.18 (22)', () => {
	expect(structureById('trail_ruins').minMc).toBe(25);
	expect(structureById('trial_chambers').minMc).toBe(26);
	for (const entry of STRUCTURE_CATALOG) {
		if (entry.id !== 'trail_ruins' && entry.id !== 'trial_chambers') {
			expect(entry.minMc).toBe(MC_1_18);
		}
	}
	expect(MC_1_18).toBe(22);
	expect(MC_1_20).toBe(25);
	expect(MC_1_21_1).toBe(26);
});

test('scanConfigFor gates the version range and never invents configs', () => {
	const trail = structureById('trail_ruins');
	const trial = structureById('trial_chambers');
	expect(scanConfigFor(trail, 22)).toBeNull();
	expect(scanConfigFor(trail, 24)).toBeNull();
	expect(scanConfigFor(trail, 25)).toEqual({ kind: 'regions', granularity: 544 });
	expect(scanConfigFor(trial, 25)).toBeNull();
	expect(scanConfigFor(trial, 26)).toEqual({ kind: 'regions', granularity: 544 });

	// Baselines are reachable at the floor.
	const village = structureById('village');
	expect(scanConfigFor(village, 22)).toEqual({ kind: 'regions', granularity: 544 });
});

test('structuresForMc filters by minMc and offers everything at MC_1_21-ish versions', () => {
	const atFloor = structuresForMc(22);
	expect(atFloor.map((e) => e.id)).not.toContain('trail_ruins');
	expect(atFloor.map((e) => e.id)).not.toContain('trial_chambers');
	expect(atFloor).toHaveLength(16);

	const at32 = structuresForMc(32);
	expect(at32).toHaveLength(18);

	// Ordering breaks nothing: every entry above the floor maps to a region kind again.
	const strongholdsSpecial = structuresForMc(35).map((e) => scanConfigFor(e, 35)?.kind);
	expect(strongholdsSpecial.filter((k) => k === 'special')).toEqual(['special']);
});

test('structureById / structureByEnumId round-trip and reject unknown inputs', () => {
	for (const entry of STRUCTURE_CATALOG) {
		expect(structureById(entry.id)).toBe(entry);
		expect(structureByEnumId(entry.enumId)).toBe(entry);
	}
	expect(() => structureById('not-a-structure')).toThrowError(); // throws by construction
	expect(structureByEnumId(12)).toBeNull(); // Ruined_Portal_N: nether, out of catalog
	expect(structureByEnumId(16)).toBeNull(); // Desert_Well: cubiomes-only extra
	expect(structureByEnumId(28)).toBeNull(); // FEATURE_NUM itself
	expect(structureByEnumId(-1)).toBeNull();
});

test('labels and colors are non-empty for every entry (overlay marker contract)', () => {
	for (const entry of STRUCTURE_CATALOG) {
		const marker: StructureEntry['marker'] = entry.marker;
		expect(marker.label.length).toBeGreaterThan(0);
		expect(marker.label).toBe(marker.label.trim());
		expect(marker.color).toMatch(/^#[0-9a-fA-F]{6}$/);
	}
});
