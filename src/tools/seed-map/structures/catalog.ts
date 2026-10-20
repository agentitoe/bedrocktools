/*
 * Seed Map — structures/catalog.ts
 * Typed, versioned catalog of the Java Overworld structures the MVP scans
 * (all supported versions are 1.18+, i.e. cubiomes MC >= MC_1_18 = 22).
 *
 * Provenance rules (no invented numbers):
 *   - `enumId` is read off third_party/cubiomes/finders.h, enum StructureType
 *     (values fixed by that header; drift is caught by the real-WASM test
 *     tests/seed-map/wasm-structures.test.ts, which asserts the catalog
 *     against cubiomes' getStructureConfig through the committed module).
 *   - `regionSize` (chunks) matches finders.c getStructureConfig_default for
 *     the 1.18+ era; `granularity` = regionSize * 16 world blocks, the cell
 *     the scanner maps a viewport onto (structures/regions math).
 *   - `minMc` is the lower end of the version range the type is offered for;
 *     the MVP never pre-dates 1.18, legacy ranges stay with E5/E6.
 *
 * Out of catalog scope (per plan): End (cities/entrance/islands) and Nether
 * (fortress/bastion/nether fossil), plus cubiomes-only extras not listed in
 * the tool UI: Desert_Well, Abandoned_Camp (MC 26.3 shortcut structure).
 */

/** cubiomes enum StructureType — Stronghold (not region-based). */
export const STRUCTURE_STRONGHOLD = 27;

/** cubiomes enum StructureType — FEATURE_NUM (validation bound). */
export const STRUCTURE_FEATURE_NUM = 28;

/** Catalog-valid structure identifiers (UI-facing). */
export type StructureId =
	| 'village'
	| 'pillager_outpost'
	| 'mineshaft'
	| 'desert_pyramid'
	| 'jungle_temple'
	| 'swamp_hut'
	| 'igloo'
	| 'ocean_monument'
	| 'woodland_mansion'
	| 'ruined_portal'
	| 'shipwreck'
	| 'ocean_ruin'
	| 'buried_treasure'
	| 'ancient_city'
	| 'amethyst_geode'
	| 'trail_ruins'
	| 'trial_chambers'
	| 'stronghold';

/** How the scanner maps a viewport onto scan cells for this type. */
export type ScanKind = 'regions' | 'chunks' | 'special';

export type StructureEntry = {
	id: StructureId;
	/** cubiomes StructureType enum value (finders.h). */
	enumId: number;
	/** regionSize chunks at the 1.18+ era (finders.c config table). */
	regionSize: number;
	/** Scan cell size in world blocks = regionSize * 16 (16 for chunk-scan types). */
	granularity: number;
	/** Lower supported cubiomes MC value within the catalog (1.18+ MVP). */
	minMc: number;
	/** isViableStructurePos flags (village variant biome filter = biome id). */
	flags: number;
	/** Overlay marker rendering (E6 replaces glyph sprites with icons). */
	marker: { label: string; color: string };
	/** factual notes for tooltips/status (short, i18n keys live in E6). */
	notes?: string;
};

/*
 * cubiomes MC enum values used in this catalog (biomes.h, contiguous from
 * MC_UNDEF = 0): MC_1_18 = 22, MC_1_20 = 25, MC_1_21_1 = 26, MC_1_21 = 32,
 * MC_26_3 (MC_NEWEST) = 35.
 */
export const MC_1_18 = 22;
export const MC_1_20 = 25;
export const MC_1_21_1 = 26;
export const MC_NEWEST = 35;

const RAW: readonly (Omit<StructureEntry, 'granularity' | 'minMc' | 'notes'> & {
	minMc?: number;
	notes?: string;
})[] = [
	{ id: 'village', enumId: 5, regionSize: 34, flags: 0, marker: { label: 'VI', color: '#35b24a' } },
	{ id: 'pillager_outpost', enumId: 10, regionSize: 32, flags: 0, marker: { label: 'PO', color: '#8a512e' } },
	{ id: 'mineshaft', enumId: 15, regionSize: 1, flags: 0, marker: { label: 'MS', color: '#c28038' } },
	{ id: 'desert_pyramid', enumId: 1, regionSize: 32, flags: 0, marker: { label: 'DP', color: '#dcc25a' } },
	{ id: 'jungle_temple', enumId: 2, regionSize: 32, flags: 0, marker: { label: 'JT', color: '#4f9d3b' } },
	{ id: 'swamp_hut', enumId: 3, regionSize: 32, flags: 0, marker: { label: 'SW', color: '#8a5fb0' } },
	{ id: 'igloo', enumId: 4, regionSize: 32, flags: 0, marker: { label: 'IG', color: '#7ec8e3' } },
	{ id: 'ocean_monument', enumId: 8, regionSize: 32, flags: 0, marker: { label: 'OM', color: '#2fa898' } },
	{ id: 'woodland_mansion', enumId: 9, regionSize: 80, flags: 0, marker: { label: 'MA', color: '#9a4f3c' } },
	{ id: 'ruined_portal', enumId: 11, regionSize: 40, flags: 0, marker: { label: 'RP', color: '#c46a2f' } },
	{ id: 'shipwreck', enumId: 7, regionSize: 24, flags: 0, marker: { label: 'SX', color: '#7c6a55' } },
	{ id: 'ocean_ruin', enumId: 6, regionSize: 20, flags: 0, marker: { label: 'OR', color: '#5a8f9a' } },
	{ id: 'buried_treasure', enumId: 14, regionSize: 1, flags: 0, marker: { label: 'BT', color: '#e8d24a' } },
	{ id: 'ancient_city', enumId: 13, regionSize: 24, flags: 0, marker: { label: 'AC', color: '#4a6f8a' } },
	{ id: 'amethyst_geode', enumId: 17, regionSize: 1, flags: 0, marker: { label: 'GE', color: '#a86fd6' } },
	{ id: 'trail_ruins', enumId: 24, regionSize: 34, flags: 0, marker: { label: 'TR', color: '#b0a068' }, minMc: MC_1_20 },
	{ id: 'trial_chambers', enumId: 25, regionSize: 34, flags: 0, marker: { label: 'TC', color: '#cf8f3c' }, minMc: MC_1_21_1 },
	{ id: 'stronghold', enumId: STRUCTURE_STRONGHOLD, regionSize: 0, flags: 0, marker: { label: 'ST', color: '#5c67d1' } },
];

/*
 * Region math derives the granularities once at module load so the raw list
 * above stays a pure config table (regionSize chunks -> world-block cells).
 */
const ENTRIES: readonly StructureEntry[] = RAW.map((entry) => ({
	...entry,
	minMc: entry.minMc ?? MC_1_18,
	notes: entry.notes,
	granularity: entry.enumId === STRUCTURE_STRONGHOLD ? 0 : entry.regionSize * 16,
}));

/** Catalog sizes guard (test references the constant). */
export const CATALOG_SIZE = ENTRIES.length;

export const STRUCTURE_CATALOG: readonly StructureEntry[] = ENTRIES;

const BY_ID = new Map<string, StructureEntry>(STRUCTURE_CATALOG.map((e) => [e.id, e]));
const BY_ENUM = new Map<number, StructureEntry>(STRUCTURE_CATALOG.map((e) => [e.enumId, e]));

/** Throws on an unknown id — the UI layer should never construct ids. */
export function structureById(id: string): StructureEntry {
	const entry = BY_ID.get(id);
	if (!entry) throw new Error('unknown structure id: ' + id);
	return entry;
}

/** Null for out-of-catalog enum ids (nether/end features). */
export function structureByEnumId(enumId: number): StructureEntry | null {
	return BY_ENUM.get(enumId) ?? null;
}

/** All types supported by (>= max(minMc, mc)) — cheap client-side filter. */
export function structuresForMc(mc: number): StructureEntry[] {
	return STRUCTURE_CATALOG.filter((e) => e.minMc <= mc);
}

/**
 * Scan configuration for one structure type on one version.
 * Returns null when the type is out of range for `mc`, or for the stronghold
 * special path ('special' scan kind needs ext_find_strongholds, not regions).
 */
export function scanConfigFor(
	entry: StructureEntry,
	mc: number,
): { kind: ScanKind; granularity: number } | null {
	if (mc < entry.minMc) return null;
	if (entry.enumId === STRUCTURE_STRONGHOLD) return { kind: 'special', granularity: 0 };
	// Chunk-scan types (regionSize 1 <=> the region grid IS the chunk grid):
	// buried_treasure (salt+1% per chunk), amethyst_geode (population feature),
	// mineshaft (finders.c getMins... getMineshafts walks chunk coords).
	const kind: ScanKind = entry.regionSize === 1 ? 'chunks' : 'regions';
	return { kind, granularity: entry.granularity };
}
