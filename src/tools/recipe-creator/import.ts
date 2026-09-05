import { unzipSync } from 'fflate';
import type { FurnaceTag, ImportedDataPack, ImportedPack, RecipeState } from './types';
import { FURNACE_TAGS } from './types';
import { translations } from './translations';
import {
	importedPacks,
	importedDataPack,
	importedSourceName,
	recipes,
	currentLang,
	platform,
	customItems,
	javaPackFormat,
	packName,
	setImportedPacks,
	setImportedDataPack,
	setImportedSourceName,
	resetCustomItems,
	setRecipes,
	setPackName,
	setSelectedIndex,
	setIdentifierManuallyEdited,
	setJavaPackFormat,
} from './state';
import { getOrCreateCustomItem, resolveItemId, extractItemIdentifier } from './items';
import { sanitizeName, parseJsonText, uuid, toBlob, escapeHtml } from './util';
import { normalizePath, sanitizeZipPath } from '../../shared/path';
import { decodeUtf8Sig } from '../../shared/encoding';
import { renderRecipeList, renderEditor } from './editor';

// ---- Import limits (zip-bomb / traversal hardening) ----

/** Max entries accepted from a single archive (outer or nested). */
const MAX_ZIP_ENTRIES = 2000;
/** Max total decompressed bytes accepted from a single archive (200 MiB). */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** Max decompressed bytes for any single entry (50 MiB). */
const MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
/** Max TGA texture dimension (width/height). */
const MAX_TGA_DIMENSION = 4096;

/**
 * Unzip with guards: try/catch, entry-count and decompressed-size caps, and
 * `sanitizeZipPath` rejection of absolute paths / drive letters / `..`
 * traversal. Returns null when the archive must be rejected.
 */
function safeUnzip(buffer: Uint8Array): Map<string, Uint8Array> | null {
	let raw: Record<string, Uint8Array>;
	try {
		raw = unzipSync(buffer);
	} catch {
		return null;
	}
	const entries = Object.entries(raw);
	if (entries.length > MAX_ZIP_ENTRIES) return null;
	let total = 0;
	const out = new Map<string, Uint8Array>();
	for (const [p, b] of entries) {
		const clean = sanitizeZipPath(normalizePath(p));
		if (!clean) continue; // traversal / absolute / drive-letter entry
		if (clean.endsWith('/')) continue; // directory entry
		if (b.length > MAX_SINGLE_FILE_BYTES) return null;
		total += b.length;
		if (total > MAX_TOTAL_BYTES) return null;
		if (!out.has(clean)) out.set(clean, b);
	}
	return out;
}

// ---- Blob URL lifetime (extracted textures) ----

const createdObjectUrls = new Set<string>();

function trackObjectUrl(url: string | null): string | null {
	if (url && url.startsWith('blob:')) createdObjectUrls.add(url);
	return url;
}

/** Revoke every blob URL created for imported textures (call on re-import). */
export function revokeImportedUrls(): void {
	for (const url of createdObjectUrls) {
		try {
			URL.revokeObjectURL(url);
		} catch {
			// Already revoked or invalid — nothing to do.
		}
	}
	createdObjectUrls.clear();
}

// ---- Path / manifest helpers ----

const RECIPE_PATH_RE = /(^|\/)recipes\/[^/]+\.json$/i;

export function isRecipePath(p: string): boolean {
	return RECIPE_PATH_RE.test(normalizePath(p));
}

function manifestPackType(manifest: any): 'behavior' | 'resource' | null {
	if (!manifest || typeof manifest !== 'object') return null;
	const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
	for (const m of modules) {
		if (!m || typeof m !== 'object') continue;
		if (m.type === 'data') return 'behavior';
		if (m.type === 'resources') return 'resource';
	}
	const header = manifest.header;
	if (header && typeof header === 'object') {
		if (header.module_type === 'data') return 'behavior';
		if (header.module_type === 'resources') return 'resource';
	}
	return null;
}

function findPackFile(pack: ImportedPack, relPath: string): Uint8Array | undefined {
	const norm = normalizePath(relPath).replace(/^\/+/, '').toLowerCase();
	for (const [p, b] of pack.files) {
		if (normalizePath(p).replace(/^\/+/, '').toLowerCase() === norm) return b;
	}
	return undefined;
}

// ---- Texture decoding (TGA + PNG/JPG) ----

/** Minimal TGA decoder (uncompressed + RLE, 24/32-bit) — common in Bedrock resource packs. */
export function decodeTga(bytes: Uint8Array): { width: number; height: number; pixels: Uint8ClampedArray } | null {
	if (bytes.length < 18) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const idLength = dv.getUint8(0);
	const colorMapType = dv.getUint8(1);
	const imageType = dv.getUint8(2);
	const colorMapLength = dv.getUint16(5, true);
	const colorMapEntrySize = dv.getUint8(7);
	const width = dv.getUint16(12, true);
	const height = dv.getUint16(14, true);
	const pixelDepth = dv.getUint8(16);
	const descriptor = dv.getUint8(17);

	if (colorMapType !== 0) return null;
	if (pixelDepth !== 24 && pixelDepth !== 32) return null;
	if (imageType !== 2 && imageType !== 10) return null;
	if (width <= 0 || height <= 0) return null;
	if (width > MAX_TGA_DIMENSION || height > MAX_TGA_DIMENSION) return null;
	if (colorMapLength > 0 && colorMapEntrySize % 8 !== 0) return null;

	const bpp = pixelDepth / 8;
	const offset = 18 + idLength + (colorMapLength * colorMapEntrySize) / 8;
	// Validate the data offset before touching pixel data.
	if (!Number.isFinite(offset) || offset < 0 || offset > bytes.length) return null;
	const pixelCount = width * height;
	if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_TGA_DIMENSION * MAX_TGA_DIMENSION) return null;
	// Uncompressed payload must fit (RLE is variable-size; guarded per-packet below).
	if (imageType === 2 && offset + pixelCount * bpp > bytes.length) return null;
	const pixels = new Uint8ClampedArray(pixelCount * 4);
	const flipV = (descriptor & 0x20) === 0; // TGA origin is bottom-left by default
	const flipH = (descriptor & 0x10) !== 0;

	const write = (index: number, r: number, g: number, b: number, a: number) => {
		let x = index % width;
		let y = Math.floor(index / width);
		if (flipV) y = height - 1 - y;
		if (flipH) x = width - 1 - x;
		const o = (y * width + x) * 4;
		pixels[o] = r;
		pixels[o + 1] = g;
		pixels[o + 2] = b;
		pixels[o + 3] = a;
	};

	let pos = offset;
	if (imageType === 2) {
		for (let i = 0; i < pixelCount; i++) {
			if (pos + bpp > bytes.length) break;
			write(i, bytes[pos + 2], bytes[pos + 1], bytes[pos], bpp === 4 ? bytes[pos + 3] : 255);
			pos += bpp;
		}
	} else {
		let i = 0;
		while (i < pixelCount && pos < bytes.length) {
			const packet = bytes[pos++];
			const count = (packet & 0x7f) + 1;
			if (packet & 0x80) {
				if (pos + bpp > bytes.length) break;
				const r = bytes[pos + 2];
				const g = bytes[pos + 1];
				const b = bytes[pos];
				const a = bpp === 4 ? bytes[pos + 3] : 255;
				pos += bpp;
				for (let j = 0; j < count && i < pixelCount; j++, i++) write(i, r, g, b, a);
			} else {
				for (let j = 0; j < count && i < pixelCount; j++, i++) {
					if (pos + bpp > bytes.length) break;
					write(i, bytes[pos + 2], bytes[pos + 1], bytes[pos], bpp === 4 ? bytes[pos + 3] : 255);
					pos += bpp;
				}
			}
		}
	}
	return { width, height, pixels };
}

function tgaToImageUrl(bytes: Uint8Array): string | null {
	const decoded = decodeTga(bytes);
	if (!decoded) return null;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = decoded.width;
		canvas.height = decoded.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		const imgData = ctx.createImageData(decoded.width, decoded.height);
		imgData.data.set(decoded.pixels);
		ctx.putImageData(imgData, 0, 0);
		return canvas.toDataURL('image/png');
	} catch {
		return null;
	}
}

function bytesToImageUrl(bytes: Uint8Array, ext: string): string | null {
	const lower = ext.replace('.', '').toLowerCase();
	if (lower === 'tga') return tgaToImageUrl(bytes);
	const mime = lower === 'png' ? 'image/png' : (lower === 'jpg' || lower === 'jpeg') ? 'image/jpeg' : null;
	if (!mime) return null;
	try {
		return trackObjectUrl(URL.createObjectURL(toBlob(bytes, mime)));
	} catch {
		return null;
	}
}

// ---- Custom item / block definitions ----

type TextureAtlas = Record<string, string[]>;

function buildAtlas(resourcePacks: ImportedPack[], atlasPaths: string[]): TextureAtlas {
	const atlas: TextureAtlas = {};
	for (const pack of resourcePacks) {
		for (const ap of atlasPaths) {
			const bytes = findPackFile(pack, ap);
			if (!bytes) continue;
			const data = parseJsonText(decodeUtf8Sig(bytes));
			if (!data || !data.texture_data || typeof data.texture_data !== 'object') continue;
			for (const [shortname, entry] of Object.entries(data.texture_data)) {
				if (!entry || typeof entry !== 'object') continue;
				let paths: string[] = [];
				if (typeof (entry as any).textures === 'string') paths = [(entry as any).textures];
				else if (Array.isArray((entry as any).textures)) {
					paths = (entry as any).textures.filter((x: unknown) => typeof x === 'string');
				}
				if (paths.length > 0 && !atlas[shortname]) atlas[shortname] = paths;
			}
		}
	}
	return atlas;
}

function findTextureInPack(pack: ImportedPack, basePath: string): string | null {
	for (const ext of ['.png', '.tga', '.jpg', '.jpeg']) {
		const bytes = findPackFile(pack, basePath + ext);
		if (bytes) {
			const url = bytesToImageUrl(bytes, ext);
			if (url) return url;
		}
	}
	return null;
}

function resolveDefinitionTexture(
	identifier: string,
	shortname: string | undefined,
	atlas: TextureAtlas,
	resourcePacks: ImportedPack[]
): string | null {
	const keys = [shortname, identifier.split(':').pop()].filter((k): k is string => !!k);
	for (const key of keys) {
		for (const candidate of atlas[key] || []) {
			for (const pack of resourcePacks) {
				const url = findTextureInPack(pack, candidate);
				if (url) return url;
			}
		}
	}
	return null;
}

function extractDisplayName(def: any): string | undefined {
	const components = def.components;
	if (components && typeof components === 'object') {
		const dn = components['minecraft:display_name'];
		if (typeof dn === 'string' && dn) return dn;
		if (dn && typeof dn === 'object' && typeof dn.value === 'string') return dn.value;
	}
	const legacy = def['minecraft:display_name'];
	if (typeof legacy === 'string' && legacy) return legacy;
	if (legacy && typeof legacy === 'object' && typeof legacy.value === 'string') return legacy.value;
	return undefined;
}

function extractIconShortname(def: any, kind: 'item' | 'block'): string | undefined {
	const components = def.components;
	if (!components || typeof components !== 'object') return undefined;
	if (kind === 'item') {
		const icon = components['minecraft:icon'];
		if (typeof icon === 'string') return icon;
		if (icon && typeof icon === 'object') {
			if (typeof icon.textures === 'string') return icon.textures;
			if (Array.isArray(icon.textures) && typeof icon.textures[0] === 'string') return icon.textures[0];
		}
	} else {
		const mi = components['minecraft:material_instances'];
		if (mi && typeof mi === 'object') {
			const inst = mi['*'] || mi[Object.keys(mi)[0]];
			if (inst && typeof inst === 'object' && typeof inst.texture === 'string') return inst.texture;
		}
	}
	return undefined;
}

function parseDefinitionFile(
	bytes: Uint8Array,
	kind: 'item' | 'block',
	atlas: TextureAtlas,
	resourcePacks: ImportedPack[]
): void {
	const data = parseJsonText(decodeUtf8Sig(bytes));
	if (!data || typeof data !== 'object') return;

	const defs: { identifier: string; shortname?: string; displayName?: string }[] = [];
	const direct = kind === 'item' ? data['minecraft:item'] : data['minecraft:block'];
	if (direct && typeof direct === 'object') {
		const identifier = direct.description?.identifier;
		if (typeof identifier === 'string') {
			defs.push({
				identifier,
				shortname: extractIconShortname(direct, kind),
				displayName: extractDisplayName(direct)
			});
		}
	} else {
		// Legacy map format: { "ns:item": { ... } }
		for (const [key, val] of Object.entries(data)) {
			if (!key.includes(':')) continue;
			if (val && typeof val === 'object') {
				defs.push({
					identifier: key,
					shortname: extractIconShortname(val, kind),
					displayName: extractDisplayName(val)
				});
			}
		}
	}

	for (const d of defs) {
		const textureUrl = resolveDefinitionTexture(d.identifier, d.shortname, atlas, resourcePacks) || undefined;
		const item = getOrCreateCustomItem(d.identifier, kind, textureUrl);
		if (d.displayName) item.displayName = d.displayName;
	}
}

function parseCustomDefinitions(
	pack: ImportedPack,
	itemAtlas: TextureAtlas,
	blockAtlas: TextureAtlas,
	resourcePacks: ImportedPack[]
): void {
	for (const [p, b] of pack.files) {
		const np = normalizePath(p).toLowerCase();
		if (np.startsWith('items/') && np.endsWith('.json')) {
			parseDefinitionFile(b, 'item', itemAtlas, resourcePacks);
		} else if (np.startsWith('blocks/') && np.endsWith('.json')) {
			parseDefinitionFile(b, 'block', blockAtlas, resourcePacks);
		}
	}
}

// ---- Recipe parsing (Bedrock addons) ----

function fallbackIdentifier(path: string): string {
	const name = normalizePath(path).split('/').pop()?.replace(/\.json$/i, '') || 'imported';
	return 'custom:' + sanitizeName(name);
}

/** Keep the recipe's namespace, and add a default one if the addon omitted it. */
function normalizeImportedIdentifier(identifier: string | undefined | null, path: string): string {
	if (!identifier) return fallbackIdentifier(path);
	if (!identifier.includes(':')) return 'custom:' + sanitizeName(identifier);
	return identifier;
}

function resolveResult(result: any): { id: number | null; count: number } {
	if (result == null) return { id: null, count: 1 };
	if (typeof result === 'string') return { id: resolveItemId(result), count: 1 };
	const ident = extractItemIdentifier(result);
	if (!ident) return { id: null, count: 1 };
	const count = typeof result.count === 'number' && result.count >= 1 ? result.count : 1;
	return { id: resolveItemId(ident), count };
}

export function parseRecipeFile(path: string, text: string, packIndex: number): RecipeState | null {
	const data = parseJsonText(text);
	if (!data || typeof data !== 'object') return null;

	const shaped = data['minecraft:recipe_shaped'];
	if (shaped && typeof shaped === 'object') {
		const identifier = normalizeImportedIdentifier(shaped.description?.identifier, path);
		const grid: (number | null)[] = new Array(9).fill(null);
		const pattern = Array.isArray(shaped.pattern) ? shaped.pattern : [];
		const key = shaped.key || {};
		for (let row = 0; row < Math.min(pattern.length, 3); row++) {
			const line = String(pattern[row] || '');
			for (let c = 0; c < Math.min(line.length, 3); c++) {
				const ch = line[c];
				if (!ch || ch === ' ') continue;
				const ident = extractItemIdentifier(key[ch]);
				if (ident) grid[row * 3 + c] = resolveItemId(ident);
			}
		}
		const res = resolveResult(shaped.result);
		return {
			id: uuid(), type: 'shaped', identifier, grid, ingredients: [], input: null, output: null,
			furnaceTag: 'furnace', resultId: res.id, resultCount: res.count,
			sourceFile: path, sourcePackIndex: packIndex, preserveIdentifier: true
		};
	}

	const shapeless = data['minecraft:recipe_shapeless'];
	if (shapeless && typeof shapeless === 'object') {
		const identifier = normalizeImportedIdentifier(shapeless.description?.identifier, path);
		const ingredients = Array.isArray(shapeless.ingredients)
			? shapeless.ingredients
				.map((ing: any) => extractItemIdentifier(ing))
				.filter((x: string | null): x is string => !!x)
				.map(resolveItemId)
			: [];
		const res = resolveResult(shapeless.result);
		return {
			id: uuid(), type: 'shapeless', identifier, grid: new Array(9).fill(null), ingredients,
			input: null, output: null, furnaceTag: 'furnace', resultId: res.id, resultCount: res.count,
			sourceFile: path, sourcePackIndex: packIndex, preserveIdentifier: true
		};
	}

	const furnace = data['minecraft:recipe_furnace'];
	if (furnace && typeof furnace === 'object') {
		const identifier = normalizeImportedIdentifier(furnace.description?.identifier, path);
		const tags = Array.isArray(furnace.tags) ? furnace.tags : [];
		const tag = (FURNACE_TAGS.find((ft) => tags.includes(ft)) || 'furnace') as FurnaceTag;
		const inputIdent = extractItemIdentifier(furnace.input);
		const outputIdent = extractItemIdentifier(furnace.output);
		return {
			id: uuid(), type: 'furnace', identifier, grid: new Array(9).fill(null), ingredients: [],
			input: inputIdent ? resolveItemId(inputIdent) : null,
			output: outputIdent ? resolveItemId(outputIdent) : null,
			furnaceTag: tag, resultId: null, resultCount: 1,
			sourceFile: path, sourcePackIndex: packIndex, preserveIdentifier: true
		};
	}

	return null;
}

// ---- Recipe parsing (Java data packs) ----

const JAVA_COOKING_TYPE_TO_TAG: Record<string, FurnaceTag> = {
	'minecraft:smelting': 'furnace',
	'minecraft:blasting': 'blast_furnace',
	'minecraft:smoking': 'smoker',
	'minecraft:campfire_cooking': 'campfire',
};

export function isDataPackRecipePath(p: string): boolean {
	return /(^|\/)data\/[^/]+\/recipes?\/([^/]+)\.json$/i.test(normalizePath(p));
}

function dataPackIdentifierFromPath(path: string): string {
	const m = normalizePath(path).match(/(^|\/)data\/([^/]+)\/recipes?\/([^/]+)\.json$/i);
	if (m) return sanitizeName(m[2]) + ':' + sanitizeName(m[3]);
	return fallbackIdentifier(path);
}

function parseDataPackRecipeFile(path: string, text: string): RecipeState | null {
	const data = parseJsonText(text);
	if (!data || typeof data !== 'object') return null;
	const type = typeof data.type === 'string' ? data.type : '';
	const identifier = dataPackIdentifierFromPath(path);

	if (type === 'minecraft:crafting_shaped') {
		const grid: (number | null)[] = new Array(9).fill(null);
		const pattern = Array.isArray(data.pattern) ? data.pattern : [];
		const key = data.key || {};
		for (let row = 0; row < Math.min(pattern.length, 3); row++) {
			const line = String(pattern[row] || '');
			for (let c = 0; c < Math.min(line.length, 3); c++) {
				const ch = line[c];
				if (!ch || ch === ' ') continue;
				const ident = extractItemIdentifier(key[ch]);
				if (ident) grid[row * 3 + c] = resolveItemId(ident);
			}
		}
		const res = resolveResult(data.result);
		return {
			id: uuid(), type: 'shaped', identifier, grid, ingredients: [], input: null, output: null,
			furnaceTag: 'furnace', resultId: res.id, resultCount: res.count,
			sourceFile: path, preserveIdentifier: true
		};
	}

	if (type === 'minecraft:crafting_shapeless') {
		const ingredients = Array.isArray(data.ingredients)
			? data.ingredients
				.map((ing: any) => extractItemIdentifier(ing))
				.filter((x: string | null): x is string => !!x)
				.map(resolveItemId)
			: [];
		const res = resolveResult(data.result);
		return {
			id: uuid(), type: 'shapeless', identifier, grid: new Array(9).fill(null), ingredients,
			input: null, output: null, furnaceTag: 'furnace', resultId: res.id, resultCount: res.count,
			sourceFile: path, preserveIdentifier: true
		};
	}

	const tag = JAVA_COOKING_TYPE_TO_TAG[type];
	if (tag) {
		const inputIdent = extractItemIdentifier(data.ingredient);
		const res = resolveResult(data.result);
		return {
			id: uuid(), type: 'furnace', identifier, grid: new Array(9).fill(null), ingredients: [],
			input: inputIdent ? resolveItemId(inputIdent) : null,
			output: res.id, furnaceTag: tag, resultId: null, resultCount: 1,
			sourceFile: path, preserveIdentifier: true
		};
	}

	return null;
}

// ---- Import handlers ----

async function handleDataPackImport(file: File): Promise<void> {
	const t = translations[currentLang];
	const status = document.getElementById('status');
	const showError = (msg: string) => {
		if (status) status.innerHTML = `<div class="status-card error"><p class="error" style="margin:0">${msg}</p></div>`;
	};

	if (!file) return;

	try {
		const buffer = new Uint8Array(await file.arrayBuffer());
		const entries = safeUnzip(buffer);
		if (!entries) {
			showError(t.importError);
			return;
		}

		const mcmetaPath = [...entries.keys()].find((p) => p.split('/').pop()?.toLowerCase() === 'pack.mcmeta');
		if (!mcmetaPath) {
			showError(t.importError);
			return;
		}

		const mcmeta = parseJsonText(decodeUtf8Sig(entries.get(mcmetaPath)!));
		const root = mcmetaPath.replace(/pack\.mcmeta$/i, '');
		const files = new Map<string, Uint8Array>();
		for (const [p, b] of entries) {
			if (p.startsWith(root)) files.set(p.slice(root.length).replace(/^\/+/, ''), b);
		}
		const recipeFiles = [...files.keys()].filter(isDataPackRecipePath);

		revokeImportedUrls();
		setImportedDataPack({ mcmeta, files, recipeFiles });
		setImportedPacks([]);
		setImportedSourceName(file.name);
		resetCustomItems();
		setRecipes([]);

		let count = 0;
		for (const rp of recipeFiles) {
			const bytes = files.get(rp);
			if (!bytes) continue;
			const recipe = parseDataPackRecipeFile(rp, decodeUtf8Sig(bytes));
			if (recipe) {
				recipes.push(recipe);
				count++;
			}
		}

		// Reflect the pack description + pack_format in the UI.
		if (mcmeta?.pack?.description && typeof mcmeta.pack.description === 'string') {
			setPackName(mcmeta.pack.description);
			const input = document.getElementById('packNameInput') as HTMLInputElement | null;
			if (input) input.value = packName;
		}
		if (mcmeta?.pack?.pack_format != null && Number.isFinite(Number(mcmeta.pack.pack_format))) {
			setJavaPackFormat(Number(mcmeta.pack.pack_format));
			const sel = document.getElementById('versionSelect') as HTMLSelectElement | null;
			if (sel) {
				if (![...sel.options].some((o) => Number(o.value) === javaPackFormat)) {
					const opt = document.createElement('option');
					opt.value = String(javaPackFormat);
					opt.dataset.imported = '1';
					opt.textContent = `${currentLang === 'es' ? 'Importado' : 'Imported'} (${javaPackFormat})`;
					sel.appendChild(opt);
				}
				sel.value = String(javaPackFormat);
			}
		}

		setSelectedIndex(0);
		setIdentifierManuallyEdited(true);
		renderRecipeList();
		renderEditor();

		if (status) {
			const noRecipesNote = count === 0 ? `<p class="link-note" style="margin:0">${t.importNoRecipesJava}</p>` : '';
			status.innerHTML = `
				<div class="status-card success">
					<p class="success" style="margin:0 0 4px">${t.importSuccessJava} ${escapeHtml(file.name)}</p>
					<p class="link-note" style="margin:0">${escapeHtml(String(count))} ${t.recipesCount}</p>
					${noRecipesNote}
				</div>
			`;
		}
	} catch (err) {
		console.error('Data pack import failed:', err);
		showError(t.importError);
	}
}

export async function handleImport(file: File): Promise<void> {
	if (platform === 'java') await handleDataPackImport(file);
	else await handleImportFile(file);
}

function collectPack(files: Map<string, Uint8Array>, archivePath: string, packs: ImportedPack[]): void {
	const normalized = new Map<string, Uint8Array>();
	for (const [p, b] of files) {
		const clean = sanitizeZipPath(normalizePath(p));
		if (clean) normalized.set(clean, b);
	}

	const manifestPath = [...normalized.keys()].find((p) => p.split('/').pop()?.toLowerCase() === 'manifest.json');
	if (!manifestPath) return;
	const manifest = parseJsonText(decodeUtf8Sig(normalized.get(manifestPath)!));
	const type = manifestPackType(manifest);
	if (!type) return;

	const root = manifestPath.replace(/manifest\.json$/i, '');
	const packFiles = new Map<string, Uint8Array>();
	for (const [p, b] of normalized) {
		if (p.startsWith(root)) packFiles.set(p.slice(root.length).replace(/^\/+/, ''), b);
	}
	const recipeFiles = [...packFiles.keys()].filter(isRecipePath);
	packs.push({ type, manifest, files: packFiles, archivePath, recipeFiles });
}

function extractPacks(buffer: Uint8Array): ImportedPack[] {
	const packs: ImportedPack[] = [];
	const top = safeUnzip(buffer);
	if (!top) return packs;

	// Nested .mcpack files (a .mcaddon bundles one per pack).
	for (const [p, b] of top) {
		if (p.toLowerCase().endsWith('.mcpack')) {
			const inner = safeUnzip(b);
			if (!inner) continue;
			collectPack(inner, p, packs);
		}
	}
	// Bare pack (the imported file is itself a .mcpack).
	collectPack(top, '', packs);
	return packs;
}

async function handleImportFile(file: File): Promise<void> {
	const t = translations[currentLang];
	const status = document.getElementById('status');
	const showError = (msg: string) => {
		if (status) status.innerHTML = `<div class="status-card error"><p class="error" style="margin:0">${msg}</p></div>`;
	};

	if (!file) return;

	try {
		const buffer = new Uint8Array(await file.arrayBuffer());
		const packs = extractPacks(buffer);
		if (packs.length === 0) {
			showError(t.importError);
			return;
		}

		revokeImportedUrls();
		setImportedPacks(packs);
		setImportedDataPack(null);
		setImportedSourceName(file.name);
		resetCustomItems();
		setRecipes([]);

		const behaviorPacks = packs.filter((p) => p.type === 'behavior');
		const resourcePacks = packs.filter((p) => p.type === 'resource');
		const itemAtlas = buildAtlas(resourcePacks, ['textures/item_texture.json']);
		const blockAtlas = buildAtlas(resourcePacks, ['textures/terrain_texture.json']);

		for (const pack of behaviorPacks) {
			parseCustomDefinitions(pack, itemAtlas, blockAtlas, resourcePacks);
		}

		let count = 0;
		for (let i = 0; i < packs.length; i++) {
			const pack = packs[i];
			if (pack.type !== 'behavior') continue;
			for (const rp of pack.recipeFiles) {
				const bytes = pack.files.get(rp);
				if (!bytes) continue;
				const recipe = parseRecipeFile(rp, decodeUtf8Sig(bytes), i);
				if (recipe) {
					recipes.push(recipe);
					count++;
				}
			}
		}

		// Reflect the behavior pack name in the pack name field.
		const bp = behaviorPacks[0];
		if (bp && bp.manifest?.header?.name) {
			setPackName(bp.manifest.header.name);
			const input = document.getElementById('packNameInput') as HTMLInputElement | null;
			if (input) input.value = packName;
		}

		setSelectedIndex(0);
		setIdentifierManuallyEdited(true);
		renderRecipeList();
		renderEditor();

		if (status) {
			const meta = `${escapeHtml(String(count))} ${t.recipesCount} · ${escapeHtml(String(customItems.length))} ${t.importedMeta}`;
			const noRecipesNote = count === 0 ? `<p class="link-note" style="margin:0">${t.importNoRecipes}</p>` : '';
			status.innerHTML = `
				<div class="status-card success">
					<p class="success" style="margin:0 0 4px">${t.importSuccess} ${escapeHtml(file.name)}</p>
					<p class="link-note" style="margin:0">${meta}</p>
					${noRecipesNote}
				</div>
			`;
		}
	} catch (err) {
		console.error('Import failed:', err);
		showError(t.importError);
	}
}
