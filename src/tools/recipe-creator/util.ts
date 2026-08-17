import { stripJsonComments } from '../../shared/json';

export function uuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

export function sanitizeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
}

export function titleCase(s: string): string {
	return s.replace(/(^|[ _-])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function parseJsonText(text: string): any | null {
	try {
		return JSON.parse(stripJsonComments(text));
	} catch {
		return null;
	}
}

export function strToU8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
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
