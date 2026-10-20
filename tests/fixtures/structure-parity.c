/*
 * Bedrock Tools — Seed Map structure parity fixture (tests/fixtures/).
 * Copyright (C) 2026 agentitoe — GPL-3.0 (see LICENSE at the repository root)
 *
 * PURPOSE (read tests/seed-map/structure-parity.test.ts for the runner):
 *   This program is the drift guard for the C->WASM pipeline and the
 *   catalog/worker transfer. It does NOT use ext_bindings.c: it calls the
 *   cubiomes public API (setupGenerator/applySeed/getStructurePos/
 *   isViableStructurePos + StrongholdIter) DIRECTLY and replicates the exact
 *   semantics documented in third_party/cubiomes-extensions/ext_bindings.c,
 *   dumping every (type, seed, version, region) -> positions tuple as one
 *   JSON line to stdout. The runner compiles this file into a THROWAWAY
 *   wasm module, plays the dump, and compares it position-by-position
 *   against BiomesBridge.fromModule(...) running the COMMITTED production
 *   module (public/wasm/biomes-java-gen.wasm, injected via the wasmBinary
 *   trick). If ext_bindings.c drifts from raw cubiomes, or the committed
 *   artifacts no longer match what ext_bindings.c claims, positions diverge
 *   and the parity test fails.
 *
 *   Output contract (one JSON object per line, printf is flushed per line):
 *     {"kind":"scan","seed":"<i64 as decimal string>","mc":<i>,"type":<i>,
 *      "rx":<i>,"rz":<i>,"w":<i>,"h":<i>,"pos":"x,z|x,z|...","n":<i>}
 *     {"kind":"strongholds","seed":"<i64 as decimal string>","mc":<i>,"pos":"x,z|...","n":<i>}
 *   The seed MUST be a quoted string: a bare JSON number passes through a
 *   JS double and loses the low 64-bit digits (the exact precision sin the
 *   ABI exists to prevent).
 *   `pos` is in ext_find_structures/ext_find_strongholds order (region walk:
 *   z rows then x columns; ring order for the stronghold iterator).
 *
 * Built by the runner (never committed): emcc --no-entry with
 * -sENVIRONMENT=node -sEXPORTED_FUNCTIONS=[_parity_dump]; cubiomes sources
 * compile straight from third_party/cubiomes (tests.c excluded, as in the
 * production build; loot/ is unrelated).
 */

#include <stdio.h>
#include <stdint.h>

#include "finders.h"
#include "generator.h"

/* cubiomes MC enum values matching the catalog notes (biomes.h). */
#define MC_RS  32 /* MC_1_21 (catalog "MC_NEWEST-ish" run, types 24/25 live) */
#define MC_OLD 22 /* MC_1_18 (the catalog's version-range floor)            */

/* Region-scanned catalog types for MC_RS: every catalog entry with
 * scanConfigFor() kind 'regions' (regionSize > 1), i.e. all region kinds
 * except Ruined_Portal_N (12, nether, out of catalog). */
static const int REGION_TYPES[] = {
	1,  /* Desert_Pyramid   */
	2,  /* Jungle_Temple    */
	3,  /* Swamp_Hut        */
	4,  /* Igloo            */
	5,  /* Village          */
	6,  /* Ocean_Ruin       */
	7,  /* Shipwreck        */
	8,  /* Monument         */
	9,  /* Mansion          */
	10, /* Outpost          */
	11, /* Ruined_Portal    */
	13, /* Ancient_City     */
	24, /* Trail_Ruins      */
	25, /* Trial_Chambers   */
};
#define N_REGION_TYPES (int)(sizeof(REGION_TYPES) / sizeof(REGION_TYPES[0]))

/* Chunk-scanned catalog types (kind 'chunks', regionSize 1): the fixture
 * sweeps a small chunk rectangle to keep runtime bounded. */
static const int CHUNK_TYPES[] = {
	14, /* Treasure  */
	15, /* Mineshaft */
	17, /* Geode     */
};
#define N_CHUNK_TYPES (int)(sizeof(CHUNK_TYPES) / sizeof(CHUNK_TYPES[0]))

/* The version-range probe below re-walks two region types at MC_OLD. */
static const int OLD_TYPES[] = { 1, 5 }; /* Desert_Pyramid, Village */
#define N_OLD_TYPES (int)(sizeof(OLD_TYPES) / sizeof(OLD_TYPES[0]))

/* Region rect walked for every region scan: 4x4 native regions around 0. */
#define REGION_RX (-2)
#define REGION_RZ (-2)
#define REGION_W  4
#define REGION_H  4

/* Chunk rectangle for the chunk kinds: 8x8 chunks around 0. */
#define CHUNK_CX (-4)
#define CHUNK_CZ (-4)
#define CHUNK_W  8
#define CHUNK_H  8

/* Strongholds: ext_find_strongholds stops at the cap; the production
 * scanner submits count=128, but 16 ring entries per seed keep the parity
 * run fast while covering the first rings exactly. */
#define STRONGHOLD_CAP 16

/* Parity seed set (decimal literals; the runner reassembles via BigInt). */
static const long long SEEDS[] = {
	0LL,
	12345LL,
	248164LL,
	-14214998LL,
	-2898418569583981710LL,
};
#define N_SEEDS (int)(sizeof(SEEDS) / sizeof(SEEDS[0]))

/*
 * Replicates ext_find_structures() EXACTLY: one per-region getStructurePos
 * (which consults getStructureConfig for (type, mc) internally; skipped
 * regions are misses, not errors), then isViableStructurePos with flags 0
 * (the catalog only ships flags 0 entries). Skips NOTHING else: positions
 * are emitted in region-walk order, z rows then x columns.
 */
static void dump_scan(long long seed, int mc, int type, int rx, int rz, int w, int h)
{
	Generator g;
	Pos pos;
	int x, z, n = 0, first = 1;

	setupGenerator(&g, mc, 0);
	applySeed(&g, DIM_OVERWORLD, (uint64_t)seed);

	printf("{\"kind\":\"scan\",\"seed\":\"%lld\",\"mc\":%d,\"type\":%d,\"rx\":%d,\"rz\":%d,\"w\":%d,\"h\":%d,\"pos\":\"",
		seed, mc, type, rx, rz, w, h);
	for (z = rz; z < rz + h; z++)
	{
		for (x = rx; x < rx + w; x++)
		{
			if (getStructurePos(type, mc, (uint64_t)seed, x, z, &pos) == 0)
				continue;
			if (isViableStructurePos(type, &g, pos.x, pos.z, 0) == 0)
				continue;
			printf(first ? "%d,%d" : "|%d,%d", pos.x, pos.z);
			n++;
			first = 0;
		}
	}
	printf("\",\"n\":%d}\n", n);
}

/*
 * Replicates ext_find_strongholds() EXACTLY: initFirstStronghold seeds the
 * ring iterator, then nextStronghold() resolves the CURRENT approximate
 * anchor into the accurate biome-checked sh.pos; the do/while and the
 * `remaining <= 0` break mirror the wrapper (vanilla rings end by
 * exhaustion, later emissions never depend on earlier ones).
 */
static void dump_strongholds(long long seed, int mc, int max_count)
{
	Generator g;
	StrongholdIter sh;
	int n = 0, remaining;

	setupGenerator(&g, mc, 0);
	applySeed(&g, DIM_OVERWORLD, (uint64_t)seed);

	printf("{\"kind\":\"strongholds\",\"seed\":\"%lld\",\"mc\":%d,\"pos\":\"", seed, mc);
	initFirstStronghold(&sh, mc, (uint64_t)seed);
	do
	{
		remaining = nextStronghold(&sh, &g);
		if (remaining <= 0)
			break;
		if (n < max_count)
		{
			printf(n == 0 ? "%d,%d" : "|%d,%d", sh.pos.x, sh.pos.z);
			n++;
		}
	} while (remaining > 0 && n < max_count);
	printf("\",\"n\":%d}\n", n);
}

/*
 * The exported dump driver. Note the dump is per-seed self-contained (each
 * scan re-seeds its LOCAL generator, mirroring ext_set_seed's setupGenerator
 * + applySeed path with flags = 0, dimension Overworld).
 */
static void dump_seed(long long seed)
{
	int t;

	for (t = 0; t < N_REGION_TYPES; t++)
		dump_scan(seed, MC_RS, REGION_TYPES[t], REGION_RX, REGION_RZ, REGION_W, REGION_H);
	for (t = 0; t < N_CHUNK_TYPES; t++)
		dump_scan(seed, MC_RS, CHUNK_TYPES[t], CHUNK_CX, CHUNK_CZ, CHUNK_W, CHUNK_H);
	dump_strongholds(seed, MC_RS, STRONGHOLD_CAP);
	for (t = 0; t < N_OLD_TYPES; t++)
		dump_scan(seed, MC_OLD, OLD_TYPES[t], REGION_RX, REGION_RZ, REGION_W, REGION_H);
}

int parity_dump(void)
{
	int s;

	for (s = 0; s < N_SEEDS; s++)
		dump_seed(SEEDS[s]);
	return 0;
}
