/*
 * Seed Map — seed input / version select / page i18n data tests.
 * All pure module + static file checks (no DOM runtime in bun test).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSeedText, javaStringHash, parseSeedInput } from '../../src/tools/seed-map/ui/seed-text';
import { DEFAULT_MC_VERSION, MC_VERSION_CHOICES } from '../../src/tools/seed-map/ui/versions';
import { translations } from '../../src/tools/seed-map/translations';

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = (2n ** 63n) - 1n;

describe('javaStringHash (Java String.hashCode semantics)', () => {
	test('known Java fixtures', () => {
		expect(javaStringHash('abc')).toBe(96354);
		expect(javaStringHash('hello')).toBe(99162322);
		expect(javaStringHash('')).toBe(0);
	});

	test('wraps like a signed 32-bit int', () => {
		// Deterministic + always inside i32 for arbitrary text.
		for (const text of ['Grass', 'seed de prueba', '😀😀😀']) {
			const h = javaStringHash(text);
			expect(Number.isInteger(h)).toBe(true);
			expect(h).toBeGreaterThanOrEqual(-2147483648);
			expect(h).toBeLessThanOrEqual(2147483647);
		}
		expect(javaStringHash('Grass')).toBe(javaStringHash('Grass'));
	});
});

describe('parseSeedInput (vanilla seed box semantics)', () => {
	test('signed decimals within i64 parse exactly', () => {
		expect(parseSeedInput('0')).toBe(0n);
		expect(parseSeedInput('123')).toBe(123n);
		expect(parseSeedInput('-42')).toBe(-42n);
		expect(parseSeedInput('-2898418569583981710')).toBe(-2898418569583981710n);
	});

	test('values beyond 2^53 keep every bit (no Number casts)', () => {
		expect(parseSeedInput('9007199254740993')).toBe(9007199254740993n);
		expect(parseSeedInput(LONG_MAX.toString())).toBe(LONG_MAX);
		expect(parseSeedInput(LONG_MIN.toString())).toBe(LONG_MIN);
	});

	test('non-numeric text falls back to the Java hash', () => {
		expect(parseSeedInput('Grass')).toBe(BigInt(javaStringHash('Grass')));
		expect(parseSeedInput('my seed')).toBe(BigInt(javaStringHash('my seed')));
	});

	test('empty input throws', () => {
		expect(() => parseSeedInput('')).toThrow();
		expect(() => parseSeedInput('   ')).toThrow();
	});

	test('decimals overflowing a long are hashed like vanilla', () => {
		expect(parseSeedInput('99999999999999999999999')).toBe(BigInt(javaStringHash('99999999999999999999999')));
	});
});

describe('canonicalSeedText', () => {
	test('is the exact signed inverse of parseSeedInput (roundtrip beyond 2^53)', () => {
		for (const seed of [0n, -1n, 1234567890123456789n, LONG_MAX, LONG_MIN]) {
			expect(parseSeedInput(canonicalSeedText(seed))).toBe(seed);
		}
	});
});

describe('MC_VERSION_CHOICES', () => {
	test('enum values are monotonic with no gaps 22..32', () => {
		const versions = MC_VERSION_CHOICES.map((c) => c.enum);
		expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => 22 + i));
		expect(versions[versions.length - 1]).toBe(32);
	});

	test('the default is the newest listed version (32 = MC_1_21/1.21.11)', () => {
		expect(DEFAULT_MC_VERSION).toBe(32);
		expect(MC_VERSION_CHOICES.some((c) => c.enum === DEFAULT_MC_VERSION && c.label.length > 0)).toBe(true);
	});

	test('snapshot lineage (33..35) is not listed', () => {
		const versions = MC_VERSION_CHOICES.map((c) => c.enum);
		expect(versions.includes(33)).toBe(false);
		expect(versions.includes(34)).toBe(false);
		expect(versions.includes(35)).toBe(false);
	});
});

describe('page data-i18n parity (ES/EN)', () => {
	const page = readFileSync(join(import.meta.dir, '../../public/tools/seed-map/index.html'), 'utf8');
	// module-less regex: replicate the shared ui.ts matcher loosely.
	const pattern = /data-i18n="([^"]+)"/g;
	const keys = [...page.matchAll(pattern)].map((m) => m[1]);

	test('the page declares data-i18n keys', () => {
		expect(keys.length).toBeGreaterThan(0);
	});

	test('every declared key exists in both languages', () => {
		const missing: string[] = [];
		for (const key of keys) {
			if (!(key in translations.es)) missing.push('es:' + key);
			if (!(key in translations.en)) missing.push('en:' + key);
		}
		expect(missing).toEqual([]);
	});
});
