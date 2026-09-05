// Command builders for the /give Command Generator.
// Pure functions: given the form state they produce the command string.
// Kept free of DOM access so the logic is unit-testable.
//
// Security / performance notes:
// - Numeric component values are emitted only when they match a strict
//   integer/float pattern, so crafted input can never inject raw SNBT.
// - Command targets go through a selector whitelist.
// - SNBT string escaping covers backslashes, quotes and control characters.
// - User-supplied raw JSON is merged with a prototype-pollution-safe copy
//   (`__proto__` / `constructor` / `prototype` keys are dropped).
// - Pure helpers (`parseColor`, `parseBlockList`, ...) are memoized in small
//   bounded caches. Valid outputs are byte-identical to the previous version.

import type { BuildResult, GiveState } from './types';
import { resolveBedrockItem } from './bedrock-ids';

// ---- Precompiled patterns / whitelists ----

/** Strict integer (damage, counts, data values...). */
const INT_RE = /^-?\d+$/;
/** Strict decimal (saturation, cooldown seconds...). */
const FLOAT_RE = /^-?\d+(\.\d+)?$/;
/** Split on commas / whitespace (block lists, color lists). */
const LIST_SPLIT_RE = /[\s,]+/;
/** Key=value lines (block-state editor, raw kv). */
const KV_SPLIT_RE = /\n|;/;
/** Hex color "#rrggbb". */
const HEX_COLOR_RE = /^[0-9a-fA-F]{6}$/;
/** UUID without dashes (32 hex chars). */
const UUID_HEX_RE = /^[0-9a-fA-F]{32}$/;

/** Exact vanilla target selectors. */
const SELECTOR_WHITELIST: ReadonlySet<string> = new Set(['@p', '@a', '@r', '@s']);
/** Extended selector with arguments, e.g. `@e[type=zombie]`. */
const SELECTOR_ARGS_RE = /^@[paers](\[.*\])?$/;
/** Plain player name (Bedrock/Java online id). */
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
/** UUID with or without dashes. */
const UUID_RE = /^[0-9a-fA-F-]{32,36}$/;

/** Keys that must never be merged from user-supplied JSON (prototype pollution). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

// ---- Bounded memoization for pure helpers ----

const MEMO_CAP = 500;

function memoize1<A extends string, R>(fn: (arg: A) => R, cap = MEMO_CAP): (arg: A) => R {
	const cache = new Map<string, R>();
	return (arg: A): R => {
		const hit = cache.get(arg);
		if (hit !== undefined) return hit;
		const out = fn(arg);
		if (cache.size >= cap) cache.clear();
		cache.set(arg, out);
		return out;
	};
}

// ---- SNBT / text helpers ----

/** Double-quoted SNBT string (escapes backslashes, quotes and controls). */
export function snbtStr(value: string): string {
	return '"' + value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t') + '"';
}

/** JSON text component wrapped in single quotes (safe inside item brackets). */
export function snbtJson(json: string): string {
	return "'" + json
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t') + "'";
}

const textComponentCache = new Map<string, string>();

/** Build a Minecraft JSON text component `{"text":...,"color":...}`. */
export function textComponent(text: string, color?: string, italic?: boolean, bold?: boolean): string {
	const cacheKey = text + '¦' + (color ?? '') + '¦' + (italic === undefined ? '' : italic ? '1' : '0') + '¦' + (bold ? '1' : '0');
	const hit = textComponentCache.get(cacheKey);
	if (hit !== undefined) return hit;
	const parts = [`"text":${JSON.stringify(text)}`];
	if (color && color !== 'white') parts.push(`"color":"${color}"`);
	if (italic !== undefined) parts.push(`"italic":${italic}`);
	if (bold) parts.push(`"bold":true`);
	const out = '{' + parts.join(',') + '}';
	if (textComponentCache.size >= MEMO_CAP) textComponentCache.clear();
	textComponentCache.set(cacheKey, out);
	return out;
}

function parseBlockListUncached(text: string): string[] {
	return text
		.split(LIST_SPLIT_RE)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Split a comma/whitespace separated block list (allows "#tag" and "block:data"). */
export const parseBlockList: (text: string) => string[] = memoize1(parseBlockListUncached);

function parseColorUncached(input: string): number | null {
	const s = input.trim();
	if (!s) return null;
	if (s.startsWith('#')) {
		const hex = s.slice(1);
		if (!HEX_COLOR_RE.test(hex)) return null;
		return parseInt(hex, 16);
	}
	if (/^\d+$/.test(s)) return parseInt(s, 10);
	return null;
}

/** "#rrggbb" or decimal int -> decimal color int (null when unparseable). */
export const parseColor: (input: string) => number | null = memoize1(parseColorUncached);

function parseColorListUncached(text: string): number[] {
	return text
		.split(LIST_SPLIT_RE)
		.map((c) => parseColor(c))
		.filter((c): c is number => c !== null);
}

/** "16711680, #ff0000, 65280" -> [16711680, 65280]. */
export const parseColorList: (text: string) => number[] = memoize1(parseColorListUncached);

/** Parse `key=value` lines into SNBT compound entries. */
export function parseKvLines(text: string): string[] {
	return text
		.split(KV_SPLIT_RE)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const eq = line.indexOf('=');
			if (eq <= 0) return null;
			const key = line.slice(0, eq).trim();
			const value = line.slice(eq + 1).trim();
			if (INT_RE.test(value)) {
				return `${key}:${value}`;
			}
			if (value === 'true' || value === 'false') {
				return `${key}:${value}`;
			}
			return `${key}:${snbtStr(value)}`;
		})
		.filter((e): e is string => e !== null);
}

/** Parse a "k=v" line (used by the block-state editor). */
function kvToSnbt(key: string, value: string): string {
	if (INT_RE.test(value)) return `${key}:${value}`;
	if (value === 'true' || value === 'false') return `${key}:${value}`;
	return `${key}:${snbtStr(value)}`;
}

// Keep the helper referenced (block-state rows reuse the same coercion).
void kvToSnbt;

const uuidCache = new Map<string, string>();

/** Convert a UUID string (with or without dashes) to SNBT int-array form [I;...]. */
export function uuidToIntArray(uuid: string): string {
	const hit = uuidCache.get(uuid);
	if (hit !== undefined) return hit;
	const hex = uuid.replace(/-/g, '');
	let out: string;
	if (!UUID_HEX_RE.test(hex)) {
		// Not a valid UUID; keep the raw value so the command still shows something.
		out = `[I;${hex}]`;
	} else {
		const parts: number[] = [];
		for (let i = 0; i < 32; i += 8) {
			parts.push(parseInt(hex.slice(i, i + 8), 16) | 0);
		}
		out = `[I;${parts.join(',')}]`;
	}
	if (uuidCache.size >= MEMO_CAP) uuidCache.clear();
	uuidCache.set(uuid, out);
	return out;
}

function blockPredicate(text: string): string | null {
	const blocks = parseBlockList(text);
	if (blocks.length === 0) return null;
	const list = blocks.map(snbtStr).join(',');
	return blocks.length === 1
		? `{blocks:${snbtStr(blocks[0])}}`
		: `{blocks:[${list}]}`;
}

/** Copy user JSON into `target` without prototype-pollution keys (shallow). */
function safeMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of Object.keys(source)) {
		if (UNSAFE_KEYS.has(key)) continue;
		target[key] = source[key];
	}
}

type Row = Record<string, unknown>;

function rows(values: Record<string, unknown>, key: string): Row[] {
	const v = values[key];
	return Array.isArray(v) ? (v as Row[]) : [];
}

function rowText(row: Row, key: string): string {
	const v = row[key];
	return typeof v === 'string' ? v.trim() : '';
}

function rowNum(row: Row, key: string, fallback = 1): number {
	const v = row[key];
	const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
	return Number.isFinite(n) ? n : fallback;
}

/** Strict integer field: trimmed string that matches /^-?\d+$/ or '' . */
function intField(values: Record<string, unknown>, key: string): string {
	const v = values[key];
	if (typeof v !== 'string') return '';
	const s = v.trim();
	return s && INT_RE.test(s) ? s : '';
}

/** Strict decimal field: trimmed string that matches /^-?\d+(\.\d+)?$/ or ''. */
function floatField(values: Record<string, unknown>, key: string): string {
	const v = values[key];
	if (typeof v !== 'string') return '';
	const s = v.trim();
	return s && FLOAT_RE.test(s) ? s : '';
}

// ---- Java components ----

function buildJavaComponents(values: Record<string, unknown>): string[] {
	const out: string[] = [];

	// Name & lore
	const customName = typeof values.customName === 'string' ? values.customName.trim() : '';
	if (customName) {
		const comp = textComponent(
			customName,
			typeof values.customNameColor === 'string' ? values.customNameColor : undefined,
			values.customNameItalic === false ? false : undefined,
			values.customNameBold === true
		);
		out.push(`minecraft:custom_name=${snbtJson(comp)}`);
	}
	const lore = typeof values.lore === 'string' ? values.lore.trim() : '';
	if (lore) {
		const lines = lore.split(/\n+/).map((l) => l.trim()).filter(Boolean);
		if (lines.length) {
			out.push(`minecraft:lore=[${lines.map((l) => snbtJson(textComponent(l))).join(',')}]`);
		}
	}

	// Enchantments (or stored, for enchanted books). The component is a direct
	// map of enchantment -> level (e.g. enchantments={sharpness:5}).
	const ench = rows(values, 'enchantments').filter((r) => rowText(r, 'enchantment'));
	if (ench.length) {
		const levels = ench.map((r) => `${snbtStr('minecraft:' + r.enchantment)}:${rowNum(r, 'level', 1)}`).join(',');
		const key = values.storedEnchantments === true ? 'minecraft:stored_enchantments' : 'minecraft:enchantments';
		out.push(`${key}={${levels}}`);
	}

	// Durability (strict integers; invalid input is dropped, never injected).
	const damage = intField(values, 'damage');
	if (damage) out.push(`minecraft:damage=${damage}`);
	const maxDamage = intField(values, 'maxDamage');
	if (maxDamage) out.push(`minecraft:max_damage=${maxDamage}`);
	if (values.unbreakable === true) out.push('minecraft:unbreakable={}');

	// Appearance
	const rarity = typeof values.rarity === 'string' ? values.rarity : '';
	if (rarity) out.push(`minecraft:rarity=${snbtStr(rarity)}`);
	if (values.glint === 'true') out.push('minecraft:enchantment_glint_override=true');
	if (values.glint === 'false') out.push('minecraft:enchantment_glint_override=false');
	const cmd = intField(values, 'customModelData');
	if (cmd) out.push(`minecraft:custom_model_data=${cmd}`);
	const itemModel = typeof values.itemModel === 'string' ? values.itemModel.trim() : '';
	if (itemModel) out.push(`minecraft:item_model=${snbtStr(itemModel)}`);
	const dyed = typeof values.dyedColor === 'string' ? values.dyedColor : '';
	const dyedDec = parseColor(dyed);
	if (dyedDec !== null && dyedDec !== 0x813f3f) out.push(`minecraft:dyed_color=${dyedDec}`);
	const trimMat = typeof values.trimMaterial === 'string' ? values.trimMaterial : '';
	const trimPat = typeof values.trimPattern === 'string' ? values.trimPattern : '';
	if (trimMat && trimPat) {
		out.push(`minecraft:trim={material:${snbtStr('minecraft:' + trimMat)},pattern:${snbtStr('minecraft:' + trimPat)}}`);
	}
	const profileName = typeof values.profileName === 'string' ? values.profileName.trim() : '';
	if (profileName) {
		if (values.profileType === 'uuid') {
			out.push(`minecraft:profile={id:${uuidToIntArray(profileName)}}`);
		} else {
			out.push(`minecraft:profile={name:${snbtStr(profileName)}}`);
		}
	}

	// Attribute modifiers
	const attrs = rows(values, 'attributes').filter((r) => rowText(r, 'attribute'));
	if (attrs.length) {
		const mods = attrs.map((r, i) => {
			const id = rowText(r, 'name') || `give:modifier_${i + 1}`;
			return `{type:${snbtStr(rowText(r, 'attribute'))},slot:${snbtStr(rowText(r, 'slot') || 'any')},id:${snbtStr(id)},amount:${rowNum(r, 'amount', 0)},operation:${snbtStr(rowText(r, 'operation') || 'add_value')}}`;
		});
		out.push(`minecraft:attribute_modifiers=[${mods.join(',')}]`);
	}

	// Behavior
	const canBreak = typeof values.canBreak === 'string' ? values.canBreak : '';
	const canBreakPred = blockPredicate(canBreak);
	if (canBreakPred) out.push(`minecraft:can_break=${canBreakPred}`);
	const canPlaceOn = typeof values.canPlaceOn === 'string' ? values.canPlaceOn : '';
	const canPlacePred = blockPredicate(canPlaceOn);
	if (canPlacePred) out.push(`minecraft:can_place_on=${canPlacePred}`);
	const lock = typeof values.lock === 'string' ? values.lock.trim() : '';
	if (lock) out.push(`minecraft:lock={items:[${snbtStr(lock)}]}`);
	if (values.fireResistant === true) out.push('minecraft:damage_resistant={types:"#minecraft:is_fire"}');
	if (values.deathProtection === true) out.push('minecraft:death_protection={}');
	const maxStack = intField(values, 'maxStackSize');
	if (maxStack) out.push(`minecraft:max_stack_size=${maxStack}`);
	const repairCost = intField(values, 'repairCost');
	if (repairCost) out.push(`minecraft:repair_cost=${repairCost}`);
	if (values.hideTooltip === true) out.push('minecraft:tooltip_display={hide_tooltip:true}');
	const enchantable = intField(values, 'enchantable');
	if (enchantable) out.push(`minecraft:enchantable={value:${enchantable}}`);

	// Potion contents
	const potion = typeof values.potion === 'string' ? values.potion : '';
	const potionFx = rows(values, 'potionEffects').filter((r) => rowText(r, 'effect'));
	if (potion && potion !== 'custom') {
		out.push(`minecraft:potion_contents={potion:${snbtStr('minecraft:' + potion)}}`);
	} else if (potionFx.length) {
		const fx = potionFx.map((r) =>
			`{id:${snbtStr('minecraft:' + r.effect)},amplifier:${rowNum(r, 'amplifier', 0)},duration:${rowNum(r, 'duration', 60) * 20}}`
		).join(',');
		out.push(`minecraft:potion_contents={custom_effects:[${fx}]}`);
	}

	// Suspicious stew
	const stew = rows(values, 'stewEffects').filter((r) => rowText(r, 'effect'));
	if (stew.length) {
		const fx = stew.map((r) =>
			`{id:${snbtStr('minecraft:' + r.effect)},duration:${rowNum(r, 'duration', 60) * 20}}`
		).join(',');
		out.push(`minecraft:suspicious_stew_effects=[${fx}]`);
	}

	// Fireworks
	const flightRaw = typeof values.fireworkFlight === 'string' ? values.fireworkFlight.trim() : '';
	const flight = flightRaw && INT_RE.test(flightRaw) ? flightRaw : '';
	const explosions = rows(values, 'fireworkExplosions').filter((r) => rowText(r, 'shape'));
	if (flight || explosions.length) {
		const exps = explosions.map((r) => fireworkExplosionSnbt(r)).join(',');
		out.push(`minecraft:fireworks={flight_duration:${flight || '1'},explosions:[${exps}]}`);
	}

	// Firework star
	const star = rows(values, 'fireworkStar').filter((r) => rowText(r, 'shape'));
	if (star.length) {
		out.push(`minecraft:firework_explosion=${fireworkExplosionSnbt(star[0])}`);
	}

	// Banner patterns
	const banners = rows(values, 'bannerPatterns').filter((r) => rowText(r, 'pattern'));
	if (banners.length) {
		const pats = banners.map((r) =>
			`{pattern:${snbtStr(rowText(r, 'pattern'))},color:${snbtStr(rowText(r, 'color') || 'white')}}`
		).join(',');
		out.push(`minecraft:banner_patterns=[${pats}]`);
	}

	// Container (shulker boxes, chests, barrels...)
	const container = rows(values, 'container').filter((r) => rowText(r, 'item'));
	if (container.length) {
		const slots = container.map((r) =>
			`{slot:${rowNum(r, 'slot', 0)},item:{id:${snbtStr(rowText(r, 'item'))},count:${rowNum(r, 'count', 1)}}}`
		).join(',');
		out.push(`minecraft:container=[${slots}]`);
	}

	// Charged projectiles (crossbow)
	const projectiles = rows(values, 'chargedProjectiles').filter((r) => rowText(r, 'item'));
	if (projectiles.length) {
		const items = projectiles.map((r) => `{id:${snbtStr(rowText(r, 'item'))}}`).join(',');
		out.push(`minecraft:charged_projectiles=[${items}]`);
	}

	// Bundle contents
	const bundle = rows(values, 'bundleContents').filter((r) => rowText(r, 'item'));
	if (bundle.length) {
		const items = bundle.map((r) =>
			`{id:${snbtStr(rowText(r, 'item'))},count:${rowNum(r, 'count', 1)}}`
		).join(',');
		out.push(`minecraft:bundle_contents=[${items}]`);
	}

	// Bees
	const beeCount = parseInt(typeof values.bees === 'string' ? values.bees : '', 10);
	if (Number.isFinite(beeCount) && beeCount > 0) {
		const beeName = typeof values.beeName === 'string' ? values.beeName.trim() : '';
		const customName = beeName ? `,CustomName:${snbtJson(textComponent(beeName))}` : '';
		const bees = new Array(Math.min(beeCount, 16)).fill(0)
			.map(() => `{entity_data:{id:${snbtStr('minecraft:bee')}${customName}},min_ticks_in_hive:600,ticks_in_hive:0}`)
			.join(',');
		out.push(`minecraft:bees=[${bees}]`);
	}

	// Block state
	const blockState = typeof values.blockState === 'string' ? values.blockState : '';
	const stateEntries = parseKvLines(blockState);
	if (stateEntries.length) out.push(`minecraft:block_state={${stateEntries.join(',')}}`);

	// Sign text (lives in the sign block entity, not a standalone component)
	const signLines = [values.signText1, values.signText2, values.signText3, values.signText4]
		.map((l) => (typeof l === 'string' ? l : ''));
	const signSet = signLines.some((l) => l.trim() !== '');
	if (signSet) {
		const messages = signLines.map((l) => snbtJson(textComponent(l.trim()))).join(',');
		const color = typeof values.signTextColor === 'string' ? values.signTextColor : 'black';
		const glow = values.signTextGlow === true ? '1b' : '0b';
		out.push(`minecraft:block_entity_data={id:${snbtStr('minecraft:sign')},front_text:{messages:[${messages}],color:${snbtStr(color)},has_glowing_text:${glow}}}`);
	}

	// Raw block entity data (skipped when sign text is set to avoid duplicates)
	const bed = typeof values.blockEntityData === 'string' ? values.blockEntityData.trim() : '';
	if (bed && !signSet) out.push(`minecraft:block_entity_data=${bed}`);

	// Written book
	const bookTitle = typeof values.bookTitle === 'string' ? values.bookTitle.trim() : '';
	const bookAuthor = typeof values.bookAuthor === 'string' ? values.bookAuthor.trim() : '';
	const bookPages = typeof values.bookPages === 'string' ? values.bookPages : '';
	const writtenPages = bookPages.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	if (bookTitle || bookAuthor || writtenPages.length) {
		const pages = writtenPages.map((p) => snbtJson(textComponent(p))).join(',');
		out.push(`minecraft:written_book_content={title:${snbtStr(bookTitle)},author:${snbtStr(bookAuthor)},pages:[${pages}]}`);
	}

	// Writable book
	const writablePages = typeof values.bookWritablePages === 'string' ? values.bookWritablePages : '';
	const writable = writablePages.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	if (writable.length) {
		out.push(`minecraft:writable_book_content={pages:[${writable.map(snbtStr).join(',')}]}`);
	}

	// Instrument (goat horn)
	const instrument = typeof values.instrument === 'string' ? values.instrument : '';
	if (instrument) out.push(`minecraft:instrument=${snbtStr(instrument)}`);

	// Jukebox song
	const jukebox = typeof values.jukebox === 'string' ? values.jukebox : '';
	if (jukebox) out.push(`minecraft:jukebox_playable=${snbtStr(jukebox)}`);

	// Map id
	const mapId = intField(values, 'mapId');
	if (mapId) out.push(`minecraft:map_id=${mapId}`);

	// Spawn egg entity data
	const entityData = typeof values.entityData === 'string' ? values.entityData.trim() : '';
	if (entityData) out.push(`minecraft:entity_data=${entityData}`);

	// Pot decorations
	const potDeco = rows(values, 'potDecorations').filter((r) => rowText(r, 'item'));
	if (potDeco.length) {
		out.push(`minecraft:pot_decorations=[${potDeco.map((r) => snbtStr(rowText(r, 'item'))).join(',')}]`);
	}

	// Food
	const nutrition = floatField(values, 'foodNutrition');
	const saturationRaw = floatField(values, 'foodSaturation');
	if (nutrition) {
		const sat = saturationRaw || '0.0';
		out.push(`minecraft:food={nutrition:${nutrition},saturation:${sat},can_always_eat:${values.foodCanAlwaysEat === true}}`);
		// food only works alongside consumable; add a minimal one unless customized
		const consumeSecCheck = floatField(values, 'consumableSeconds');
		if (!consumeSecCheck) out.push('minecraft:consumable={}');
	}

	// Consumable
	const consumeSec = floatField(values, 'consumableSeconds');
	if (consumeSec) {
		const anim = typeof values.consumableAnimation === 'string' ? values.consumableAnimation : 'eat';
		out.push(`minecraft:consumable={consume_seconds:${consumeSec},animation:${snbtStr(anim)},has_consume_particles:true}`);
	}

	// Use cooldown
	const cooldown = floatField(values, 'useCooldown');
	if (cooldown) out.push(`minecraft:use_cooldown={seconds:${cooldown}}`);

	// Raw advanced components (appended verbatim)
	const raw = typeof values.rawComponents === 'string' ? values.rawComponents.trim() : '';
	if (raw) out.push(raw.replace(/^,/, ''));

	return out;
}

function fireworkExplosionSnbt(row: Row): string {
	const shape = rowText(row, 'shape');
	const colors = parseColorList(typeof row.colors === 'string' ? row.colors : '');
	const fade = parseColorList(typeof row.fade === 'string' ? row.fade : '');
	const trail = row.trail === true;
	const twinkle = row.twinkle === true;
	return `{shape:${snbtStr(shape)},colors:[${colors.join(',')}],fade_colors:[${fade.join(',')}],has_trail:${trail},has_twinkle:${twinkle}}`;
}

// ---- Bedrock components ----

/** Block names from a Bedrock list field (each row is `{ block: "stone" }`). */
function bedrockBlockList(values: Record<string, unknown>, key: string): string[] {
	const v = values[key];
	if (!Array.isArray(v)) return [];
	return (v as Row[]).map((r) => rowText(r, 'block')).filter(Boolean);
}

function buildBedrockComponents(values: Record<string, unknown>): { json: string; error?: string } {
	const obj: Record<string, unknown> = {};

	// Bedrock's /give JSON only accepts a small fixed set of components:
	// can_place_on, can_destroy, item_lock and keep_on_death. Enchantments are
	// not supported there, so nothing else is emitted here.
	const canDestroy = bedrockBlockList(values, 'bedrockCanDestroy');
	if (canDestroy.length) obj['minecraft:can_destroy'] = { blocks: canDestroy };

	const canPlaceOn = bedrockBlockList(values, 'bedrockCanPlaceOn');
	if (canPlaceOn.length) obj['minecraft:can_place_on'] = { blocks: canPlaceOn };

	const lockMode = typeof values.bedrockItemLock === 'string' ? values.bedrockItemLock : '';
	if (lockMode) obj['minecraft:item_lock'] = { mode: lockMode };

	if (values.bedrockKeepOnDeath === true) obj['minecraft:keep_on_death'] = {};

	// Merge raw advanced JSON (validated, prototype-pollution-safe).
	const raw = typeof values.bedrockRawComponents === 'string' ? values.bedrockRawComponents.trim() : '';
	if (raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return { json: '', error: 'errorRawJsonObject' };
			}
			safeMerge(obj, parsed as Record<string, unknown>);
		} catch {
			return { json: '', error: 'errorRawJson' };
		}
	}

	const entries = Object.entries(obj);
	if (entries.length === 0) return { json: '' };
	return { json: JSON.stringify(Object.fromEntries(entries)) };
}

// ---- Command assembly ----

function resolveTarget(state: GiveState): string {
	if (state.target === 'custom' || state.target === 'name') return state.customTarget.trim() || '@p';
	const t = (state.target || '').trim();
	if (SELECTOR_WHITELIST.has(t)) return t;
	if (SELECTOR_ARGS_RE.test(t)) return t;
	if (PLAYER_NAME_RE.test(t)) return t;
	if (UUID_RE.test(t)) return t;
	return '@p';
}

export function buildJavaCommand(state: GiveState): BuildResult {
	const itemId = state.itemId.trim();
	if (!itemId) return { command: '', error: 'errorNoItem' };

	const components = buildJavaComponents(state.values);
	const item = components.length ? `${itemId}[${components.join(',')}]` : itemId;
	const count = Math.max(1, Math.min(2147483647, Math.floor(state.count) || 1));
	return { command: `/give ${resolveTarget(state)} ${item} ${count}` };
}

export function buildBedrockCommand(state: GiveState): BuildResult {
	const itemId = state.itemId.trim();
	if (!itemId) return { command: '', error: 'errorNoItem' };

	// Resolve the Java catalogue ID to the Bedrock item name + data value.
	const resolved = resolveBedrockItem(itemId);
	if (!resolved.available) return { command: '', error: 'errorBedrockUnavailable' };

	const amount = Math.max(1, Math.min(32767, Math.floor(state.count) || 1));
	const parts: string[] = [`/give ${resolveTarget(state)}`, 'minecraft:' + resolved.id, String(amount)];

	// Mapped data value wins unless the user has edited the field manually.
	const mappedData = resolved.data ?? 0;
	const data = state.dataOverridden
		? Math.max(0, Math.min(32767, Math.floor(state.dataValue) || 0))
		: Math.max(0, Math.min(32767, Math.floor(mappedData) || 0));
	const comps = buildBedrockComponents(state.values);
	if (comps.error) return { command: '', error: comps.error };

	if (data !== 0 || comps.json) parts.push(String(data));
	if (comps.json) parts.push(comps.json);

	return { command: parts.join(' ') };
}

export function buildCommand(state: GiveState): BuildResult {
	return state.platform === 'java' ? buildJavaCommand(state) : buildBedrockCommand(state);
}
