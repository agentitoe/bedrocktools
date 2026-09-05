import { zipSync } from 'fflate';
import type { FurnaceTag, ImportedPack, RecipeState } from './types';
import { translations } from './translations';
import { importedPacks, importedDataPack, packName, recipes, currentLang, platform, javaPackFormat } from './state';
import { getItemById, getItemIdentifier } from './items';
import { uuid, sanitizeName, escapeHtml, strToU8, toBlob, isValidIdentifier } from './util';
import { recipeShortName } from './editor';
import { isRecipePath, isDataPackRecipePath } from './import';

// ---- Identifier helpers ----

function itemIdentifier(id: number | null): string | null {
	if (id == null) return null;
	const item = getItemById(id);
	if (!item) return null;
	return getItemIdentifier(item);
}

/**
 * Fallback used when a numeric ingredient id no longer resolves to an item
 * (e.g. its custom item was dropped). Guarantees exported JSON never contains
 * `{ "item": null }`; every substitution is logged as a warning.
 */
const FALLBACK_ITEM = 'minecraft:stone';

function safeItemIdentifier(id: number | null): string {
	const ident = itemIdentifier(id);
	if (ident) return ident;
	if (typeof console !== 'undefined' && typeof console.warn === 'function') {
		console.warn(`[recipe-creator] Unknown item id ${String(id)}; using fallback ${FALLBACK_ITEM}`);
	}
	return FALLBACK_ITEM;
}

// ---- Bedrock (addon .mcpack) ----

function buildShapedLayout(r: RecipeState): { pattern: string[]; charToItemId: Map<string, number> } | null {
	const letters = 'ABCDEFGHIJ';
	const charByItem = new Map<number, string>();
	let next = 0;
	const cells = r.grid.map((id) => {
		if (id == null) return ' ';
		let ch = charByItem.get(id);
		if (!ch) {
			ch = letters[next++];
			charByItem.set(id, ch);
		}
		return ch;
	});

	let minR = 3, maxR = -1, minC = 3, maxC = -1;
	for (let row = 0; row < 3; row++) {
		for (let c = 0; c < 3; c++) {
			if (cells[row * 3 + c] !== ' ') {
				if (row < minR) minR = row;
				if (row > maxR) maxR = row;
				if (c < minC) minC = c;
				if (c > maxC) maxC = c;
			}
		}
	}
	if (maxR < 0) return null;

	const pattern: string[] = [];
	for (let row = minR; row <= maxR; row++) {
		let line = '';
		for (let c = minC; c <= maxC; c++) line += cells[row * 3 + c];
		pattern.push(line);
	}

	const charToItemId = new Map<string, number>();
	for (const [id, ch] of charByItem) charToItemId.set(ch, id);
	return { pattern, charToItemId };
}

/** Result descriptor: always an item object (count omitted when 1, matching vanilla). */
function resultDescriptor(id: number | null, count: number): { item: string; count?: number } | null {
	const item = itemIdentifier(id);
	if (!item) return null;
	return count > 1 ? { item, count } : { item };
}

function recipeFilename(r: RecipeState): string {
	return sanitizeName(r.identifier.replace(':', '_')) + '.json';
}

function buildRecipeJSON(r: RecipeState): { filename: string; json: object } | { error: string } {
	const t = translations[currentLang];

	if (r.type === 'shaped') {
		if (r.resultId == null) return { error: t.errorNoResult };
		const shaped = buildShapedLayout(r);
		if (!shaped) return { error: t.errorNoIngredients };
		// Bedrock 1.20.10 expects item objects here (vanilla recipe files use { "item": ... }).
		// Unresolvable ids fall back to stone (warned) instead of emitting { "item": null }.
		const key: Record<string, { item: string }> = {};
		for (const [ch, id] of shaped.charToItemId) key[ch] = { item: safeItemIdentifier(id) };
		return {
			filename: recipeFilename(r),
			json: {
				format_version: '1.20.10',
				'minecraft:recipe_shaped': {
					description: { identifier: r.identifier },
					tags: ['crafting_table'],
					pattern: shaped.pattern,
					key,
					unlock: { context: 'AlwaysUnlocked' },
					result: resultDescriptor(r.resultId, r.resultCount)
				}
			}
		};
	}

	if (r.type === 'shapeless') {
		if (r.resultId == null) return { error: t.errorNoResult };
		if (r.ingredients.length === 0) return { error: t.errorNoIngredients };
		return {
			filename: recipeFilename(r),
			json: {
				format_version: '1.20.10',
				'minecraft:recipe_shapeless': {
					description: { identifier: r.identifier },
					tags: ['crafting_table'],
					ingredients: r.ingredients.map((id) => ({ item: safeItemIdentifier(id) })),
					unlock: { context: 'AlwaysUnlocked' },
					result: resultDescriptor(r.resultId, r.resultCount)
				}
			}
		};
	}

	// furnace
	if (r.input == null) return { error: t.errorNoInput };
	if (r.output == null) return { error: t.errorNoOutput };
	const furnaceInput = itemIdentifier(r.input);
	if (!furnaceInput) return { error: t.errorNoInput };
	const furnaceOutput = itemIdentifier(r.output);
	if (!furnaceOutput) return { error: t.errorNoOutput };
	return {
		filename: recipeFilename(r),
		json: {
			format_version: '1.20.10',
			'minecraft:recipe_furnace': {
				description: { identifier: r.identifier },
				tags: [r.furnaceTag],
				input: furnaceInput,
				output: furnaceOutput
			}
		}
	};
}

// ---- Java Edition (data pack) ----

const JAVA_COOKING: Record<FurnaceTag, { type: string; cookingtime: number }> = {
	furnace: { type: 'minecraft:smelting', cookingtime: 200 },
	blast_furnace: { type: 'minecraft:blasting', cookingtime: 100 },
	smoker: { type: 'minecraft:smoking', cookingtime: 100 },
	campfire: { type: 'minecraft:campfire_cooking', cookingtime: 600 },
};

// Recent Java versions that share the modern recipe format (string ingredients
// + `id` results); only the pack_format number differs between them.
const JAVA_VERSIONS: { label: string; format: number }[] = [
	{ label: '1.21.5+', format: 71 },
	{ label: '1.21.4', format: 61 },
	{ label: '1.21.2 – 1.21.3', format: 57 },
	{ label: '1.21 – 1.21.1', format: 48 },
];

export { JAVA_VERSIONS };

function recipeNamespaceAndName(identifier: string): { ns: string; name: string } {
	const idx = identifier.indexOf(':');
	const ns = idx >= 0 ? identifier.slice(0, idx) : 'custom';
	const name = idx >= 0 ? identifier.slice(idx + 1) : identifier;
	return { ns: sanitizeName(ns) || 'custom', name: sanitizeName(name) || 'recipe' };
}

function javaRecipePath(identifier: string): string {
	const { ns, name } = recipeNamespaceAndName(identifier);
	return `data/${ns}/recipe/${name}.json`;
}

function javaResultDescriptor(id: number | null, count?: number): { id: string; count?: number } | null {
	const item = itemIdentifier(id);
	if (!item) return null;
	return count != null && count > 1 ? { id: item, count } : { id: item };
}

function buildJavaRecipeJSON(r: RecipeState): { filename: string; json: object } | { error: string } {
	const t = translations[currentLang];
	const filename = javaRecipePath(r.identifier);

	if (r.type === 'shaped') {
		if (r.resultId == null) return { error: t.errorNoResult };
		const shaped = buildShapedLayout(r);
		if (!shaped) return { error: t.errorNoIngredients };
		const key: Record<string, string> = {};
		for (const [ch, id] of shaped.charToItemId) key[ch] = safeItemIdentifier(id);
		const result = javaResultDescriptor(r.resultId, r.resultCount);
		if (!result) return { error: t.errorNoResult };
		return {
			filename,
			json: {
				type: 'minecraft:crafting_shaped',
				pattern: shaped.pattern,
				key,
				result
			}
		};
	}

	if (r.type === 'shapeless') {
		if (r.resultId == null) return { error: t.errorNoResult };
		if (r.ingredients.length === 0) return { error: t.errorNoIngredients };
		const result = javaResultDescriptor(r.resultId, r.resultCount);
		if (!result) return { error: t.errorNoResult };
		return {
			filename,
			json: {
				type: 'minecraft:crafting_shapeless',
				ingredients: r.ingredients.map((id) => safeItemIdentifier(id)),
				result
			}
		};
	}

	// furnace → smelting / blasting / smoking / campfire_cooking
	if (r.input == null) return { error: t.errorNoInput };
	if (r.output == null) return { error: t.errorNoOutput };
	const cooking = JAVA_COOKING[r.furnaceTag];
	const javaInput = itemIdentifier(r.input);
	if (!javaInput) return { error: t.errorNoInput };
	const result = javaResultDescriptor(r.output);
	if (!result) return { error: t.errorNoOutput };
	return {
		filename,
		json: {
			type: cooking.type,
			ingredient: javaInput,
			result,
			experience: 0.1,
			cookingtime: cooking.cookingtime
		}
	};
}

function buildPackMcmeta(): object {
	return {
		pack: {
			pack_format: javaPackFormat,
			description: packName
		}
	};
}

function buildManifest(): object {
	return {
		format_version: 2,
		header: {
			name: packName,
			description: 'Recetas creadas con Bedrock Tools',
			uuid: uuid(),
			version: [1, 0, 0],
			min_engine_version: [1, 20, 10]
		},
		modules: [
			{
				type: 'data',
				uuid: uuid(),
				version: [1, 0, 0]
			}
		],
		// "addon" keeps achievements enabled (same as the addon-converter tool).
		metadata: {
			product_type: 'addon'
		}
	};
}

// Cached pack icon (success only — failures retry on the next export).
let packIconCache: Uint8Array | null = null;
async function getPackIcon(): Promise<Uint8Array | null> {
	if (packIconCache) return packIconCache;
	try {
		const res = await fetch('/assets/pack-icon.png');
		if (!res.ok) return null;
		const buf = await res.arrayBuffer();
		if (!buf || buf.byteLength === 0) return null;
		packIconCache = new Uint8Array(buf);
		return packIconCache;
	} catch {
		return null;
	}
}

// ---- Round-trip (repackage an imported addon / data pack with edited recipes) ----

function behaviorPackIndexes(): number[] {
	const idx: number[] = [];
	importedPacks.forEach((p, i) => {
		if (p.type === 'behavior') idx.push(i);
	});
	return idx;
}

/** Return the index of a behavior pack, creating a fresh one if none exists. */
function ensureBehaviorPack(): number {
	const existing = behaviorPackIndexes();
	if (existing.length > 0) return existing[0];
	const pack: ImportedPack = {
		type: 'behavior',
		manifest: buildManifest(),
		files: new Map(),
		archivePath: '',
		recipeFiles: []
	};
	importedPacks.push(pack);
	return importedPacks.length - 1;
}

type BuiltRecipe = { r: RecipeState; json: object; filename: string };

/** Rebuild the whole imported addon, swapping in the edited recipes. */
function assembleRoundTrip(
	built: BuiltRecipe[]
): { archive: Uint8Array; downloadName: string } {
	// Group recipes by their target behavior pack.
	const recipeByPack = new Map<number, BuiltRecipe[]>();
	for (const b of built) {
		let idx = b.r.sourcePackIndex;
		if (idx == null || idx >= importedPacks.length || importedPacks[idx].type !== 'behavior') {
			idx = ensureBehaviorPack();
		}
		if (!recipeByPack.has(idx)) recipeByPack.set(idx, []);
		recipeByPack.get(idx)!.push(b);
	}

	const packZips: { path: string; bytes: Uint8Array }[] = [];
	for (let i = 0; i < importedPacks.length; i++) {
		const pack = importedPacks[i];
		const files: Record<string, Uint8Array> = {};

		// Copy original files, dropping managed recipe files (re-added below).
		for (const [p, b] of pack.files) {
			if (pack.type === 'behavior' && isRecipePath(p)) continue;
			files[p] = b;
		}

		// Write the edited/new recipes for this pack.
		if (pack.type === 'behavior') {
			const list = recipeByPack.get(i) || [];
			const used = new Set<string>();
			for (const b of list) {
				let filename = b.filename;
				let n = 1;
				while (used.has(`recipes/${filename}`) || files[`recipes/${filename}`] != null) {
					filename = b.filename.replace(/\.json$/, `_${n}.json`);
					n++;
				}
				used.add(`recipes/${filename}`);
				files[`recipes/${filename}`] = strToU8(JSON.stringify(b.json, null, 2));
			}
		}

		// Update the manifest: keep achievements enabled, honor the pack name.
		const next: any = pack.manifest && typeof pack.manifest === 'object'
			? JSON.parse(JSON.stringify(pack.manifest))
			: {};
		if (!next.metadata || typeof next.metadata !== 'object') next.metadata = {};
		next.metadata.product_type = 'addon';
		if (pack.type === 'behavior') {
			if (!next.header || typeof next.header !== 'object') next.header = {};
			next.header.name = packName;
		}
		files['manifest.json'] = strToU8(JSON.stringify(next, null, 2));

		packZips.push({ path: pack.archivePath, bytes: zipSync(files, { level: 6 }) });
	}

	// A single bare pack stays a .mcpack; anything else becomes a .mcaddon.
	if (packZips.length === 1 && packZips[0].path === '') {
		return {
			archive: packZips[0].bytes,
			downloadName: (sanitizeName(packName) || 'addon') + '.mcpack'
		};
	}

	const outer: Record<string, Uint8Array> = {};
	const usedOuter = new Set<string>();
	for (const p of packZips) {
		let name = p.path || (usedOuter.size === 0 ? 'behavior_pack.mcpack' : 'resource_pack.mcpack');
		if (!/\.mcpack$/i.test(name)) name += '.mcpack';
		let candidate = name;
		let n = 1;
		while (usedOuter.has(candidate)) {
			candidate = name.replace(/\.mcpack$/i, `_${n}.mcpack`);
			n++;
		}
		usedOuter.add(candidate);
		outer[candidate] = p.bytes;
	}
	return {
		archive: zipSync(outer, { level: 6 }),
		downloadName: (sanitizeName(packName) || 'addon') + '.mcaddon'
	};
}

/** Rebuild the imported data pack, swapping in the edited recipes and keeping everything else. */
function assembleDataPackRoundTrip(built: BuiltRecipe[]): { archive: Uint8Array; downloadName: string } {
	const pack = importedDataPack!;
	const files: Record<string, Uint8Array> = {};

	// Copy every original file, dropping managed recipe files (re-added below).
	for (const [p, b] of pack.files) {
		if (isDataPackRecipePath(p)) continue;
		files[p] = b;
	}

	// Write the edited/new recipes.
	const used = new Set<string>();
	for (const b of built) {
		let path = b.filename;
		let n = 1;
		while (used.has(path) || files[path] != null) {
			path = b.filename.replace(/\.json$/, `_${n}.json`);
			n++;
		}
		used.add(path);
		files[path] = strToU8(JSON.stringify(b.json, null, 2));
	}

	// Update pack.mcmeta: honor the version selector + refresh the description.
	const mcmeta: any = pack.mcmeta && typeof pack.mcmeta === 'object'
		? JSON.parse(JSON.stringify(pack.mcmeta))
		: {};
	if (!mcmeta.pack || typeof mcmeta.pack !== 'object') mcmeta.pack = {};
	mcmeta.pack.pack_format = javaPackFormat;
	mcmeta.pack.description = packName;
	files['pack.mcmeta'] = strToU8(JSON.stringify(mcmeta, null, 2));

	return {
		archive: zipSync(files, { level: 6 }),
		downloadName: (sanitizeName(packName) || 'data-pack') + '.zip'
	};
}

// ---- Export entry points ----

function buildAllRecipes(
	buildJson: (r: RecipeState) => { filename: string; json: object } | { error: string }
): { ok: true; built: BuiltRecipe[] } | { ok: false; error: string } {
	const t = translations[currentLang];
	if (recipes.length === 0) return { ok: false, error: t.errorNoRecipes };
	const built: BuiltRecipe[] = [];
	const usedIdentifiers = new Set<string>();
	for (let i = 0; i < recipes.length; i++) {
		const r = recipes[i];
		const short = recipeShortName(r, i);
		if (!isValidIdentifier(r.identifier)) {
			return { ok: false, error: `<strong>${escapeHtml(short)}</strong>: ${t.errorBadIdentifier}` };
		}
		if (usedIdentifiers.has(r.identifier)) {
			return { ok: false, error: `<strong>${escapeHtml(short)}</strong>: ${t.errorDuplicateIdentifier}` };
		}
		usedIdentifiers.add(r.identifier);
		const result = buildJson(r);
		if ('error' in result) {
			return { ok: false, error: `<strong>${escapeHtml(short)}</strong>: ${result.error}` };
		}
		built.push({ r, json: result.json, filename: result.filename });
	}
	return { ok: true, built };
}

function triggerDownload(archive: Uint8Array, downloadName: string, mime: string) {
	const blob = toBlob(archive, mime);
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = downloadName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportDataPack() {
	const t = translations[currentLang];
	const status = document.getElementById('status');
	if (!status) return;
	const showError = (msg: string) => {
		status.innerHTML = `<div class="status-card error"><p class="error" style="margin:0">${msg}</p></div>`;
	};

	const result = buildAllRecipes(buildJavaRecipeJSON);
	if (!result.ok) {
		showError(result.error);
		return;
	}

	let archive: Uint8Array;
	let downloadName: string;

	if (importedDataPack) {
		// Round-trip the imported data pack with the edited recipes.
		const rt = assembleDataPackRoundTrip(result.built);
		archive = rt.archive;
		downloadName = rt.downloadName;
	} else {
		const files: Record<string, Uint8Array> = {};
		const usedPaths = new Set<string>();
		for (const b of result.built) {
			let path = b.filename;
			let n = 1;
			while (usedPaths.has(path)) {
				path = b.filename.replace(/\.json$/, `_${n}.json`);
				n++;
			}
			usedPaths.add(path);
			files[path] = strToU8(JSON.stringify(b.json, null, 2));
		}
		files['pack.mcmeta'] = strToU8(JSON.stringify(buildPackMcmeta(), null, 2));
		archive = zipSync(files, { level: 6 });
		downloadName = (sanitizeName(packName) || 'data-pack') + '.zip';
	}

	triggerDownload(archive, downloadName, 'application/zip');

	status.innerHTML = `
		<div class="status-card success">
			<p class="success" style="margin:0 0 4px">${t.successPrefix} ${escapeHtml(downloadName)}</p>
			<p class="link-note" style="margin:0">${escapeHtml(String(recipes.length))} ${t.recipesCount} · ${t.linkNote}</p>
			<p class="link-note" style="margin:0">${t.recipeFileNoteJava}</p>
		</div>
	`;
}

export async function exportMcpack() {
	const t = translations[currentLang];
	const status = document.getElementById('status');
	if (!status) return;

	// Java recipes are exported as a data pack instead.
	if (platform === 'java') {
		await exportDataPack();
		return;
	}

	const showError = (msg: string) => {
		status.innerHTML = `<div class="status-card error"><p class="error" style="margin:0">${msg}</p></div>`;
	};

	const result = buildAllRecipes(buildRecipeJSON);
	if (!result.ok) {
		showError(result.error);
		return;
	}
	const built = result.built;

	let archive: Uint8Array;
	let downloadName: string;

	if (importedPacks.length > 0) {
		// Round-trip the imported addon with the edited recipes.
		const roundTrip = assembleRoundTrip(built);
		archive = roundTrip.archive;
		downloadName = roundTrip.downloadName;
	} else {
		const files: Record<string, Uint8Array> = {};
		const usedFilenames = new Set<string>();
		for (const b of built) {
			let filename = b.filename;
			let n = 1;
			while (usedFilenames.has(`recipes/${filename}`)) {
				filename = b.filename.replace(/\.json$/, `_${n}.json`);
				n++;
			}
			usedFilenames.add(`recipes/${filename}`);
			files[`recipes/${filename}`] = strToU8(JSON.stringify(b.json, null, 2));
		}
		const icon = await getPackIcon();
		if (icon) files['pack_icon.png'] = icon;
		files['manifest.json'] = strToU8(JSON.stringify(buildManifest(), null, 2));
		archive = zipSync(files, { level: 6 });
		downloadName = (sanitizeName(packName) || 'recipes') + '.mcpack';
	}

	triggerDownload(archive, downloadName, 'application/octet-stream');

	status.innerHTML = `
		<div class="status-card success">
			<p class="success" style="margin:0 0 4px">${t.successPrefix} ${escapeHtml(downloadName)}</p>
			<p class="link-note" style="margin:0">${escapeHtml(String(recipes.length))} ${t.recipesCount} · ${t.linkNote}</p>
			<p class="link-note" style="margin:0">${t.recipeFileNote}</p>
		</div>
	`;
}
