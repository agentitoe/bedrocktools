/*
 * Seed Map — wasm/seed64.ts
 * Seed 64-bit encoding helpers. BigInt exists ONLY here (the "border"):
 * everything downstream of splitSeed() travels as {hi, lo} i32 pairs.
 *
 * Invariants (must hold anywhere a seed is passed around):
 *   - No conversion of a full 64-bit seed to a Number, ever: precision is
 *     lost above 2^53 and sign Arabs off on negatives (two's complement).
 *   - The halves reconstruct the seed bit-exactly:
 *       seed64 === halvesToSeed(splitSeed(seed64))
 *   - hi is signed (i32), lo is unsigned (u32) — matches the C ABI
 *     int32_t seed_hi, uint32_t seed_lo of third_party/cubiomes-extensions.
 */

export type Seed64 = { hi: number; lo: number };

/** Splits a BigInt seed into the exact {hi, lo} pair expected by the C ABI. */
export function splitSeed(seed: bigint): Seed64 {
	hiCheck(seed);
	return {
		hi: Number(BigInt.asIntN(32, seed >> 32n)),
		lo: Number(BigInt.asUintN(32, seed & 0xffffffffn)),
	};
}

/** Rebuilds the seed from the two halves. Exact inverse of splitSeed. */
export function halvesToSeed(seed: Seed64): bigint {
	const hi = BigInt.asUintN(32, BigInt(seed.hi));
	const lo = BigInt.asUintN(32, BigInt(seed.lo));
	return (hi << 32n) | lo;
}

/**
 * Canonical hex form of a seed (16 lowercase digits). Used by the tile cache
 * key so seeds beyond 2^53 stay collision-free and readable in DevTools.
 */
export function seedToHex(seed: bigint | Seed64): string {
	const value = typeof seed === 'bigint' ? seed : halvesToSeed(seed);
	return BigInt.asUintN(64, value).toString(16).padStart(16, '0');
}

/** True when both representations point at the same 64-bit value. */
export function sameSeed(a: Seed64, b: Seed64): boolean {
	return a.hi === b.hi && a.lo === b.lo;
}

/**
 * Accepts either representation and returns the {hi, lo} pair form. Wraps the
 * "border" of the module: UI sources hand over a bigint, the pipeline only
 * ever carries pairs.
 */
export function asSeed64(seed: bigint | Seed64): Seed64 {
	if (typeof seed === 'bigint') return splitSeed(seed);
	if (!Number.isInteger(seed.hi) || !Number.isInteger(seed.lo)) {
		throw new RangeError('seed halves must be integers: ' + JSON.stringify(seed));
	}
	if (seed.hi < -0x80000000 || seed.hi > 0x7fffffff) {
		throw new RangeError('seed hi does not fit an i32: ' + seed.hi);
	}
	if (seed.lo < 0 || seed.lo > 0xffffffff) {
		throw new RangeError('seed lo does not fit a u32: ' + seed.lo);
	}
	return { hi: seed.hi, lo: seed.lo };
}

/**
 * Reinforces the "no implicit Number cast" rule AND the u64 range of world
 * seeds: cubiomes reassembles (uint32_t)hi << 32 | (uint32_t)lo, so legal
 * seeds are [-2^63, 2^64) — anything above 2^64 carries an extra bit and is
 * a caller bug, caught here instead of silently mangling the halves later.
 */
function hiCheck(seed: bigint): void {
	if (seed < -(2n ** 63n) || seed > 2n ** 64n - 1n) {
		throw new RangeError('seed does not fit a u64 world seed: ' + seed);
	}
}
