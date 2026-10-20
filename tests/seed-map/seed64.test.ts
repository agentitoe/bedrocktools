/*
 * Seed Map — seed64 border tests.
 * Asserts the {hi, lo} split against pre-computed BigInt values so a Number
 * cast sneaking into the pipeline fails loudly.
 */

import { test, expect } from 'bun:test';
import {
	asSeed64,
	halvesToSeed,
	sameSeed,
	splitSeed,
	seedToHex,
} from '../../src/tools/seed-map/wasm/seed64';

// Pre-computed reference values (bun -e, BigInt math, no Number casts).
const SEED_PLAN = -2898418569583981710n; // plan example seed
const SEED_PLAN_HI = -674840662;
const SEED_PLAN_LO = 3717008242;
const SEED_BIG = 12345678901234567890n; // > 2^53
const SEED_BIG_HI = -1420514932;
const SEED_BIG_LO = 3944680146;

test('splitSeed produces exact halves for the plan example seed', () => {
	expect(splitSeed(SEED_PLAN)).toEqual({ hi: SEED_PLAN_HI, lo: SEED_PLAN_LO });
});

test('splitSeed is exact beyond 2^53 (no precision loss)', () => {
	const split = splitSeed(SEED_BIG);
	expect(split.hi).toBe(SEED_BIG_HI);
	expect(split.lo).toBe(SEED_BIG_LO);
	// The halves must NOT be the Number-decayed values:
	expect(split.lo).not.toBe(Number(SEED_BIG) >>> 0);
});

test('splitSeed edge values', () => {
	expect(splitSeed(0n)).toEqual({ hi: 0, lo: 0 });
	expect(splitSeed(1n)).toEqual({ hi: 0, lo: 1 });
	expect(splitSeed(-1n)).toEqual({ hi: -1, lo: 4294967295 });
	expect(splitSeed(2n ** 63n - 1n)).toEqual({ hi: 2147483647, lo: 4294967295 });
});

test('halves reconstruct the seed bit-exactly (round trip)', () => {
	for (const seed of [SEED_PLAN, SEED_BIG, 0n, 1n, -1n, 2n ** 63n - 1n, -(2n ** 63n)]) {
		// halvesToSeed returns the unsigned 64-bit pattern of the seed.
		expect(halvesToSeed(splitSeed(seed))).toBe(BigInt.asUintN(64, seed));
	}
});

test('seedToHex is the canonical 16-digit unsigned form', () => {
	expect(seedToHex(SEED_PLAN)).toBe('d7c6bfaadd8d0b72');
	// Same value through the pair representation.
	expect(seedToHex({ hi: SEED_PLAN_HI, lo: SEED_PLAN_LO })).toBe('d7c6bfaadd8d0b72');
	expect(seedToHex({ hi: 0, lo: 1 })).toBe('0000000000000001');
	expect(seedToHex(-1n)).toBe('ffffffffffffffff');
});

test('sameSeed compares halves only', () => {
	expect(sameSeed({ hi: 1, lo: 2 }, { hi: 1, lo: 2 })).toBe(true);
	expect(sameSeed({ hi: 1, lo: 2 }, { hi: 1, lo: 3 })).toBe(false);
});

test('asSeed64 validates pair inputs', () => {
	expect(asSeed64(SEED_PLAN)).toEqual({ hi: SEED_PLAN_HI, lo: SEED_PLAN_LO });
	expect(() => asSeed64({ hi: 1.5, lo: 0 })).toThrow(RangeError);
	expect(() => asSeed64({ hi: 0x80000000, lo: 0 })).toThrow(RangeError); // i32 overflow
	expect(() => asSeed64({ hi: 0, lo: -1 })).toThrow(RangeError); // lo is unsigned
	expect(() => asSeed64({ hi: 0, lo: 0x100000000 })).toThrow(RangeError);
});

test('splitSeed rejects values outside [-2^63, 2^63)', () => {
	expect(() => splitSeed(2n ** 64n)).toThrow(RangeError);
});
