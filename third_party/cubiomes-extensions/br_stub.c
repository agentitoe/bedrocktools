/*
 * Bedrock Tools — cubiomes-extensions/br_stub.c
 * Copyright (C) 2026 agentitoe — GPL-3.0 (see LICENSE at the repository root)
 *
 * PLACEHOLDER for the Bedrock structure module (plan E5), so that the
 * `bedrock-structures.wasm` artifact and the JS contract exist before the
 * real RNG work lands. This file will be REPLACED by bedrock_mt.c +
 * bedrock_structures.c (written from spec, no code copied from
 * Chunkbiomes/helix-bedrock) — expect the ABI below to be frozen here:
 *
 *   int br_find(int type, int range, int32_t seed_hi, uint32_t seed_lo, int32_t *out);
 *
 *   - type    : structure type id of the Bedrock catalog (frozen in E5)
 *   - range   : search half-range in chunks around the origin chunk (0,0)
 *   - seed    : 64-bit Bedrock world seed as {hi, lo} i32 pair, same rule as
 *               ext_bindings (the JS side never converts it to a Number)
 *   - out     : caller-owned heap buffer, consecutive (x, z) i32 block
 *               coordinate pairs of the anchors found; capacity contract is
 *               defined together with the real range semantics in E5
 *   - returns : number of pairs written (>= 0)
 *
 * The stub writes nothing and always returns 0 ("no hits"), which is a valid
 * result under the contract above — callers can already wire loading,
 * instantiation and message flow without getting ghost structures.
 */

#include <stdint.h>

int br_find(int type, int range, int32_t seed_hi, uint32_t seed_lo, int32_t *out)
{
	(void)type;
	(void)range;
	(void)seed_hi;
	(void)seed_lo;
	(void)out;
	return 0;
}
