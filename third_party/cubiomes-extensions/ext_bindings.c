/*
 * Bedrock Tools — cubiomes-extensions/ext_bindings.c
 * Copyright (C) 2026 agentitoe — GPL-3.0 (see LICENSE at the repository root)
 *
 * Implementation contract (do not break without updating ext_bindings.h and
 * src/tools/seed-map/wasm/):
 *   - One static Generator and one monotonically growing int cache per WASM
 *     module instance (one instance per Web Worker). No locks: single-threaded
 *     by design (the WASM build must not be compiled with -pthread/SAB,
 *     see scripts/build-wasm.mjs).
 *   - Seeds arrive as {hi, lo} i32 pairs and are reassembled exactly; the
 *     64-bit value never crosses the JS Number boundary.
 *   - Output buffers are caller-owned heap memory; nothing here allocates
 *     on the caller's behalf except ext_ensure_cache (grow-once).
 *   - No function redefines anything from cubiomes; everything goes through
 *     the submodule's public header API.
 */

#include "ext_bindings.h"

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>

/* Static generator + cache. Single worker-thread ownership documented above. */
static Generator g_gen; /* g.mc stays MC_UNDEF until ext_set_seed succeeds */
static int *g_cache = NULL;
static size_t g_cache_cap = 0; /* capacity in ints */
static int g_seeded = 0;

static uint64_t assemble_seed(int32_t seed_hi, uint32_t seed_lo)
{
	return ((uint64_t)(uint32_t)seed_hi << 32) | (uint32_t)seed_lo;
}

/*
 * Default cache capacity, in ints. Sized to cover the worst MVP tile:
 * 256x256 at scale 1 with 1.18+ voronoi scratch space is 78,604 ints
 * (getMinCacheSize for 1.18+ scale 1), and any 256-celled 1:256 tile
 * (64k ints) fits as well. Older layer-stack versions may need more and
 * are handled by ext_ensure_cache growth.
 */
#define EXT_CACHE_CAP ((size_t)128 * 1024)

int ext_ensure_cache(int n_ints)
{
	size_t want;

	if (n_ints <= 0)
		return EXT_EINVAL;
	want = (size_t)n_ints;
	if (g_cache != NULL && want <= g_cache_cap)
		return EXT_OK;

	if (g_cache == NULL)
	{
		size_t cap = want < EXT_CACHE_CAP ? EXT_CACHE_CAP : want;
		g_cache = (int *)malloc(cap * sizeof(int));
		if (g_cache == NULL)
			return EXT_ENOMEM;
		g_cache_cap = cap;
	}
	else
	{
		int *bigger;
		bigger = (int *)realloc(g_cache, want * sizeof(int));
		if (bigger == NULL)
			return EXT_ENOMEM; /* g_cache stays valid on realloc failure */
		g_cache = bigger;
		g_cache_cap = want;
	}
	return EXT_OK;
}

int ext_set_seed(int mc, uint32_t flags, int dim, int32_t seed_hi, uint32_t seed_lo)
{
	uint64_t seed;

	if (mc <= MC_UNDEF || mc > MC_NEWEST)
		return EXT_EINVAL;
	if (dim != DIM_NETHER && dim != DIM_OVERWORLD && dim != DIM_END)
		return EXT_EINVAL;

	seed = assemble_seed(seed_hi, seed_lo);
	setupGenerator(&g_gen, mc, flags);
	applySeed(&g_gen, dim, seed);
	g_seeded = 1;
	return EXT_OK;
}

int ext_gen_biome_tile(int scale, int32_t x, int32_t z, int w, int h, uint8_t *out)
{
	Range r;
	size_t cache_len;
	int i, base, id;
	const int *cur;
	uint8_t *dst;

	if (!g_seeded || out == NULL)
		return EXT_EINVAL;
	if (scale != 1 && scale != 4 && scale != 16 && scale != 64 && scale != 256)
		return EXT_EINVAL;
	if (w <= 0 || h <= 0 || (long long)w * (long long)h > (long long)INT32_MAX)
		return EXT_EINVAL;

	cache_len = getMinCacheSize(&g_gen, scale, w, 0, h);
	if (cache_len == 0)
		return EXT_EINVAL;
	if (cache_len > (size_t)INT32_MAX)
		return EXT_ECACHE; /* tile cache request exceeds anything representable in the i32 ABI */

	/* Cache contract: grow once to fit (no per-call allocation afterwards). */
	{
		int rc = ext_ensure_cache((int)cache_len);
		if (rc != EXT_OK)
			return rc;
	}

	/* Range doc comment in biomenoise.h: identity invariants
	 * out[i_y*sx*sz + i_z*sx + i_x]; horizontal (x,z) is the NW corner. */
	r.scale = scale;
	r.x = x;
	r.z = z;
	r.sx = w;
	r.sz = h;
	r.y = 0;
	r.sy = 1;

	if (genBiomes(&g_gen, g_cache, r) != 0)
		return EXT_EGEN;

	/* Crush int biome ids to bytes: real ids are 0..255, cubiomes `none` (-1)
	 * becomes EXT_BIOME_NONE (0xFF). One pass, no intermediate copies. */
	dst = out;
	cur = g_cache;
	base = w * h;
	for (i = 0; i < base; i++)
	{
		id = cur[i];
		dst[i] = (id == none) ? (uint8_t)EXT_BIOME_NONE : (uint8_t)id;
	}
	return EXT_OK;
}

int ext_find_structures(int structure_type, int reg_x0, int reg_z0, int reg_w,
	int reg_h, uint32_t flags, int32_t *out, int out_cap)
{
	int rx, rz, n = 0;
	int max_hits;
	Pos pos;

	if (!g_seeded || out == NULL || structure_type < 0 || structure_type >= FEATURE_NUM)
		return EXT_EINVAL;
	if (reg_w <= 0 || reg_h <= 0)
		return EXT_EINVAL;
	if ((long)reg_x0 + (long)reg_w > (long)INT32_MAX ||
		(long)reg_z0 + (long)reg_h > (long)INT32_MAX ||
		(long)reg_x0 + (long)reg_w < (long)INT32_MIN ||
		(long)reg_z0 + (long)reg_h < (long)INT32_MIN)
	{
		return EXT_EINVAL;
	}

	if ((long long)reg_w * (long long)reg_h > (long long)INT32_MAX)
		return EXT_EINVAL;

	max_hits = (int)((long long)reg_w * (long long)reg_h); /* at most one structure per region */
	if ((long long)out_cap < (long long)max_hits * 2)
		return EXT_EINVAL; /* hard out-of-bounds contract */

	/* Loop bound (reg_x0 + reg_w) is checked to fit an int above, so the
	 * counters below cannot overflow while walking the rectangle. */
	for (rz = reg_z0; rz < reg_z0 + reg_h; rz++)
	{
		for (rx = reg_x0; rx < reg_x0 + reg_w; rx++)
		{
			/* Skipped regions (e.g. strongholds don't generate here) count
			 * as misses; they are not an error. */
			if (getStructurePos(structure_type, g_gen.mc, g_gen.seed, rx, rz, &pos) == 0)
				continue;
			/* Biome-based viability in place; the generator may be touched
			 * temporarily by isViableStructurePos but is restored (documented
			 * in finders.h). */
			if (isViableStructurePos(structure_type, &g_gen, pos.x, pos.z, flags) == 0)
				continue;
			out[2 * n] = pos.x;
			out[2 * n + 1] = pos.z;
			n++;
		}
	}
	return n;
}

int ext_get_spawn(int32_t *out_xy)
{
	Pos p;

	if (!g_seeded || out_xy == NULL)
		return EXT_EINVAL;
	if (g_gen.dim != DIM_OVERWORLD)
		return EXT_EINVAL;

	p = getSpawn(&g_gen);
	out_xy[0] = p.x;
	out_xy[1] = p.z;
	return EXT_OK;
}

int ext_find_strongholds(int32_t *out, int max_count)
{
	StrongholdIter sh;
	int n = 0, remaining;

	if (!g_seeded || out == NULL)
		return EXT_EINVAL;
	if (g_gen.dim != DIM_OVERWORLD)
		return EXT_EINVAL;
	/* initFirstStronghold + one nextStronghold must not overrun the buffer
	 * downstream: max_count bounds the emit path below. */
	if (max_count <= 0)
		return EXT_EINVAL;

	/* Vanilla semantics: the iterator carries the approximate anchors; each
	 * nextStronghold() resolves the CURRENT approximate into an accurate,
	 * biome-checked position (sh.pos) and prepares the next approximation.
	 * 1.18+ iterates exactly 128 ring positions; pre-1.9 supports 3 and
	 * pre-B1_8 gives 0 (naturally bounded loop). */
	initFirstStronghold(&sh, g_gen.mc, (uint64_t)g_gen.seed);
	do
	{
		remaining = nextStronghold(&sh, &g_gen);
		/* The return value counts the remaining entries AFTER this one;
		 * a bogus index-128 result reports 0 and is skipped (it only
		 * advanced the RNG state). */
		if (remaining <= 0)
			break;
		if (n < max_count)
		{
			out[2 * n] = sh.pos.x;
			out[2 * n + 1] = sh.pos.z;
			n++;
		}
	} while (remaining > 0 && n < max_count);
	/* Stopping at the cap is safe: later positions are full ring entries and
	 * not affected by whether previous ones were emitted (the iterator keeps
	 * its own state). */
	return n;
}

int ext_get_structure_config(int structure_type, int mc, int32_t *out)
{
	StructureConfig sconf;

	if (out == NULL)
		return EXT_EINVAL;
	if (!getStructureConfig(structure_type, mc, &sconf))
		return EXT_ENOTSUP;
	out[0] = (int32_t)sconf.salt;
	out[1] = (int32_t)sconf.regionSize;
	out[2] = (int32_t)sconf.chunkRange;
	return EXT_OK;
}
