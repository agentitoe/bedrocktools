// Build script to extract Minecraft data for items and blocks
// Run this before building to generate JSON data files.
// Then run scripts/translate-items.mjs to add Spanish display names.

import minecraftData from 'minecraft-data';
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import {
	buildBannerModel,
	buildBedModel,
	buildChestModel,
	buildDecoratedPotModel,
	buildGolemStatueModel,
	buildHeadModel,
	buildShieldModel,
	DRAGON_HEAD_REGIONS,
	HEAD_REGIONS
} from './special-blocks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const publicDir = join(root, 'public');
const dataDir = join(publicDir, 'data');
const texturesDir = join(publicDir, 'textures');

// Use InventivetalentDev/minecraft-assets branch 26.3 for models and textures.
// The branch is the single source of truth: item catalog (items/_all.json),
// block/item models, textures, vanilla recipe JSONs and item tags.
// (minecraft-data's newest *published data* is 26.1, so it is only used below
// as a fallback for display names and stack sizes, never as the catalog.)
const MC_VERSION = '26.3';
const ASSET_BASE = `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${MC_VERSION}/assets/minecraft`;
const MODEL_BASE = `${ASSET_BASE}/models`;        // models/block, models/item
const ITEMS_BASE = `${ASSET_BASE}/items`;         // item model definitions (_all.json = full catalog)
const BLOCKS_TEXTURE_BASE = `${ASSET_BASE}/textures/block`;
const ITEMS_TEXTURE_BASE = `${ASSET_BASE}/textures/item`;
const ENTITY_TEXTURE_BASE = `${ASSET_BASE}/textures/entity`;
const DATA_BASE = `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${MC_VERSION}/data/minecraft`;
const RECIPE_BASE = `${DATA_BASE}/recipe`;
const ITEM_TAG_BASE = `${DATA_BASE}/tags/item`;
// generatePotions() assigns synthetic potion ids starting here; vanilla item
// ids must stay below this bound so the two spaces never collide.
const POTION_ID_BASE = 900000;

// Bun uses its own HTTP client with built-in pooling
const FETCH_OPTS = { headers: { 'Accept': 'application/json, image/png' } };

// Caches to avoid redundant work
const modelCache = new Map();      // key: `${kind}:${name}` -> model JSON (or null)
const itemDefCache = new Map();    // key: item name -> items/*.json (or null)

// The 16 Minecraft dye colors, used to tint banners (banner_base.png is white).
const BANNER_COLORS = {
	white: '#F9FFFE', orange: '#F9801D', magenta: '#C74EBD', light_blue: '#3AB3DA',
	yellow: '#FED83D', lime: '#80C71F', pink: '#F38BAA', gray: '#474F52',
	light_gray: '#9D9D97', cyan: '#169C9C', purple: '#8932B8', blue: '#3C44AA',
	brown: '#835432', green: '#5E7C16', red: '#B02E26', black: '#1D1D21'
};

// Remote skin texture for each `minecraft:head` / `minecraft:player_head` kind.
const HEAD_SKINS = {
	skeleton: 'textures/entity/skeleton/skeleton.png',
	wither_skeleton: 'textures/entity/skeleton/wither_skeleton.png',
	zombie: 'textures/entity/zombie/zombie.png',
	creeper: 'textures/entity/creeper/creeper.png',
	piglin: 'textures/entity/piglin/piglin.png',
	dragon: 'textures/entity/enderdragon/dragon.png',
	player: 'textures/entity/player/wide/steve.png'
};

async function fetchJson(url) {
	try {
		const res = await fetch(url, FETCH_OPTS);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function fetchModel(name, kind = 'block') {
	const key = `${kind}:${name}`;
	if (modelCache.has(key)) return modelCache.get(key);
	const data = await fetchJson(`${MODEL_BASE}/${kind}/${name}.json`);
	modelCache.set(key, data);
	return data;
}

async function fetchItemDefinition(name) {
	if (itemDefCache.has(name)) return itemDefCache.get(name);
	const data = await fetchJson(`${ITEMS_BASE}/${name}.json`);
	itemDefCache.set(name, data);
	return data;
}

/** Strip the namespace/folder prefix from a model parent reference. */
function stripModelPrefix(parent) {
	return parent
		.replace('minecraft:block/', '')
		.replace('minecraft:item/', '')
		.replace('block/', '')
		.replace('item/', '');
}

/** Determine the model kind (block|item) a parent reference points at, or null. */
function parentKind(parent) {
	if (parent.includes('block/')) return 'block';
	if (parent.includes('item/')) return 'item';
	return null;
}

/**
 * Detect `minecraft:special` models we support: heads, beds, banners, shields.
 * These have no regular geometry/texture map; they use special renderers or a
 * dedicated flat texture. Returns a resolved-info object or null.
 */
function detectSpecialModel(model) {
	if (!model || typeof model !== 'object') return null;
	switch (model.type) {
		case 'minecraft:special': {
			const inner = model.model;
			if (!inner || typeof inner !== 'object') return null;
			switch (inner.type) {
				case 'minecraft:head':
					return { renderAs: 'head', kind: inner.kind || 'skeleton' };
				case 'minecraft:player_head':
					return { renderAs: 'head', kind: 'player' };
				case 'minecraft:bed': {
					const color = String(inner.texture || 'white').replace('minecraft:', '');
					return { renderAs: 'bed', color };
				}
				case 'minecraft:banner':
					return { renderAs: 'banner', color: inner.color || 'white' };
				case 'minecraft:shield':
					return { renderAs: 'shield' };
				case 'minecraft:chest':
					return { renderAs: 'chest', texture: String(inner.texture || 'normal') };
				case 'minecraft:copper_golem_statue':
					return { renderAs: 'golem_statue', texture: String(inner.texture || '') };
				case 'minecraft:decorated_pot':
					return { renderAs: 'decorated_pot' };
				default:
					return null;
			}
		}
		case 'minecraft:composite':
			for (const m of model.models || []) {
				const s = detectSpecialModel(m);
				if (s) return s;
			}
			return null;
		case 'minecraft:condition':
			return detectSpecialModel(model.on_false) || detectSpecialModel(model.on_true);
		case 'minecraft:select':
			return detectSpecialModel(model.fallback) ||
				(model.cases || []).map((c) => detectSpecialModel(c.model)).find(Boolean) ||
				null;
		default:
			return null;
	}
}

/**
 * Resolve a 26.1 item model "model" dispatch object to a concrete model
 * location string ("minecraft:block/foo" or "minecraft:item/foo"), or null.
 */
function resolveItemModelRef(model) {
	if (!model || typeof model !== 'object') return null;
	switch (model.type) {
		case 'minecraft:model':
			return model.model || null;
		case 'minecraft:composite':
			return resolveItemModelRef(model.models?.[0]);
		case 'minecraft:condition':
			return resolveItemModelRef(model.on_false) || resolveItemModelRef(model.on_true);
		case 'minecraft:range_dispatch':
			return resolveItemModelRef(model.entries?.[0]?.model) || resolveItemModelRef(model.fallback);
		case 'minecraft:select':
			return resolveItemModelRef(model.fallback) || resolveItemModelRef(model.cases?.[0]?.model);
		case 'minecraft:special':
			return model.base || null;
		default:
			return null;
	}
}

/**
 * Extract texture references from a model's textures map. Handles both the
 * legacy string form ("minecraft:block/foo") and the new sprite object form
 * ({ "sprite": "minecraft:block/foo", ... }).
 */
function extractModelTextureRefs(textures) {
	const refs = [];
	for (const value of Object.values(textures || {})) {
		if (typeof value === 'string' && !value.startsWith('#')) refs.push(value);
		else if (value && typeof value === 'object' && typeof value.sprite === 'string') refs.push(value.sprite);
	}
	return refs;
}

/** Parse a texture reference into its namespace ("block"|"item") and bare name. */
function parseTextureRef(ref) {
	const m = ref.match(/^(?:minecraft:)?(block|item)\/(.+)$/);
	if (m) return { namespace: m[1], name: m[2] };
	return { namespace: 'block', name: ref.replace(/^minecraft:/, '') };
}

/**
 * Fetch a model (block or item) and follow its parents to collect the texture
 * names it references. Returns an array of { namespace, name }.
 */
async function collectModelTextures(name, kind) {
	const out = [];
	const visited = new Set();
	let currentName = name;
	let currentKind = kind;
	while (currentName && !visited.has(`${currentKind}:${currentName}`)) {
		visited.add(`${currentKind}:${currentName}`);
		const model = await fetchModel(currentName, currentKind);
		if (!model) break;
		for (const ref of extractModelTextureRefs(model.textures)) {
			out.push(parseTextureRef(ref));
		}
		if (!model.parent || model.parent.includes('generated') || model.parent.includes('builtin/')) break;
		const pk = parentKind(model.parent);
		if (!pk) break;
		currentKind = pk;
		currentName = stripModelPrefix(model.parent);
	}
	return out;
}

/**
 * Collect the ordered `layer0`, `layer1`, ... textures of an `item/generated`
 * model (used for multi-layer flat items like potions and tipped arrows).
 * Returns [{ namespace, name }] in draw order (layer0 first).
 */
async function collectItemLayers(modelName) {
	const merged = {};
	const visited = new Set();
	let cur = modelName;
	while (cur && !visited.has(cur)) {
		visited.add(cur);
		const m = await fetchModel(cur, 'item');
		if (!m) break;
		if (m.textures) Object.assign(merged, m.textures);
		if (!m.parent || m.parent.includes('generated') || m.parent.includes('builtin/')) break;
		cur = stripModelPrefix(m.parent);
	}
	const keys = Object.keys(merged)
		.filter((k) => /^layer\d+$/.test(k))
		.sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
	const layers = [];
	for (const k of keys) {
		const v = merged[k];
		if (typeof v === 'string' && !v.startsWith('#')) layers.push(parseTextureRef(v));
		else if (v && typeof v === 'object' && typeof v.sprite === 'string') layers.push(parseTextureRef(v.sprite));
	}
	return layers;
}

/** Extract the default tint color (an ARGB int) from an item definition, or null. */
function getItemDefaultTint(def) {
	const tints = def && def.model && Array.isArray(def.model.tints) ? def.model.tints : null;
	if (!tints || tints.length === 0) return null;
	const t = tints.find((x) => x && typeof x.default === 'number') || tints[0];
	return typeof t.default === 'number' ? t.default : null;
}

/** Convert a signed 32-bit ARGB color int to a '#RRGGBB' hex string. */
function argbToHex(color) {
	return '#' + ((color >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * Potion data. Brewing is hardcoded in vanilla (not data-driven), so every potion
 * is defined here with its tint color, brewing ingredient and base. We generate
 * one item per variant (I / II / extended, in normal / splash / lingering form)
 * and a brewing step chain for each.
 */
const POTION_WATER_COLOR = '#385DC6';

// key -> { name, color, ingredient (item name), base ('water' | 'awkward' | effect key), upgradable, extendable }
const POTION_EFFECTS = [
	{ key: 'swiftness', name: 'Swiftness', color: '#7CAFC6', ingredient: 'sugar', base: 'awkward', upgradable: true, extendable: true },
	{ key: 'leaping', name: 'Leaping', color: '#786297', ingredient: 'rabbit_foot', base: 'awkward', upgradable: true, extendable: true },
	{ key: 'strength', name: 'Strength', color: '#FC0000', ingredient: 'blaze_powder', base: 'awkward', upgradable: true, extendable: true },
	{ key: 'healing', name: 'Healing', color: '#F82423', ingredient: 'glistering_melon_slice', base: 'awkward', upgradable: true, extendable: false },
	{ key: 'poison', name: 'Poison', color: '#4E9331', ingredient: 'spider_eye', base: 'awkward', upgradable: true, extendable: true },
	{ key: 'regeneration', name: 'Regeneration', color: '#CD5CAB', ingredient: 'ghast_tear', base: 'awkward', upgradable: true, extendable: true },
	{ key: 'fire_resistance', name: 'Fire Resistance', color: '#E49A3A', ingredient: 'magma_cream', base: 'awkward', upgradable: false, extendable: true },
	{ key: 'water_breathing', name: 'Water Breathing', color: '#2E5299', ingredient: 'pufferfish', base: 'awkward', upgradable: false, extendable: true },
	{ key: 'night_vision', name: 'Night Vision', color: '#1F1FA1', ingredient: 'golden_carrot', base: 'awkward', upgradable: false, extendable: true },
	{ key: 'turtle_master', name: 'Turtle Master', color: '#8D82AC', ingredient: 'turtle_helmet', base: 'awkward', upgradable: true, extendable: true },
	{ key: 'slow_falling', name: 'Slow Falling', color: '#F7FAFE', ingredient: 'phantom_membrane', base: 'awkward', upgradable: false, extendable: true },
	{ key: 'weakness', name: 'Weakness', color: '#484D48', ingredient: 'fermented_spider_eye', base: 'water', upgradable: false, extendable: true },
	{ key: 'slowness', name: 'Slowness', color: '#5A6C81', ingredient: 'fermented_spider_eye', base: 'swiftness', upgradable: true, extendable: true },
	{ key: 'harming', name: 'Harming', color: '#430A09', ingredient: 'fermented_spider_eye', base: 'healing', upgradable: true, extendable: false },
	{ key: 'invisibility', name: 'Invisibility', color: '#7F8392', ingredient: 'fermented_spider_eye', base: 'night_vision', upgradable: false, extendable: true }
];

const BASE_POTIONS = [
	{ key: 'water', name: 'Water Bottle', color: POTION_WATER_COLOR },
	{ key: 'awkward', name: 'Awkward Potion', color: POTION_WATER_COLOR },
	{ key: 'mundane', name: 'Mundane Potion', color: POTION_WATER_COLOR },
	{ key: 'thick', name: 'Thick Potion', color: POTION_WATER_COLOR }
];

const effectByKey = new Map(POTION_EFFECTS.map((e) => [e.key, e]));

/** Build the display name of a potion for a given effect/variant/form. */
function potionName(effectKey, variant, form) {
	const e = effectByKey.get(effectKey);
	const base = e ? `Potion of ${e.name}` : '';
	const suffix = variant === 'II' ? ' II' : variant === 'extended' ? ' (Extended)' : '';
	if (form === 'splash') return `Splash ${base}${suffix}`;
	if (form === 'lingering') return `Lingering ${base}${suffix}`;
	return `${base}${suffix}`;
}

/**
 * Build the brewing step chain (array of { ingredient, baseLabel, resultLabel })
 * that leads from a water bottle to the requested potion variant/form.
 */
function buildBrewChain(effectKey, variant, form) {
	const steps = [];
	const e = effectByKey.get(effectKey);
	if (!e) return steps;

	// Steps up to the base effect.
	if (e.base === 'awkward') {
		steps.push({ ingredient: 'nether_wart', baseLabel: 'Water Bottle', resultLabel: 'Awkward Potion' });
		steps.push({ ingredient: e.ingredient, baseLabel: 'Awkward Potion', resultLabel: `Potion of ${e.name}` });
	} else if (e.base === 'water') {
		steps.push({ ingredient: e.ingredient, baseLabel: 'Water Bottle', resultLabel: `Potion of ${e.name}` });
	} else {
		const b = effectByKey.get(e.base);
		if (b) {
			if (b.base === 'awkward') {
				steps.push({ ingredient: 'nether_wart', baseLabel: 'Water Bottle', resultLabel: 'Awkward Potion' });
				steps.push({ ingredient: b.ingredient, baseLabel: 'Awkward Potion', resultLabel: `Potion of ${b.name}` });
			}
			steps.push({ ingredient: e.ingredient, baseLabel: `Potion of ${b.name}`, resultLabel: `Potion of ${e.name}` });
		}
	}

	const baseResult = `Potion of ${e.name}`;
	let current = baseResult;
	if (variant === 'II') {
		steps.push({ ingredient: 'glowstone_dust', baseLabel: baseResult, resultLabel: `${baseResult} II` });
		current = `${baseResult} II`;
	} else if (variant === 'extended') {
		steps.push({ ingredient: 'redstone', baseLabel: baseResult, resultLabel: `${baseResult} (Extended)` });
		current = `${baseResult} (Extended)`;
	}

	if (form === 'splash') {
		steps.push({ ingredient: 'gunpowder', baseLabel: current, resultLabel: `Splash ${current}` });
	} else if (form === 'lingering') {
		steps.push({ ingredient: 'gunpowder', baseLabel: current, resultLabel: `Splash ${current}` });
		steps.push({ ingredient: 'dragon_breath', baseLabel: `Splash ${current}`, resultLabel: `Lingering ${current}` });
	}

	return steps;
}

/**
 * Generate every potion as its own item (with a unique synthetic id) plus the
 * brewing recipes keyed by that id.
 */
function generatePotions(nameToId) {
	const items = [];
	const recipes = {};
	let nextId = 900000;

	const overlayUrl = '/textures/item/potion_overlay.webp';
	const bottleUrl = (form) => form === 'splash' ? '/textures/item/splash_potion.webp' : form === 'lingering' ? '/textures/item/lingering_potion.webp' : '/textures/item/potion.webp';

	const addPotion = (name, displayName, color, form, brewSteps) => {
		const id = nextId++;
		items.push({
			id,
			name,
			displayName,
			stackSize: 1,
			textureUrl: overlayUrl,
			renderAs: 'layered',
			layers: [{ url: overlayUrl, tint: color }, { url: bottleUrl(form) }]
		});
		const steps = brewSteps
			.map((s) => ({ ingredient: nameToId(s.ingredient), baseLabel: s.baseLabel, resultLabel: s.resultLabel }))
			.filter((s) => s.ingredient != null);
		if (steps.length > 0) {
			recipes[id] = [{ type: 'brewing', steps }];
		}
	};

	// Base potions (normal form only; splash/lingering handled via effects).
	for (const b of BASE_POTIONS) {
		let steps = [];
		if (b.key === 'awkward') steps = [{ ingredient: 'nether_wart', baseLabel: 'Water Bottle', resultLabel: 'Awkward Potion' }];
		else if (b.key === 'mundane') steps = [{ ingredient: 'redstone', baseLabel: 'Water Bottle', resultLabel: 'Mundane Potion' }];
		else if (b.key === 'thick') steps = [{ ingredient: 'glowstone_dust', baseLabel: 'Water Bottle', resultLabel: 'Thick Potion' }];
		addPotion(
			b.key === 'water' ? 'water_bottle' : `${b.key}_potion`,
			b.name,
			b.color,
			'normal',
			steps
		);
	}

	// Effect potions: every variant × form combination.
	for (const e of POTION_EFFECTS) {
		const variants = ['I'];
		if (e.upgradable) variants.push('II');
		if (e.extendable) variants.push('extended');
		const forms = ['normal', 'splash', 'lingering'];
		for (const variant of variants) {
			for (const form of forms) {
				const display = potionName(e.key, variant, form);
				const slug = `${form === 'normal' ? '' : form + '_'}potion_of_${e.key}${variant === 'I' ? '' : '_' + variant}`;
				addPotion(slug, display, e.color, form, buildBrewChain(e.key, variant, form));
			}
		}
	}

	return { items, recipes };
}

/**
 * Extract every recipe type from the vanilla recipe JSONs (26.3 assets):
 * crafting (shaped + shapeless), smelting/blasting/smoking/campfire,
 * stonecutting and smithing. Brewing recipes are merged in separately.
 * Returns { resultId: [recipe, ...] }.
 */
async function extractAllRecipes(nameToId) {
	const recipes = {};
	const addRecipe = (resultId, recipe) => {
		if (!resultId) return;
		(recipes[resultId] = recipes[resultId] || []).push(recipe);
	};

	// 1. Vanilla recipe JSONs (all types).
	const tagCache = new Map();
	async function resolveIngredient(ing) {
		if (Array.isArray(ing)) {
			for (const i of ing) { const id = await resolveIngredient(i); if (id) return id; }
			return null;
		}
		if (typeof ing === 'string') {
			if (ing.startsWith('#')) {
				const tagName = ing.slice(1).replace(/^minecraft:/, '');
				if (tagCache.has(tagName)) return tagCache.get(tagName);
				let first = null;
				const tag = await fetchJson(`${ITEM_TAG_BASE}/${tagName}.json`);
				if (tag && Array.isArray(tag.values)) {
					for (const v of tag.values) {
						const id = nameToId(v);
						if (id) { first = id; break; }
					}
				}
				tagCache.set(tagName, first);
				return first;
			}
			return nameToId(ing);
		}
		if (ing && typeof ing === 'object') {
			if (typeof ing.item === 'string') return nameToId(ing.item);
			if (typeof ing.tag === 'string') return resolveIngredient('#' + ing.tag);
		}
		return null;
	}

	const listRes = await fetchJson(`${RECIPE_BASE}/_list.json`);
	const files = (listRes && Array.isArray(listRes.files) ? listRes.files : []).filter((f) => !f.startsWith('_'));
	console.log(`Fetching ${files.length} vanilla recipes...`);

	const queue = [...files];
	const worker = async () => {
		while (queue.length > 0) {
			const f = queue.pop();
			if (!f) continue;
			const r = await fetchJson(`${RECIPE_BASE}/${f}`);
			if (!r || !r.type || !r.result) continue;
			const type = String(r.type).replace('minecraft:', '');
			const resultId = nameToId(r.result.id || r.result);
			if (!resultId) continue;
			if (type === 'smelting' || type === 'blasting' || type === 'smoking' || type === 'campfire_cooking') {
				const ingredient = await resolveIngredient(r.ingredient);
				if (ingredient == null) continue;
				addRecipe(resultId, {
					type,
					ingredient,
					result: { id: resultId, count: r.result.count || 1 },
					experience: typeof r.experience === 'number' ? r.experience : undefined,
					cookingtime: typeof r.cookingtime === 'number' ? r.cookingtime : undefined
				});
			} else if (type === 'stonecutting') {
				const ingredient = await resolveIngredient(r.ingredient);
				if (ingredient == null) continue;
				addRecipe(resultId, { type, ingredient, result: { id: resultId, count: r.result.count || 1 } });
			} else if (type === 'smithing_transform' || type === 'smithing_trim') {
				const template = await resolveIngredient(r.template);
				const base = await resolveIngredient(r.base);
				const addition = await resolveIngredient(r.addition);
				if (base == null) continue;
				addRecipe(resultId, {
					type: 'smithing',
					template: template == null ? null : template,
					base,
					addition: addition == null ? null : addition,
					result: { id: resultId, count: r.result.count || 1 }
				});
			} else if (type === 'crafting_shaped') {
				const key = r.key || {};
				const keyIds = {};
				for (const [ch, ing] of Object.entries(key)) keyIds[ch] = await resolveIngredient(ing);
				const inShape = (Array.isArray(r.pattern) ? r.pattern : []).map((row) =>
					String(row).split('').map((ch) => (ch === ' ' ? null : (keyIds[ch] ?? null)))
				);
				if (inShape.length > 0) {
					addRecipe(resultId, {
						type: 'crafting_shaped',
						inShape,
						result: { id: resultId, count: r.result.count || 1 }
					});
				}
			} else if (type === 'crafting_shapeless') {
				const ingredients = [];
				for (const ing of r.ingredients || []) ingredients.push(await resolveIngredient(ing));
				if (ingredients.length > 0) {
					addRecipe(resultId, {
						type: 'crafting_shapeless',
						ingredients,
						result: { id: resultId, count: r.result.count || 1 }
					});
				}
			}
			// Other specialised types (decorated pot, transmute, ...) are skipped.
		}
	};
	const workers = new Array(Math.min(40, files.length)).fill(null).map(() => worker());
	await Promise.all(workers);

	// 2. Brewing recipes are generated separately by generatePotions() and merged
	// in extractData (every potion variant is its own item).

	return recipes;
}

/**
 * Follow an item model's parent chain; if it inherits from a block model
 * (e.g. small_dripleaf -> block/small_dripleaf_top), return that block model
 * name so the item renders as a 3D block. Returns null otherwise.
 */
async function findBlockModelFromItem(itemModelName) {
	const visited = new Set();
	let currentName = itemModelName;
	while (currentName && !visited.has(currentName)) {
		visited.add(currentName);
		const model = await fetchModel(currentName, 'item');
		if (!model) return null;
		if (!model.parent) return null;
		if (model.parent.includes('generated') || model.parent.includes('builtin/')) return null;
		if (model.parent.includes('block/')) return stripModelPrefix(model.parent);
		currentName = stripModelPrefix(model.parent);
	}
	return null;
}

/**
 * Resolve how an item is rendered in the inventory.
 * Returns:
 *   { renderAs: 'block', modelName, textures } - a 3D block model
 *   { renderAs: 'item',  textures }             - a flat 2D texture
 *   { renderAs: 'head',  kind }                 - a 3D head (converted later)
 *   { renderAs: 'banner', color }               - a tinted flat banner (converted later)
 */
async function resolveItemInventory(name) {
	const def = await fetchItemDefinition(name);
	if (!def) return { renderAs: 'item', textures: [] };

	const special = detectSpecialModel(def.model);
	if (special) return special;

	const ref = resolveItemModelRef(def.model);

	if (ref && ref.startsWith('minecraft:block/')) {
		const modelName = ref.slice('minecraft:block/'.length);
		const textures = await collectModelTextures(modelName, 'block');
		return { renderAs: 'block', modelName, textures };
	}

	if (ref && ref.startsWith('minecraft:item/')) {
		const modelName = ref.slice('minecraft:item/'.length);
		const blockParent = await findBlockModelFromItem(modelName);
		if (blockParent) {
			const textures = await collectModelTextures(blockParent, 'block');
			return { renderAs: 'block', modelName: blockParent, textures };
		}
		// Multi-layer flat items (potions, tipped arrows, ...): keep the layer
		// order and tint so the client can composite them correctly.
		const layers = await collectItemLayers(modelName);
		if (layers.length > 1) {
			const tint = getItemDefaultTint(def);
			return { renderAs: 'layered', layers, tint };
		}
		const textures = await collectModelTextures(modelName, 'item');
		return { renderAs: 'item', textures };
	}

	// Unknown/special: fall back to guessing a flat texture by item name.
	return { renderAs: 'item', textures: [] };
}

function hexToRgb(hex) {
	const m = String(hex).replace('#', '');
	return {
		r: parseInt(m.slice(0, 2), 16),
		g: parseInt(m.slice(2, 4), 16),
		b: parseInt(m.slice(4, 6), 16)
	};
}

/** Download a texture (optionally tinted and/or trimmed) and convert to WebP. */
async function downloadTextureEntry(entry) {
	if (existsSync(entry.localPath)) return true;
	try {
		const res = await fetch(entry.remoteUrl, { headers: { 'Accept': 'image/png' } });
		if (!res.ok || !res.body) return false;
		let pipeline = sharp(Buffer.from(await res.arrayBuffer()), { failOnError: false });
		if (entry.rotate) {
			pipeline = pipeline.rotate(entry.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
		}
		if (entry.tint) {
			const { r, g, b } = hexToRgb(entry.tint);
			pipeline = pipeline.recomb([[r / 255, 0, 0], [0, g / 255, 0], [0, 0, b / 255]]);
		}
		if (entry.trim) {
			pipeline = pipeline.trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } });
		}
		mkdirSync(dirname(entry.localPath), { recursive: true });
		await pipeline.webp({ lossless: true, effort: 4 }).toFile(entry.localPath);
		return true;
	} catch {
		return false;
	}
}

/** Download a head skin to /textures/block and return its pixel dimensions. */
async function downloadSkin(remoteUrl, localPath) {
	if (!existsSync(localPath)) {
		const res = await fetch(remoteUrl, { headers: { 'Accept': 'image/png' } });
		if (!res.ok) return { width: 64, height: 64 };
		const buf = Buffer.from(await res.arrayBuffer());
		const meta = await sharp(buf).metadata();
		mkdirSync(dirname(localPath), { recursive: true });
		await sharp(buf, { failOnError: false }).webp({ lossless: true, effort: 4 }).toFile(localPath);
		return { width: meta.width || 64, height: meta.height || 64 };
	}
	try {
		const meta = await sharp(localPath).metadata();
		return { width: meta.width || 64, height: meta.height || 64 };
	} catch {
		return { width: 64, height: 64 };
	}
}

/**
 * Download banner_base.png and split it into a tinted cloth texture and a brown
 * pole texture (both saved under /textures/block so the 3D banner model can use
 * them). The cloth is left of the first fully-transparent column, the pole is to
 * the right.
 */
async function downloadBannerParts(color, hex) {
	const clothPath = join(texturesDir, 'block', `banner_cloth_${color}.webp`);
	const polePath = join(texturesDir, 'block', 'banner_pole.webp');

	const res = await fetch(`${ENTITY_TEXTURE_BASE}/banner/banner_base.png`, { headers: { 'Accept': 'image/png' } });
	if (!res.ok) return { cloth: `banner_cloth_${color}`, pole: 'banner_pole' };
	const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()), { failOnError: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const w = info.width, h = info.height;
	// banner_base.png is 64x64: cloth spans x 0-43, the wooden pole x 44-51, and
	// x 52+ is empty. Split between cloth and pole.
	const split = w >= 52 ? 44 : Math.floor(w * 0.7);

	const cloth = hexToRgb(hex);
	const pole = hexToRgb('#8B5A2B'); // oak wood brown

	mkdirSync(dirname(clothPath), { recursive: true });

	const tintCrop = (x0, x1, rgb, yMax = h) => {
		const cw = x1 - x0;
		const ch = Math.min(h, yMax);
		const out = Buffer.alloc(cw * ch * 4);
		for (let y = 0; y < ch; y++) {
			for (let x = 0; x < cw; x++) {
				const si = (y * w + x0 + x) * 4;
				const di = (y * cw + x) * 4;
				out[di] = Math.min(255, Math.round(data[si] * rgb.r / 255));
				out[di + 1] = Math.min(255, Math.round(data[si + 1] * rgb.g / 255));
				out[di + 2] = Math.min(255, Math.round(data[si + 2] * rgb.b / 255));
				out[di + 3] = data[si + 3];
			}
		}
		return sharp(out, { raw: { width: cw, height: ch, channels: 4 } });
	};

	// The cloth crop stops before the brown stand strip at the bottom of the
	// base sheet and before the transparent/noise columns right of the flag;
	// keeping them painted dark bands across the flag face.
	if (!existsSync(clothPath)) {
		await tintCrop(0, split, cloth, 42)
			.trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.webp({ lossless: true, effort: 4 })
			.toFile(clothPath);
	}

	if (!existsSync(polePath)) {
		await tintCrop(split, w, pole)
			.trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.webp({ lossless: true, effort: 4 })
			.toFile(polePath);
	}

	return { cloth: `banner_cloth_${color}`, pole: 'banner_pole' };
}

function removeStalePngTextures() {
	for (const folder of ['block', 'item', 'entity']) {
		const dir = join(texturesDir, folder);
		if (!existsSync(dir)) continue;
		const remove = (d) => {
			for (const f of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, f.name);
				if (f.isDirectory()) remove(p);
				else if (f.name.endsWith('.png')) unlinkSync(p);
			}
		};
		remove(dir);
	}
}

/**
 * Download the model JSONs (and their parents) for a set of block model names.
 */
async function downloadModels(modelNames) {
	const modelsDir = join(dataDir, 'models', 'block');
	mkdirSync(modelsDir, { recursive: true });

	const queue = Array.from(modelNames);
	const toDownload = new Set(queue);
	let downloaded = 0;

	async function downloadModel(modelName) {
		const localPath = join(modelsDir, `${modelName}.json`);
		let data;
		if (existsSync(localPath)) {
			// Model already downloaded: still follow its parent chain so shared
			// parents get downloaded even when their children pre-exist.
			try { data = JSON.parse(readFileSync(localPath, 'utf8')); } catch { data = null; }
		} else {
			data = await fetchJson(`${MODEL_BASE}/block/${modelName}.json`);
			if (data) {
				writeFileSync(localPath, JSON.stringify(data));
				downloaded++;
			}
		}
		if (data && data.parent) {
			const parentName = stripModelPrefix(data.parent);
			if (parentName && !toDownload.has(parentName)) {
				toDownload.add(parentName);
				queue.push(parentName);
			}
		}
	}

	// Worker pool
	const workers = new Array(Math.min(50, queue.length)).fill(null).map(async () => {
		while (queue.length > 0) {
			const name = queue.pop();
			if (name) await downloadModel(name);
		}
	});
	await Promise.all(workers);

	console.log(`Downloaded ${downloaded} block models (${toDownload.size} total)`);
}

async function downloadTextures(tasks) {
	const unique = [];
	const seen = new Set();
	for (const t of tasks) {
		const key = t.localPath;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(t);
	}

	console.log(`Downloading ${unique.length} textures...`);
	let downloaded = 0;
	const queue = [...unique];

	const worker = async () => {
		while (queue.length > 0) {
			const t = queue.pop();
			if (!t) continue;
			if (await downloadTextureEntry(t)) downloaded++;
		}
	};

	const workers = new Array(Math.min(50, queue.length)).fill(null).map(() => worker());
	await Promise.all(workers);

	console.log(`Downloaded ${downloaded}/${unique.length} textures`);
}

/**
 * Write a data file atomically: remove any previous file first (Windows
 * truncation quirks left stale tails when overwriting longer files with
 * shorter content) and verify the written bytes parse back.
 */
function writeJsonFile(path, data) {
	const json = JSON.stringify(data);
	if (existsSync(path)) unlinkSync(path);
	writeFileSync(path, json);
	try {
		JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`Corrupt write detected for ${path}: ${error.message}`);
	}
}

async function extractData() {
	console.time('extractData');

	// Catalog source of truth: the 26.3 assets repo. items/_all.json lists every
	// item with its model dispatch; an item is a "block item" when its resolved
	// model path lives under minecraft:block/.
	// minecraft-data (only published up to 26.1) is used solely as a fallback
	// for display names and stack sizes by name.
	const labelData = minecraftData('26.1');
	if (!labelData) throw new Error('Could not load minecraft-data 26.1 for display names/stack sizes');

	const itemDispatch = await fetchJson(`${ITEMS_BASE}/_all.json`);
	if (!itemDispatch) throw new Error(`Could not load item catalog from ${ITEMS_BASE}/_all.json`);

	// Keep existing numeric ids stable (recipes.json keys and client code
	// reference them); new 26.3 items get ids appended after the current max.
	const existingIds = new Map();
	try {
		const prev = JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8'));
		for (const item of prev) {
			if (item && typeof item.name === 'string' && Number.isFinite(item.id)) {
				existingIds.set(item.name.replace(/^minecraft:/, ''), item.id);
			}
		}
	} catch {
		// No previous extraction: every id is assigned from scratch.
	}
	let nextId = Math.max(0, ...[...existingIds.values()].filter((id) => id < POTION_ID_BASE)) + 1;

	// `air` is not an item; the assets catalog still lists it.
	const catalog = new Map(); // name -> { id, blockItem }
	for (const [name, dispatch] of Object.entries(itemDispatch)) {
		if (!name || name.startsWith('_') || name === 'air') continue;
		const modelPath = resolveItemModelRef(dispatch?.model);
		const blockItem = modelPath?.startsWith('minecraft:block/') ?? false;
		const id = existingIds.get(name) ?? nextId++;
		catalog.set(name, { id, blockItem });
	}

	const displayNameOf = (name) =>
		labelData.itemsByName?.[name]?.displayName ??
		name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

	const allItems = [...catalog.entries()]
		.map(([name, meta]) => ({
			id: meta.id,
			// Bare item name (no "minecraft:" prefix) — the format every
			// consumer of items.json expects (recipes, bedrock-ids, the API).
			name,
			displayName: displayNameOf(name),
			stackSize: labelData.itemsByName?.[name]?.stackSize || 64,
			textureUrl: meta.blockItem
				? `${BLOCKS_TEXTURE_BASE}/${name}.png`
				: `${ITEMS_TEXTURE_BASE}/${name}.png`
		}))
		.sort((a, b) => a.id - b.id);

	const blockItemIds = new Set([...catalog.values()].filter((m) => m.blockItem).map((m) => m.id));

	// Generate every potion as its own item (normal/splash/lingering × I/II/
	// extended) with a full brewing step chain each. The generic potion carriers
	// (potion / splash_potion / lingering_potion) are removed so brewing no longer
	// shows up as recipes of a single "potion" item.
	const nameToId = (n) => {
		const meta = catalog.get(String(n).replace(/^minecraft:/, ''));
		return meta ? meta.id : null;
	};
	const genericPotionNames = new Set(['potion', 'splash_potion', 'lingering_potion']);
	const vanillaItems = allItems.filter((item) => !genericPotionNames.has(item.name.replace('minecraft:', '')));
	const potionGen = generatePotions(nameToId);

	// Extract recipes (crafting shaped/shapeless + smelting/blasting/smoking/
	// campfire/stonecutting/smithing) from the vanilla recipe JSONs.
	const recipes = await extractAllRecipes(nameToId);
	for (const [id, list] of Object.entries(potionGen.recipes)) {
		(recipes[id] = recipes[id] || []).push(...list);
	}

	// Resolve each item's inventory model + textures
	console.log('Resolving item inventory models...');
	const resolved = new Map(); // item name -> resolved info
	const itemNames = vanillaItems.map((item) => item.name.replace('minecraft:', ''));
	const resolveWorker = async () => {
		while (itemNames.length > 0) {
			const name = itemNames.pop();
			if (!name) continue;
			const info = await resolveItemInventory(name);
			resolved.set(name, info);
		}
	};
	const workers = new Array(Math.min(50, itemNames.length)).fill(null).map(() => resolveWorker());
	await Promise.all(workers);

	// Convert `minecraft:head` specials into generated 3D block models.
	const headsDir = join(dataDir, 'models', 'block');
	mkdirSync(headsDir, { recursive: true });
	for (const info of resolved.values()) {
		if (info.renderAs !== 'head') continue;
		const kind = info.kind;
		const skinRel = HEAD_SKINS[kind] || HEAD_SKINS.skeleton;
		const skinName = `head_skin_${kind}`;
		const dims = await downloadSkin(`${ASSET_BASE}/${skinRel}`, join(texturesDir, 'block', `${skinName}.webp`));
		const regions = kind === 'dragon' ? DRAGON_HEAD_REGIONS : HEAD_REGIONS;
		writeFileSync(join(headsDir, `head_${kind}.json`), JSON.stringify(buildHeadModel(skinName, dims, regions)));
		info.renderAs = 'block';
		info.modelName = `head_${kind}`;
		info.textures = [{ namespace: 'block', name: skinName }];
	}

	// Convert `minecraft:bed` specials into generated 3D block models.
	for (const info of resolved.values()) {
		if (info.renderAs !== 'bed') continue;
		const color = info.color;
		const texName = `bed_${color}`;
		await downloadSkin(`${ENTITY_TEXTURE_BASE}/bed/${color}.png`, join(texturesDir, 'block', `${texName}.webp`));
		writeFileSync(join(headsDir, `bed_${color}.json`), JSON.stringify(buildBedModel(texName)));
		info.renderAs = 'block';
		info.modelName = `bed_${color}`;
		info.textures = [{ namespace: 'block', name: texName }];
	}

	// Convert `minecraft:chest` specials into generated 3D block models.
	for (const info of resolved.values()) {
		if (info.renderAs !== 'chest') continue;
		const tex = String(info.texture || 'normal').replace('minecraft:', '');
		const texName = `chest_${tex}`;
		await downloadTextureEntry({ remoteUrl: `${ENTITY_TEXTURE_BASE}/chest/${tex}.png`, localPath: join(texturesDir, 'block', `${texName}.webp`) });
		writeFileSync(join(headsDir, `chest_${tex}.json`), JSON.stringify(buildChestModel(texName)));
		info.renderAs = 'block';
		info.modelName = `chest_${tex}`;
		info.textures = [{ namespace: 'block', name: texName }];
	}

	// Convert `minecraft:copper_golem_statue` specials into generated 3D models.
	for (const info of resolved.values()) {
		if (info.renderAs !== 'golem_statue') continue;
		const file = String(info.texture).split('/').pop().replace('.png', '') || 'copper_golem';
		const texName = `golem_${file}`;
		await downloadTextureEntry({ remoteUrl: `${ENTITY_TEXTURE_BASE}/copper_golem/${file}.png`, localPath: join(texturesDir, 'block', `${texName}.webp`) });
		writeFileSync(join(headsDir, `golem_${file}.json`), JSON.stringify(buildGolemStatueModel(texName)));
		info.renderAs = 'block';
		info.modelName = `golem_${file}`;
		info.textures = [{ namespace: 'block', name: texName }];
	}

	// Convert `minecraft:shield` special into a generated 3D model (a thin slab
	// carrying the shield texture, pre-rotated 90° so the shield is upright).
	for (const info of resolved.values()) {
		if (info.renderAs !== 'shield') continue;
		const texName = 'shield_base';
		await downloadTextureEntry({ remoteUrl: `${ENTITY_TEXTURE_BASE}/shield/shield_base.png`, localPath: join(texturesDir, 'block', `${texName}.webp`), rotate: 90, trim: true });
		writeFileSync(join(headsDir, 'shield.json'), JSON.stringify(buildShieldModel(texName)));
		info.renderAs = 'block';
		info.modelName = 'shield';
		info.textures = [{ namespace: 'block', name: texName }];
	}

	// Convert `minecraft:banner` specials into generated 3D models (pole + cloth).
	for (const info of resolved.values()) {
		if (info.renderAs !== 'banner') continue;
		const color = info.color;
		const hex = BANNER_COLORS[color] || '#FFFFFF';
		const parts = await downloadBannerParts(color, hex);
		writeFileSync(join(headsDir, `banner_${color}.json`), JSON.stringify(buildBannerModel(parts.cloth, parts.pole)));
		info.renderAs = 'block';
		info.modelName = `banner_${color}`;
		info.textures = [{ namespace: 'block', name: parts.cloth }, { namespace: 'block', name: parts.pole }];
	}

	// Convert `minecraft:decorated_pot` specials into a generated 3D vase model.
	// The vanilla block model only carries a particle texture and terracotta is
	// already downloaded for the standard blocks, so no texture work is needed.
	for (const info of resolved.values()) {
		if (info.renderAs !== 'decorated_pot') continue;
		writeFileSync(join(headsDir, 'decorated_pot.json'), JSON.stringify(buildDecoratedPotModel()));
		info.renderAs = 'block';
		info.modelName = 'decorated_pot';
		info.textures = [{ namespace: 'block', name: 'terracotta' }];
	}

	// Collect block model names + texture download tasks.
	const blockModelNames = new Set();
	const textureTasks = [];

	const pushTextureTask = (namespace, name, opts = {}) => {
		let remoteBase;
		let localDir;
		if (namespace === 'item') { remoteBase = ITEMS_TEXTURE_BASE; localDir = 'item'; }
		else if (namespace === 'block') { remoteBase = BLOCKS_TEXTURE_BASE; localDir = 'block'; }
		else if (namespace === 'entity') { remoteBase = ENTITY_TEXTURE_BASE; localDir = 'entity'; }
		else return;
		textureTasks.push({
			remoteUrl: `${remoteBase}/${name}.png`,
			localPath: join(texturesDir, localDir, `${name}.webp`),
			trim: opts.trim,
			tint: opts.tint
		});
	};

	for (const [name, info] of resolved) {
		if (info.renderAs === 'block') {
			blockModelNames.add(info.modelName);
			for (const t of info.textures) pushTextureTask(t.namespace, t.name);
		} else if (info.renderAs === 'item') {
			if (info.textures.length > 0) {
				for (const t of info.textures) pushTextureTask(t.namespace, t.name, { trim: t.namespace === 'entity' });
			} else {
				pushTextureTask('item', name);
			}
		} else if (info.renderAs === 'layered') {
			for (const t of info.layers) pushTextureTask(t.namespace, t.name);
		}
	}

	// Textures used by the generated potion items (bottle + tinted overlay).
	for (const n of ['potion_overlay', 'potion', 'splash_potion', 'lingering_potion']) {
		pushTextureTask('item', n);
	}

	// Download model JSONs (block) and all textures
	await downloadModels(blockModelNames);
	await downloadTextures(textureTasks);

	removeStalePngTextures();

	// Combine every block model into a single file so the client can load all
	// models with one request instead of one request per block.
	{
		const blockModelsDir = join(dataDir, 'models', 'block');
		const allModels = {};
		for (const f of readdirSync(blockModelsDir)) {
			if (!f.endsWith('.json')) continue;
			allModels[f.slice(0, -5)] = JSON.parse(readFileSync(join(blockModelsDir, f), 'utf8'));
		}
		writeJsonFile(join(dataDir, 'models', 'all.json'), allModels);
		console.log(`Combined ${Object.keys(allModels).length} block models into all.json`);
	}

	// Build items.json with correct local texture URLs and render info
	const itemsWithData = vanillaItems.map((item) => {
		const cleanName = item.name.replace('minecraft:', '');
		const info = resolved.get(cleanName) || { renderAs: 'item', textures: [] };

		let textureUrl;
		let textureVariants = [];
		let extra = {};

		if (info.renderAs === 'block') {
			const tex = info.textures[0];
			textureUrl = tex
				? `/textures/${tex.namespace}/${tex.name}.webp`
				: `/textures/block/${cleanName}.webp`;
			textureVariants = info.textures.slice(1).map((t) => t.name);
			extra = { modelName: info.modelName };
		} else if (info.renderAs === 'layered') {
			// Multi-layer flat item (potion, tipped arrow, ...). layer0 is tinted.
			const layers = info.layers.map((t, i) => ({
				url: `/textures/${t.namespace}/${t.name}.webp`,
				...(i === 0 && info.tint != null ? { tint: argbToHex(info.tint) } : {})
			}));
			textureUrl = layers[0].url;
			extra = { layers };
		} else {
			const tex = info.textures[0];
			textureUrl = tex
				? `/textures/${tex.namespace}/${tex.name}.webp`
				: `/textures/item/${cleanName}.webp`;
			textureVariants = info.textures.slice(1).map((t) => t.name);
		}

		return {
			...item,
			textureUrl,
			textureVariants,
			renderAs: info.renderAs,
			...extra
		};
	});

	// Append the generated potion items (already carry their textureUrl/layers).
	itemsWithData.push(...potionGen.items);

	const allBlocks = vanillaItems
		.filter((item) => blockItemIds.has(item.id))
		.map((block) => ({
			id: block.id,
			name: block.name,
			displayName: block.displayName,
			stackSize: 64,
			textureUrl: `/textures/block/${block.name.replace('minecraft:', '')}.webp`
		}));

	mkdirSync(dataDir, { recursive: true });
	writeJsonFile(join(dataDir, 'items.json'), itemsWithData);
	writeJsonFile(join(dataDir, 'blocks.json'), allBlocks);
	writeJsonFile(join(dataDir, 'recipes.json'), recipes);
	writeJsonFile(join(dataDir, 'block-item-ids.json'), [...blockItemIds]);

	console.log(`Extracted ${itemsWithData.length} items (${blockItemIds.size} block items, ${itemsWithData.length - blockItemIds.size} pure items)`);
	console.log(`Extracted ${allBlocks.length} blocks`);
	console.log(`Extracted recipes for ${Object.keys(recipes).length} result items`);
	console.log('Data saved to public/data/');
	console.timeEnd('extractData');
}

extractData().catch(console.error);
