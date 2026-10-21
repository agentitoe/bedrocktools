/*
 * Seed Map — ui/seed-text.ts
 * Seed text <> bigint conversion with Java Edition semantics.
 *
 * DECISION (documented, tests pin the fixtures):
 *   The vanilla input field parses its text as a Java `long`; when the parse
 *   fails (non-numeric text or a decimal overflowing a long) the CLIENT hashes
 *   the string instead. We mirror that exactly:
 *     - "123", "-42"          -> the decimal itself (must fit i64).
 *     - "my seed", "+123..."  -> Java String.hashCode() of the raw text:
 *         h = h*31 + char (UTF-16 code units), overflow wrapping like a Java
 *         `int` (Math.imul + |0 reproduce the 32-bit wrap exactly).
 *   canonicalSeedText() prints the two's-complement signed decimal, so every
 *   canonical URL value is itself a pasteable vanilla seed and parses back to
 *   the same 64-bit value (roundtrip holds far beyond 2^53).
 */

/** Java `String.hashCode()`: h = 31*h + unit, inside a wrapping i32. */
export function javaStringHash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h, 31) + text.charCodeAt(i) | 0;
	}
	return h | 0;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = (2n ** 63n) - 1n;

/**
 * Parses the seed box like Java Edition does.
 * Throws when the input is empty (nothing to hash); never throws for decimal
 * inputs that fit a long. Returns the exact 64-bit value as a bigint.
 */
export function parseSeedInput(text: string): bigint {
	const trimmed = text.trim();
	if (/^[+-]?\d+$/.test(trimmed)) {
		const value = BigInt(trimmed); // exact: Number() would lose bits > 2^53
		if (value >= LONG_MIN && value <= LONG_MAX) return value;
		// A decimal that overflows a long fails vanilla's parse too — hashed.
		return BigInt(javaStringHash(trimmed));
	}
	if (trimmed.length === 0) {
		throw new Error('empty seed input');
	}
	return BigInt(javaStringHash(trimmed));
}

/** Canonical decimal text of a seed: signed printable long (exact inverse of parseSeedInput). */
export function canonicalSeedText(seed: bigint): string {
	return BigInt.asIntN(64, seed).toString();
}
