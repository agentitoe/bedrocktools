/*
 * Seed Map — ui/legend.ts
 * Biome ids shown in the biome legend (fixed list shared by the engine's
 * inline map legend — index.ts buildLegend — and the sidebar legend that
 * controls.ts paints).
 *
 * Slugs map each id to the `biome_<slug>` translation key in
 * translations.ts. Ids are cubiomes enum BiomeID (biomes.h): 3 mountains,
 * 6 swamp, ... skipped on purpose to keep the strip readable (the MVP
 * legend lists the iconic biomes only).
 */

export const LEGEND_IDS = [0, 1, 2, 4, 5, 7, 9, 37, 44, 179] as const;

/** {0: 'ocean', ...}: legacy strip and UIBar rely on the same slugs. */
export const LEGEND_BIOME_KEYS: Readonly<Record<number, string>> = {
	0: 'ocean',
	1: 'plains',
	2: 'desert',
	4: 'forest',
	5: 'taiga',
	7: 'river',
	9: 'the_end',
	37: 'badlands',
	44: 'warm_ocean',
	179: 'snowy_slopes',
};

/** All legend entries must have a translation slug (fails fast at dev time). */
export function legendBiomeKey(id: number): string {
	const slug = LEGEND_BIOME_KEYS[id];
	if (slug === undefined) throw new Error('legend biome without translation slug: ' + id);
	return 'biome_' + slug;
}
