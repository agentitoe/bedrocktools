// Command builders for the /give Command Generator.
// Pure functions: given the form state they produce the command string.
// Kept free of DOM access so the logic is unit-testable.

import type { BuildResult, GiveState } from './types';
import { resolveBedrockItem } from './bedrock-ids';

// ---- SNBT / text helpers ----

/** Double-quoted SNBT string. */
export function snbtStr(value: string): string {
	return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** JSON text component wrapped in single quotes (safe inside item brackets). */
export function snbtJson(json: string): string {
	return "'" + json.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** Build a Minecraft JSON text component `{"text":...,"color":...}`. */
export function textComponent(text: string, color?: string, italic?: boolean, bold?: boolean): string {
	const parts = [`"text":${JSON.stringify(text)}`];
	if (color && color !== 'white') parts.push(`"color":"${color}"`);
	if (italic !== undefined) parts.push(`"italic":${italic}`);
	if (bold) parts.push(`"bold":true`);
	return '{' + parts.join(',') + '}';
}

/** Split a comma/whitespace separated block list (allows "#tag" and "block:data"). */
export function parseBlockList(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** "#rrggbb" or decimal int -> decimal color int (null when unparseable). */
export function parseColor(input: string): number | null {
	const s = input.trim();
	if (!s) return null;
	if (s.startsWith('#')) {
		const hex = s.slice(1);
		if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
		return parseInt(hex, 16);
	}
	if (/^\d+$/.test(s)) return parseInt(s, 10);
	return null;
}

/** "16711680, #ff0000, 65280" -> [16711680, 65280]. */
export function parseColorList(text: string): number[] {
	return text
		.split(/[\s,]+/)
		.map((c) => parseColor(c))
		.filter((c): c is number => c !== null);
}

/** Parse `key=value` lines into SNBT compound entries. */
export function parseKvLines(text: string): string[] {
	return text
		.split(/\n|;/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const eq = line.indexOf('=');
			if (eq <= 0) return null;
			const key = line.slice(0, eq).trim();
			let value = line.slice(eq + 1).trim();
			if (/^-?\d+$/.test(value)) {
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
	if (/^-?\d+$/.test(value)) return `${key}:${value}`;
	if (value === 'true' || value === 'false') return `${key}:${value}`;
	return `${key}:${snbtStr(value)}`;
}

/** Convert a UUID string (with or without dashes) to SNBT int-array form [I;...]. */
export function uuidToIntArray(uuid: string): string {
	const hex = uuid.replace(/-/g, '');
	if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
		// Not a valid UUID; keep the raw value so the command still shows something.
		return `[I;${hex}]`;
	}
	const parts: number[] = [];
	for (let i = 0; i < 32; i += 8) {
		parts.push(parseInt(hex.slice(i, i + 8), 16) | 0);
	}
	return `[I;${parts.join(',')}]`;
}

function blockPredicate(text: string): string | null {
	const blocks = parseBlockList(text);
	if (blocks.length === 0) return null;
	const list = blocks.map(snbtStr).join(',');
	return blocks.length === 1
		? `{blocks:${snbtStr(blocks[0])}}`
		: `{blocks:[${list}]}`;
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

	// Durability
	const damage = typeof values.damage === 'string' ? values.damage.trim() : '';
	if (damage) out.push(`minecraft:damage=${damage}`);
	const maxDamage = typeof values.maxDamage === 'string' ? values.maxDamage.trim() : '';
	if (maxDamage) out.push(`minecraft:max_damage=${maxDamage}`);
	if (values.unbreakable === true) out.push('minecraft:unbreakable={}');

	// Appearance
	const rarity = typeof values.rarity === 'string' ? values.rarity : '';
	if (rarity) out.push(`minecraft:rarity=${snbtStr(rarity)}`);
	if (values.glint === 'true') out.push('minecraft:enchantment_glint_override=true');
	if (values.glint === 'false') out.push('minecraft:enchantment_glint_override=false');
	const cmd = typeof values.customModelData === 'string' ? values.customModelData.trim() : '';
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
	const maxStack = typeof values.maxStackSize === 'string' ? values.maxStackSize.trim() : '';
	if (maxStack) out.push(`minecraft:max_stack_size=${maxStack}`);
	const repairCost = typeof values.repairCost === 'string' ? values.repairCost.trim() : '';
	if (repairCost) out.push(`minecraft:repair_cost=${repairCost}`);
	if (values.hideTooltip === true) out.push('minecraft:tooltip_display={hide_tooltip:true}');
	const enchantable = typeof values.enchantable === 'string' ? values.enchantable.trim() : '';
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
	const flight = typeof values.fireworkFlight === 'string' ? values.fireworkFlight.trim() : '';
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
	const mapId = typeof values.mapId === 'string' ? values.mapId.trim() : '';
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
	const nutrition = typeof values.foodNutrition === 'string' ? values.foodNutrition.trim() : '';
	const saturation = typeof values.foodSaturation === 'string' ? values.foodSaturation.trim() : '';
	if (nutrition) {
		const sat = saturation || '0.0';
		out.push(`minecraft:food={nutrition:${nutrition},saturation:${sat},can_always_eat:${values.foodCanAlwaysEat === true}}`);
		// food only works alongside consumable; add a minimal one unless customized
		const consumeSec = typeof values.consumableSeconds === 'string' ? values.consumableSeconds.trim() : '';
		if (!consumeSec) out.push('minecraft:consumable={}');
	}

	// Consumable
	const consumeSec = typeof values.consumableSeconds === 'string' ? values.consumableSeconds.trim() : '';
	if (consumeSec) {
		const anim = typeof values.consumableAnimation === 'string' ? values.consumableAnimation : 'eat';
		out.push(`minecraft:consumable={consume_seconds:${consumeSec},animation:${snbtStr(anim)},has_consume_particles:true}`);
	}

	// Use cooldown
	const cooldown = typeof values.useCooldown === 'string' ? values.useCooldown.trim() : '';
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

	// Merge raw advanced JSON (validated).
	const raw = typeof values.bedrockRawComponents === 'string' ? values.bedrockRawComponents.trim() : '';
	if (raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return { json: '', error: 'errorRawJsonObject' };
			}
			Object.assign(obj, parsed);
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
	if (state.target === 'custom') return state.customTarget.trim() || '@p';
	return state.target;
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
