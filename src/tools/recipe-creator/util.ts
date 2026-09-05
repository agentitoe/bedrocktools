import { stripJsonComments } from '../../shared/json';

export function uuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
		bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
		const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
		return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
	}
	throw new Error('Secure random number generator is not available in this environment.');
}

export function sanitizeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
}

export function titleCase(s: string): string {
	return s.replace(/(^|[ _-])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

/** Central HTML escaper for the recipe tool (covers `&<>"'`). */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function parseJsonText(text: string): any | null {
	try {
		return JSON.parse(stripJsonComments(text));
	} catch {
		return null;
	}
}

/** Shared singleton encoder (avoids one allocation per export call). */
const utf8Encoder = new TextEncoder();

export function strToU8(s: string): Uint8Array {
	return utf8Encoder.encode(s);
}

/** Wrap bytes in a Blob (copies into a fresh buffer to satisfy the BlobPart type). */
export function toBlob(bytes: Uint8Array, type: string): Blob {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Blob([copy], { type });
}

export function isValidIdentifier(id: string): boolean {
	// Bedrock namespaces and Java resource locations both allow `-` and `.`.
	return /^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(id);
}

/** Trailing-edge debounce: groups rapid calls (search inputs, live editors). */
export function debounce<F extends (...args: never[]) => void>(fn: F, ms: number): F {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return ((...args: never[]) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, ms);
	}) as F;
}

/** Clamp a count-like value into `[min, max]` with a fallback for NaN. */
export function clampCount(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}
