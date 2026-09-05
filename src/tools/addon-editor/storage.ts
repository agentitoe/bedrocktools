// IndexedDB persistence for the Addon Editor.
//
// The whole project (flat `path -> bytes` map plus a little UI state) is saved
// under a single key so a page refresh restores it. IndexedDB is used instead
// of localStorage because packs can contain images and sounds that easily
// exceed localStorage's ~5 MB quota. Every operation is best-effort: a failed
// write is logged but never breaks the editor.

import type { FileMap } from './pack';
import { sanitizeZipPath } from '../../shared/path';

const DB_NAME = 'bedrocktools-addon-editor';
const DB_VERSION = 1;
const STORE = 'project';
const KEY = 'current';

export interface ProjectSnapshot {
	files: FileMap;
	explicitFolders: string[];
	projectName: string;
	currentDir: string;
	openPath: string | null;
	dirty: boolean;
	currentText: string;
}

// Debounce + delta policy.
export const SAVE_DEBOUNCE_MS = 500;
const LARGE_PROJECT_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const MAX_PATH_LEN = 512;
const MAX_TEXT_LEN = 10 * 1024 * 1024;
const MAX_FILES = 10_000;

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSnapshot: ProjectSnapshot | null = null;
let lastSavedBytes = 0;
let lastSavedAt = 0;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) {
				db.createObjectStore(STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
	});
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		let settled = false;
		tx.onabort = () => {
			if (!settled) {
				settled = true;
				reject(tx.error ?? new Error('IndexedDB transaction aborted'));
			}
		};
		tx.onerror = () => {
			if (!settled) {
				settled = true;
				reject(tx.error ?? new Error('IndexedDB transaction failed'));
			}
		};
		let req: IDBRequest<T>;
		try {
			req = run(tx.objectStore(STORE));
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}
		req.onsuccess = () => {
			if (!settled) {
				settled = true;
				resolve(req.result);
			}
		};
		req.onerror = () => {
			if (!settled) {
				settled = true;
				reject(req.error ?? new Error('IndexedDB request failed'));
			}
		};
	});
}

function snapshotBytes(s: ProjectSnapshot): number {
	let total = s.currentText.length * 2;
	const keys = Object.keys(s.files);
	for (let i = 0; i < keys.length; i++) {
		const v = s.files[keys[i]];
		if (v) total += v.byteLength;
		if (total > MAX_SNAPSHOT_BYTES) break;
	}
	return total;
}

function isQuotaError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { name?: unknown; code?: unknown };
	return e.name === 'QuotaExceededError' || e.code === 22;
}

export async function saveProject(snapshot: ProjectSnapshot): Promise<void> {
	try {
		const bytes = snapshotBytes(snapshot);
		if (bytes > MAX_SNAPSHOT_BYTES) {
			console.warn(`Addon project too large (${bytes} bytes), skipping save`);
			return;
		}
		const db = await openDb();
		try {
			await request(db, 'readwrite', (store) => store.put(snapshot, KEY));
			lastSavedBytes = bytes;
			lastSavedAt = Date.now();
		} finally {
			db.close();
		}
	} catch (err) {
		if (isQuotaError(err)) {
			console.error('Addon project exceeds IndexedDB quota, skipping save:', err);
			return;
		}
		console.error('Failed to save addon project:', err);
	}
}

/**
 * Debounced save (500ms). For large projects only the delta-relevant snapshot
 * is persisted: if the byte size barely changed since the last save and the
 * project is large, the write is skipped to avoid churning IndexedDB.
 */
export function scheduleSaveProject(snapshot: ProjectSnapshot, delayMs: number = SAVE_DEBOUNCE_MS): void {
	pendingSnapshot = snapshot;
	if (debounceTimer !== undefined) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = undefined;
		const next = pendingSnapshot;
		pendingSnapshot = null;
		if (!next) return;
		const bytes = snapshotBytes(next);
		const now = Date.now();
		// Backpressure for large projects: skip near-duplicate size saves
		// within a short window (typing bursts).
		if (bytes > LARGE_PROJECT_BYTES && Math.abs(bytes - lastSavedBytes) < 4096 && now - lastSavedAt < 5000) {
			return;
		}
		void saveProject(next);
	}, delayMs);
}

/** Convert whatever structured clone gave us back into a clean FileMap. */
function normalizeFiles(raw: unknown): FileMap {
	const out: FileMap = {};
	if (!raw || typeof raw !== 'object') return out;
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > MAX_FILES) return out;
	for (const [rawPath, value] of entries) {
		if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_LEN) continue;
		const safe = sanitizeZipPath(rawPath);
		if (safe === null || safe.endsWith('/')) continue;
		let bytes: Uint8Array | null = null;
		if (value instanceof Uint8Array) bytes = value;
		else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
		else if (ArrayBuffer.isView(value)) {
			const v = value as ArrayBufferView;
			try {
				bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
			} catch {
				continue;
			}
		} else continue;
		if (bytes.byteLength > MAX_SNAPSHOT_BYTES) continue;
		out[safe] = bytes;
	}
	return out;
}

function normalizeFolders(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of raw) {
		if (typeof v !== 'string') continue;
		if (v.length === 0 || v.length > MAX_PATH_LEN) continue;
		// Folders must be relative dirs ending with "/".
		const withSlash = v.endsWith('/') ? v : v + '/';
		const inner = withSlash.slice(0, -1);
		const safe = sanitizeZipPath(inner);
		if (safe === null) continue;
		const dir = safe + '/';
		if (seen.has(dir)) continue;
		seen.add(dir);
		out.push(dir);
		if (out.length > MAX_FILES) break;
	}
	return out;
}

function normalizeDir(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	if (raw === '') return '';
	if (raw.length > MAX_PATH_LEN) return '';
	const inner = raw.endsWith('/') ? raw.slice(0, -1) : raw;
	if (!inner) return '';
	const safe = sanitizeZipPath(inner);
	return safe === null ? '' : safe + '/';
}

export async function loadProject(): Promise<ProjectSnapshot | null> {
	try {
		const db = await openDb();
		let snapshot: unknown;
		try {
			snapshot = (await request(db, 'readonly', (store) => store.get(KEY))) as ProjectSnapshot | undefined;
		} finally {
			db.close();
		}
		if (!snapshot || typeof snapshot !== 'object') return null;
		const s = snapshot as Record<string, unknown>;
		const files = normalizeFiles(s['files']);
		const explicitFolders = normalizeFolders(s['explicitFolders']);
		const projectName = typeof s['projectName'] === 'string' ? (s['projectName'] as string).slice(0, 256) : '';
		const currentDir = normalizeDir(s['currentDir']);
		let openPath: string | null = null;
		if (typeof s['openPath'] === 'string') {
			const rawOpen = s['openPath'] as string;
			if (rawOpen.length > 0 && rawOpen.length <= MAX_PATH_LEN) {
				const safe = sanitizeZipPath(rawOpen);
				if (safe !== null && !safe.endsWith('/') && files[safe] !== undefined) openPath = safe;
			}
		}
		const dirty = s['dirty'] === true;
		let currentText = typeof s['currentText'] === 'string' ? (s['currentText'] as string) : '';
		if (currentText.length > MAX_TEXT_LEN) currentText = currentText.slice(0, MAX_TEXT_LEN);
		// openPath must exist; dirty without an open file is meaningless.
		if (!openPath) {
			return {
				files,
				explicitFolders,
				projectName,
				currentDir,
				openPath: null,
				dirty: false,
				currentText: '',
			};
		}
		return { files, explicitFolders, projectName, currentDir, openPath, dirty, currentText };
	} catch (err) {
		console.error('Failed to load addon project:', err);
		return null;
	}
}

export async function clearProject(): Promise<void> {
	try {
		if (debounceTimer !== undefined) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		pendingSnapshot = null;
		const db = await openDb();
		try {
			await request(db, 'readwrite', (store) => store.delete(KEY));
		} finally {
			db.close();
		}
	} catch (err) {
		console.error('Failed to clear addon project:', err);
	}
}
