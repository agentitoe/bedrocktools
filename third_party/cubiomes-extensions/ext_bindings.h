/*
 * Bedrock Tools — cubiomes-extensions/ext_bindings.h
 * Copyright (C) 2026 agentitoe — GPL-3.0 (see LICENSE at the repository root)
 *
 * Narrow C99 wrapper around the vendored cubiomes submodule (third_party/
 * cubiomes, MIT) for the Seed Map tool. This header only *extends* cubiomes:
 * it never redefines anything from it and simply #includes its headers, so
 * the build must pass `-I third_party/cubiomes` (see scripts/build-wasm.mjs).
 *
 * ABI contract for Emscripten (see scripts/build-wasm.mjs EXPORTED_FUNCTIONS):
 *
 *   - The module owns ONE static Generator instance. Each Web Worker runs its
 *     own module instance, so there is no shared mutable state between
 *     workers and no locking is required.
 *   - Seeds are always passed as a 64-bit pair {hi, lo}: the JS side NEVER
 *     converts a world seed to a JS Number (precision loss above 2^53).
 *     Reassembly on this side is exactly:
 *         uint64_t seed = ((uint64_t)(uint32_t)seed_hi << 32) | (uint32_t)seed_lo;
 *   - All output buffers are pre-allocated by the caller in the WASM heap
 *     (heap offsets as pointers). No function here allocates for the
 *     caller and none frees caller memory. The only allocation happens
 *     inside ext_ensure_cache(), which grows-once to fit the largest tile
 *     generated so far.
 *   - Values returned as "i" (int) in JS are machine ints; callers should
 *     read them via the returned value, not the heap.
 */

#ifndef EXT_BINDINGS_H_
#define EXT_BINDINGS_H_

#include <stdint.h>

#include "finders.h"   /* Pos, StructureType, getStructurePos, isViableStructurePos */
#include "generator.h" /* Generator, setupGenerator, applySeed, genBiomes, getBiomeAt */
#include "biomes.h"    /* biomeExists, isOverworld (validation) */

/* Return codes: negative on error, zero (or a count) on success. */
enum {
	EXT_OK = 0,    /* success */
	EXT_EINVAL = -1, /* invalid argument (scale/dimension/buffer not sane, or ext_set_seed not called yet) */
	EXT_ECACHE = -2, /* growing the internal generation cache failed or is forbidden */
	EXT_ENOMEM = -3, /* allocation failure inside ext_ensure_cache */
	EXT_EGEN = -4,   /* cubiomes generation step failed (genBiomes returned non-zero) */
};

/*
 * Sentinel byte for "no biome" in a tile produced by ext_gen_biome_tile.
 * cubiomes uses `none = -1` internally; real biome IDs are 0..255 and fit a
 * Uint8 buffer losslessly (max known id is 188, reserved space to 255), so
 * 0xFF is a safe sentinel and round-trips via (int8_t)id === none.
 */
enum {
	EXT_BIOME_NONE = 0xFF,
};

/*
 * Seeds the module's static generator for (mc, flags, dim, seed).
 * Calls setupGenerator() + applySeed() internally; safe to call again on the
 * same instance for a new seed/version/dimension — this is the "reset" path
 * (no WASM re-instantiation needed). Cache state is reused.
 *
 * Returns EXT_OK, or EXT_EINVAL if mc is out of the enum range or the
 * dimension is not one of {-1, 0, +1}.
 *
 * JS ABI: (i32 mc, i32 flags, i32 dim, i32 seed_hi, i32 seed_lo) -> i32
 */
int ext_set_seed(int mc, uint32_t flags, int dim, int32_t seed_hi, uint32_t seed_lo);

/*
 * Generates one rectangular tile of biome ids at a given horizontal scale
 * and writes them into `out` (row-major, `out[i * w + j]`, i = rows from
 * world `z` going south, j = columns from world `x` going east), matching
 * cubiomes' Range indexing out[i_z * sx + i_x] exactly (zero-copy: the
 * caller-owned heap buffer is written in place, one byte per biome).
 *
 * `scale` must be one of {1, 4, 16, 64, 256} (cubiomes scales). The tile is
 * `w` x `h` cells spanning world coordinates [x, x + w*scale) x
 * [z, z + h*scale) at 1:1 block space; (x, z) is the north-west corner,
 * i.e. exactly what cubiomes calls Range{x, z, sx, sz}.
 *
 * The caller must guarantee `out` holds at least w*h bytes. The internal
 * generation cache (see ext_ensure_cache) is grown once to the size
 * getMinCacheSize() reports for the largest tile generated so far; per-call
 * mallocs never happen for tiles within that size.
 *
 * Returns EXT_OK, or a negative code above. Tile contents are valid only
 * when EXT_OK is returned.
 *
 * JS ABI: (i32 scale, i32 x, i32 z, i32 w, i32 h, i32 outPtr) -> i32
 */
int ext_gen_biome_tile(int scale, int32_t x, int32_t z, int w, int h, uint8_t *out);

/*
 * Scans a rectangle of structure regions of one structure type and writes
 * the *viable* structure positions found, as consecutive (x, z) block
 * coordinate pairs into `out` (i32 pairs, directly readable from the heap).
 *
 * Region rect: reg_x0/reg_z0 is the north-west region index (inclusive),
 * reg_w/reg_h the rectangle size in regions. The regions walked are
 * [reg_x0, reg_x0 + reg_w) x [reg_z0, reg_z0 + reg_h). Region size and
 * separation per structure type come from cubiomes' getStructureConfig().
 *
 * For every region the routine calls getStructurePos(); positions skipped
 * by cubiomes (returns 0) are ignored. Survivors go through
 * isViableStructurePos() with the given `flags` (e.g. village variant flag,
 * 0 to default). The generator must already be seeded for the desired
 * version AND dimension: structures whose nether/end config check requires
 * the matching dimension are the JS bridge's responsibility.
 *
 * `out_cap` is the size of `out` in i32 values and must be at least
 * 2 * reg_w * reg_h (hard contract; returns EXT_EINVAL otherwise). This
 * guarantees the scan writes out of bounds never. Note that the number of
 * *valid* positions can be smaller.
 *
 * Stronghold is handled by getStructurePos itself (approximate anchor per
 * region); its real iteration lives in finders.c's StrongholdIter and is
 * not exposed through this narrow API.
 *
 * Returns the number of positions written (>= 0), or a negative code.
 *
 * JS ABI: (i32 type, i32 regX0, i32 regZ0, i32 regW, i32 regH,
 *          i32 flags, i32 outPtr, i32 outCap) -> i32
 */
int ext_find_structures(int structure_type, int reg_x0, int reg_z0, int reg_w,
	int reg_h, uint32_t flags, int32_t *out, int out_cap);

/*
 * Writes the world spawn point of the current generator into out_xy
 * (out_xy[0] = x, out_xy[1] = z, block coordinates). Uses cubiomes'
 * getSpawn(). Requires the generator seeded for the Overworld.
 *
 * Returns EXT_OK, or EXT_EINVAL when unseeded / wrong dimension.
 *
 * JS ABI: (i32 outPtr) -> i32
 */
int ext_get_spawn(int32_t *out_xy);

/*
 * Grows the internal generation cache (in ints) so that a tile of the
 * requested size fits. Allocation only happens when the cache actually
 * needs to grow (grow-once monotonic); call it before generating an
 * oversized tile — usually unnecessary for MVP tiles (a 256x256 tile at
 * scale 1 fits the default, see EXT_CACHE_CAP below).
 *
 * Returns EXT_OK, EXT_EINVAL (n <= 0) or EXT_ENOMEM.
 *
 * JS ABI: (i32 nInts) -> i32
 */
int ext_ensure_cache(int n_ints);

#endif /* EXT_BINDINGS_H_ */
