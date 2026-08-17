// Adds Spanish display names (displayNameEs) to public/data/items.json.
// Run this after scripts/extract-data.mjs regenerates the data, so the
// Minecraft Items tool can show names in Spanish as well as English.
//
// Usage: node scripts/translate-items.mjs

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const LANG_URL = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/26.1/assets/minecraft/lang/es_es.json';

async function fetchLang() {
	const res = await fetch(LANG_URL, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`Failed to fetch es_es.json: HTTP ${res.status}`);
	return await res.json();
}

/**
 * Spanish display name for the synthetic (generated) potion items, whose ids
 * are >= 900000 and whose `name` slugs follow the generatePotions() convention:
 *   water_bottle | awkward_potion | mundane_potion | thick_potion
 *   [splash_|lingering_]potion_of_<effect>[_II|_extended]
 */
function potionEsName(name, lang) {
	const basePotions = {
		water_bottle: 'water',
		awkward_potion: 'awkward',
		mundane_potion: 'mundane',
		thick_potion: 'thick'
	};
	if (basePotions[name] !== undefined) {
		return lang[`item.minecraft.potion.effect.${basePotions[name]}`] || null;
	}
	const m = name.match(/^(splash_|lingering_)?potion_of_([a-z_]+?)(?:_(II|extended))?$/);
	if (!m) return null;
	const form = m[1] ? m[1].slice(0, -1) : 'normal';
	const effectKey = m[2];
	const variant = m[3] || 'I';
	const carrier = form === 'splash' ? 'splash_potion' : form === 'lingering' ? 'lingering_potion' : 'potion';
	const base = lang[`item.minecraft.${carrier}.effect.${effectKey}`] || null;
	if (!base) return null;
	if (variant === 'II') return `${base} II`;
	if (variant === 'extended') return `${base} (Extendida)`;
	return base;
}

async function main() {
	const itemsPath = join(root, 'public', 'data', 'items.json');
	const items = JSON.parse(readFileSync(itemsPath, 'utf8'));
	const lang = await fetchLang();

	let fallback = 0;
	for (const item of items) {
		let es = null;
		if (item.id >= 900000) {
			es = potionEsName(item.name, lang);
		} else {
			const clean = item.name.replace('minecraft:', '');
			es = lang[`item.minecraft.${clean}`] || lang[`block.minecraft.${clean}`] || null;
		}
		if (!es) {
			fallback++;
			es = item.displayName;
		}
		item.displayNameEs = es;
	}

	writeFileSync(itemsPath, JSON.stringify(items));
	console.log(`Added displayNameEs to ${items.length} items (${fallback} fell back to English).`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
