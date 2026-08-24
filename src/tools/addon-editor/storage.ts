// IndexedDB persistence for the Addon Editor.
//
// The whole project (flat `path -> bytes` map plus a little UI state) is saved
// under a single key so a page refresh restores it. IndexedDB is used instead
// of localStorage because packs can contain images and sounds that easily
// exceed localStorage's ~5 MB quota. Every operation is best-effort: a failed
// write is logged but never breaks the editor.

import type { FileMap } from './pack';

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
		const req = run(tx.objectStore(STORE));
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
	});
}

export async function saveProject(snapshot: ProjectSnapshot): Promise<void> {
	try {
		const db = await openDb();
		await request(db, 'readwrite', (store) => store.put(snapshot, KEY));
		db.close();
	} catch (err) {
		console.error('Failed to save addon project:', err);
	}
}

/** Convert whatever structured clone gave us back into a clean FileMap. */
function normalizeFiles(raw: unknown): FileMap {
	const out: FileMap = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value instanceof Uint8Array) out[path] = value;
		else if (value instanceof ArrayBuffer) out[path] = new Uint8Array(value);
		else if (ArrayBuffer.isView(value)) {
			out[path] = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		}
	}
	return out;
}

export async function loadProject(): Promise<ProjectSnapshot | null> {
	try {
		const db = await openDb();
		const snapshot = (await request(db, 'readonly', (store) => store.get(KEY))) as ProjectSnapshot | undefined;
		db.close();
		if (!snapshot || typeof snapshot !== 'object') return null;
		return {
			files: normalizeFiles(snapshot.files),
			explicitFolders: Array.isArray(snapshot.explicitFolders) ? snapshot.explicitFolders : [],
			projectName: typeof snapshot.projectName === 'string' ? snapshot.projectName : '',
			currentDir: typeof snapshot.currentDir === 'string' ? snapshot.currentDir : '',
			openPath: typeof snapshot.openPath === 'string' ? snapshot.openPath : null,
			dirty: snapshot.dirty === true,
			currentText: typeof snapshot.currentText === 'string' ? snapshot.currentText : '',
		};
	} catch (err) {
		console.error('Failed to load addon project:', err);
		return null;
	}
}

export async function clearProject(): Promise<void> {
	try {
		const db = await openDb();
		await request(db, 'readwrite', (store) => store.delete(KEY));
		db.close();
	} catch (err) {
		console.error('Failed to clear addon project:', err);
	}
}
