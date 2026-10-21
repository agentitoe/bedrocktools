/*
 * Seed Map — ui/versions.ts
 * Minecraft version choices offered by the toolbar, keyed to the cubiomes
 * enum of the pinned submodule (third_party/cubiomes/biomes.h, enum MCVersion).
 *
 * Verified against the pin (values read off biomes.h lines 31-42):
 *   MC_1_18_2=22, MC_1_19_2=23, MC_1_19_4=24, MC_1_20_6=25, MC_1_21_1=26,
 *   MC_1_21_3=27, MC_1_21_4=28, MC_1_21_5=29, MC_1_21_6=30, MC_1_21_9=31,
 *   MC_1_21_11=32 (MC_1_21 alias).
 * The 26.x snapshot pair (33-35, MC_NEWEST = MC_26_3) stays OUT of the
 * select: 26.x is Java snapshot territory, the tool targets release
 * versions only. A renumber of the pin is caught by tests/seed-map.
 *
 * The list is artificial-complete per cubiomes support: every release entry
 * the pinned engine can generate biomes for is offered, ascending so the
 * <option> order reads oldest -> newest.
 */

export type McVersionChoice = {
	/** cubiomes enum MCVersion value (biomes.h). */
	enum: number;
	/** Player-facing version label (like the launcher writes it). */
	label: string;
};

/** Ascending, gap-free run of the 1.18.2..1.21.11 release versions. */
export const MC_VERSION_CHOICES: readonly McVersionChoice[] = [
	{ enum: 22, label: '1.18.2' },
	{ enum: 23, label: '1.19.2' },
	{ enum: 24, label: '1.19.4' },
	{ enum: 25, label: '1.20.6' },
	{ enum: 26, label: '1.21.1' },
	{ enum: 27, label: '1.21.3' },
	{ enum: 28, label: '1.21.4' },
	{ enum: 29, label: '1.21.5' },
	{ enum: 30, label: '1.21.6' },
	{ enum: 31, label: '1.21.9' },
	{ enum: 32, label: '1.21.11' },
];

/** Default choice: the last release version this pin supports (1.21.11). */
export const DEFAULT_MC_VERSION = 32;

/** Label of a version; unknown enum values degrade to the raw number. */
export function versionLabel(version: number): string {
	return MC_VERSION_CHOICES.find((choice) => choice.enum === version)?.label ?? String(version);
}
