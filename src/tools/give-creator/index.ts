// /give Command Generator
// Build custom /give commands for Minecraft Java and Bedrock. Picks an item
// from the shared items.json catalogue and lets you configure every platform
// component through a generic option form; the command updates live.
//
// Structure of this module:
// - STATE: catalogue arrays + O(1) lookup Maps (built once in `loadItems`).
// - RENDER: pure-ish DOM builders (picker, form, preview, output).
// - EVENTS: wiring (delegated where lists can grow large, debounced searches).

import { initUi } from '../../shared/ui';
import type { FieldDef, FieldOption, GiveTranslations, ItemData, Platform } from './types';
import { translations } from './translations';
import { sectionsFor } from './options';
import { resetValues, setPlatform, setValue, state } from './state';
import { setCatalogue, catalogueGetByName } from './data';
import { buildCommand } from './builder';
import { bedrockPotionDataList, resolveBedrockItem } from './bedrock-ids';
import type { BedrockPotionEntry } from './bedrock-ids';
import { createImgTag } from './images';

// ---- STATE ----

let currentLang = 'es';
let allItems: ItemData[] = [];
let potionItems: ItemData[] = []; // synthetic potions (id >= 900000), only shown on Bedrock
/** Bare-name → item for the current catalogue (rebuilt in `loadItems`). */
let itemByName = new Map<string, ItemData>();

function rebuildItemIndex(): void {
	setCatalogue([...allItems, ...potionItems]);
	itemByName = new Map<string, ItemData>();
	for (const item of allItems) {
		const key = item.name.toLowerCase();
		if (!itemByName.has(key)) itemByName.set(key, item);
	}
	for (const item of potionItems) {
		const key = item.name.toLowerCase();
		if (!itemByName.has(key)) itemByName.set(key, item);
	}
}

function findItem(name: string): ItemData | undefined {
	const bare = name.replace(/^minecraft:/, '').trim().toLowerCase();
	return itemByName.get(bare) ?? catalogueGetByName(bare);
}

/** Central HTML escaper for this tool (covers `&<>"'`). */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function t(): GiveTranslations {
	return translations[currentLang];
}

/** Trailing-edge debounce (search inputs, quick search). */
function debounce<F extends (...args: never[]) => void>(fn: F, ms: number): F {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return ((...args: never[]) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, ms);
	}) as F;
}

// ---- Item picker (all items, filtered by category + search, chunked render) ----

type CategoryKey = 'all' | 'blocks' | 'tools' | 'armor' | 'food' | 'eggs' | 'potions' | 'other';

const FOOD_NAMES = new Set([
	'apple', 'bread', 'cooked_beef', 'beef', 'cooked_porkchop', 'porkchop',
	'cooked_chicken', 'chicken', 'cooked_mutton', 'mutton', 'cooked_rabbit', 'rabbit',
	'cooked_cod', 'cod', 'cooked_salmon', 'salmon', 'tropical_fish', 'pufferfish',
	'carrot', 'golden_carrot', 'potato', 'baked_potato', 'poisonous_potato',
	'beetroot', 'beetroot_soup', 'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
	'cookie', 'pumpkin_pie', 'cake', 'melon_slice', 'sweet_berries', 'glow_berries',
	'honey_bottle', 'dried_kelp', 'rotten_flesh', 'spider_eye', 'chorus_fruit',
	'egg', 'milk_bucket', 'kelp',
]);

function itemCategory(item: ItemData): CategoryKey {
	if (item.id >= 900000) return 'potions';
	if (item.name.endsWith('spawn_egg')) return 'eggs';
	if (item.renderAs === 'block') return 'blocks';
	if (/sword|pickaxe|axe|shovel|hoe|shears|fishing_rod|bow|crossbow|trident|mace|brush|spyglass|flint_and_steel/.test(item.name)) return 'tools';
	if (/helmet|chestplate|leggings|boots|elytra|shield|horse_armor/.test(item.name)) return 'armor';
	if (FOOD_NAMES.has(item.name)) return 'food';
	return 'other';
}

const CATEGORY_KEYS: CategoryKey[] = ['all', 'blocks', 'tools', 'armor', 'food', 'eggs', 'potions', 'other'];

/** Potions only make sense on Bedrock (on Java they are set via the potion section). */
function pickerItems(): ItemData[] {
	return state.platform === 'bedrock' ? [...allItems, ...potionItems] : allItems;
}

let pickerFiltered: ItemData[] = [];
let pickerRendered = 0;
const PICKER_CHUNK = 240;
let pickerChunkScheduled = false;

function pickerMatches(item: ItemData, query: string, category: CategoryKey): boolean {
	if (category !== 'all' && itemCategory(item) !== category) return false;
	if (!query) return true;
	return item.displayName.toLowerCase().includes(query)
		|| (item.displayNameEs || '').toLowerCase().includes(query)
		|| item.name.includes(query);
}

function buildPickerItem(item: ItemData, index: number): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'picker-item';
	btn.dataset.index = String(index);
	btn.appendChild(createImgTag(item, 48));
	const meta = document.createElement('div');
	meta.className = 'picker-meta';
	const name = document.createElement('span');
	name.className = 'picker-name';
	name.textContent = currentLang === 'es' && item.displayNameEs ? item.displayNameEs : item.displayName;
	const id = document.createElement('span');
	id.className = 'picker-id';
	id.textContent = 'minecraft:' + item.name;
	meta.appendChild(name);
	meta.appendChild(id);
	btn.appendChild(meta);
	return btn;
}

function renderPickerChunk() {
	pickerChunkScheduled = false;
	const grid = document.getElementById('pickerGrid');
	if (!grid) return;
	const end = Math.min(pickerFiltered.length, pickerRendered + PICKER_CHUNK);
	if (end <= pickerRendered) return;
	const frag = document.createDocumentFragment();
	for (let i = pickerRendered; i < end; i++) {
		frag.appendChild(buildPickerItem(pickerFiltered[i], i));
	}
	grid.appendChild(frag);
	pickerRendered = end;
}

function schedulePickerChunk() {
	if (pickerChunkScheduled) return;
	pickerChunkScheduled = true;
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(renderPickerChunk);
	} else {
		setTimeout(renderPickerChunk, 0);
	}
}

function resetPickerList(query: string, category: CategoryKey) {
	const q = query.toLowerCase().trim();
	pickerFiltered = pickerItems().filter((item) => pickerMatches(item, q, category));
	pickerRendered = 0;
	const grid = document.getElementById('pickerGrid');
	if (!grid) return;
	grid.innerHTML = '';
	if (pickerFiltered.length === 0) {
		grid.innerHTML = `<p class="picker-empty">${t().pickerEmpty}</p>`;
		return;
	}
	// First chunk renders synchronously so the dialog never looks empty;
	// further chunks stream in via scroll + rAF.
	renderPickerChunk();
}

function openPicker(initialQuery = '') {
	const lang = t();
	const overlay = document.createElement('div');
	overlay.className = 'picker-overlay';
	overlay.innerHTML = `
		<div class="picker" role="dialog" aria-modal="true">
			<div class="picker-head">
				<span class="picker-title">${lang.pickTitle}</span>
				<button class="picker-close" type="button" aria-label="Close">✕</button>
			</div>
			<input type="text" id="pickerSearch" class="picker-search" placeholder="${lang.searchPlaceholder}" autocomplete="off">
			<div class="picker-cats" id="pickerCats">
				${CATEGORY_KEYS
					.filter((c) => c !== 'potions' || state.platform === 'bedrock')
					.map((c) => `<button type="button" class="cat-chip" data-cat="${c}">${escapeHtml(lang['cat' + c[0].toUpperCase() + c.slice(1)] ?? c)}</button>`).join('')}
			</div>
			<div class="picker-grid" id="pickerGrid"></div>
		</div>
	`;
	document.body.appendChild(overlay);

	const search = overlay.querySelector('#pickerSearch') as HTMLInputElement;
	const grid = overlay.querySelector('#pickerGrid') as HTMLElement;
	const cats = overlay.querySelector('#pickerCats') as HTMLElement;

	let category: CategoryKey = 'all';
	const apply = () => resetPickerList(search.value, category);
	const debouncedApply = debounce(apply, 150);

	overlay.querySelector('.picker-close')?.addEventListener('click', () => overlay.remove());
	overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
	search.addEventListener('input', debouncedApply);
	// Category chips: one delegated listener instead of one per chip.
	cats.addEventListener('click', (e) => {
		const chip = (e.target as HTMLElement).closest('.cat-chip') as HTMLElement | null;
		if (!chip) return;
		cats.querySelectorAll('.cat-chip').forEach((c) => c.classList.remove('active'));
		chip.classList.add('active');
		category = chip.getAttribute('data-cat') as CategoryKey;
		apply();
	});
	// Picker rows: one delegated listener for all (present + future) chunks.
	grid.addEventListener('click', (e) => {
		const btn = (e.target as HTMLElement).closest('.picker-item') as HTMLElement | null;
		if (!btn) return;
		const item = pickerFiltered[parseInt(btn.dataset.index || '-1', 10)];
		if (!item) return;
		selectItem(item);
		btn.closest('.picker-overlay')?.remove();
	});
	let scrollTicking = false;
	grid.addEventListener('scroll', () => {
		if (scrollTicking) return;
		scrollTicking = true;
		const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout;
		schedule(() => {
			scrollTicking = false;
			if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 300) schedulePickerChunk();
		});
	});

	search.value = initialQuery;
	overlay.querySelector('.cat-chip[data-cat="all"]')?.classList.add('active');
	apply();
	search.focus();
}

// ---- Quick search (mini dropdown in the main card) ----

function paintQuickResults(matches: ItemData[]) {
	const list = document.getElementById('quickResults');
	if (!list) return;
	if (matches.length === 0) {
		list.innerHTML = `<div class="quick-empty">${t().pickerEmpty}</div>`;
		list.style.display = '';
		return;
	}
	list.innerHTML = '';
	const frag = document.createDocumentFragment();
	for (let i = 0; i < matches.length; i++) {
		const item = matches[i];
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'quick-row';
		row.dataset.index = String(i);
		row.appendChild(createImgTag(item, 28));
		const span = document.createElement('span');
		span.textContent = currentLang === 'es' && item.displayNameEs ? item.displayNameEs : item.displayName;
		const code = document.createElement('code');
		code.textContent = 'minecraft:' + item.name;
		row.appendChild(span);
		row.appendChild(code);
		frag.appendChild(row);
	}
	list.appendChild(frag);
	list.style.display = '';
	// Stash the current matches for the delegated click handler.
	(list as HTMLElement & { __matches?: ItemData[] }).__matches = matches;
}

function runQuickSearch(query: string) {
	const list = document.getElementById('quickResults');
	if (!list) return;
	const q = query.toLowerCase().trim();
	if (!q) {
		list.innerHTML = '';
		list.style.display = 'none';
		return;
	}
	// Bounded: never build more than 8 rows per keystroke.
	const matches = pickerItems().filter((item) => pickerMatches(item, q, 'all')).slice(0, 8);
	paintQuickResults(matches);
}

const debouncedQuickSearch = debounce(runQuickSearch, 150);

function wireQuickResultsOnce() {
	const list = document.getElementById('quickResults');
	if (!list || (list as HTMLElement & { __wired?: boolean }).__wired) return;
	(list as HTMLElement & { __wired?: boolean }).__wired = true;
	list.addEventListener('mousedown', (e) => {
		if ((e.target as HTMLElement).closest('.quick-row')) e.preventDefault();
	});
	list.addEventListener('click', (e) => {
		const row = (e.target as HTMLElement).closest('.quick-row') as HTMLElement | null;
		if (!row) return;
		const matches = (list as HTMLElement & { __matches?: ItemData[] }).__matches || [];
		const item = matches[parseInt(row.dataset.index || '-1', 10)];
		if (!item) return;
		selectItem(item);
		list.innerHTML = '';
		list.style.display = 'none';
		const input = document.getElementById('quickSearch') as HTMLInputElement | null;
		if (input) input.value = '';
	});
}

// ---- Item selection + Bedrock resolution ----

function selectItem(item: ItemData) {
	state.itemId = 'minecraft:' + item.name;
	const input = document.getElementById('itemIdInput') as HTMLInputElement | null;
	if (input) input.value = state.itemId;
	syncDataValue();
	updateItemPreview();
	renderBedrockInfo();
	renderOutput();
}

/** Recompute the Bedrock data value from the current item (unless overridden). */
function syncDataValue() {
	const resolved = resolveBedrockItem(state.itemId);
	state.dataOverridden = false;
	state.dataValue = resolved.available && resolved.data !== undefined ? resolved.data : 0;
	const input = document.getElementById('dataValueInput') as HTMLInputElement | null;
	if (input) input.value = String(state.dataValue);
	updatePotionSelect();
}

// ---- Bedrock potion / tipped-arrow data selector ----

/** Build the label of one dropdown entry (translated). */
function potionEntryLabel(e: BedrockPotionEntry, kind: 'potion' | 'arrow', lang: GiveTranslations): string {
	let name: string;
	if (e.base) {
		name = lang['potionBase_' + e.base] ?? e.base;
	} else {
		name = lang['fx_' + e.effect] ?? e.effect ?? '';
		if (e.variant === 'extended') name += lang.potionLongSuffix;
		else if (e.variant === 'II') name += ' II';
	}
	if (kind === 'potion') {
		const res = resolveBedrockItem(state.itemId);
		if (res.id === 'splash_potion') name = lang.potionSplashPrefix + name;
		else if (res.id === 'lingering_potion') name = lang.potionLingeringPrefix + name;
	}
	return `${name} (${e.data})`;
}

/** Show/hide the Bedrock potion/arrow dropdown and sync it with the data input. */
function updatePotionSelect() {
	const sel = document.getElementById('potionDataSelect') as HTMLSelectElement | null;
	if (!sel) return;
	const lang = t();

	const resolved = resolveBedrockItem(state.itemId);
	let kind: 'potion' | 'arrow' | null = null;
	if (resolved.id === 'potion' || resolved.id === 'splash_potion' || resolved.id === 'lingering_potion') kind = 'potion';
	else if (resolved.id === 'arrow') kind = 'arrow';

	if (state.platform !== 'bedrock' || !kind) {
		sel.style.display = 'none';
		const label = document.getElementById('dataValueLabel');
		if (label) label.textContent = lang.dataValueLabel;
		return;
	}

	// Swap the field label while the dropdown is shown.
	const label = document.getElementById('dataValueLabel');
	if (label) label.textContent = kind === 'potion' ? lang.potionSelectLabel : lang.arrowSelectLabel;

	sel.innerHTML = bedrockPotionDataList(kind)
		.map((e) => `<option value="${e.data}">${escapeHtml(potionEntryLabel(e, kind, lang))}</option>`)
		.join('');
	sel.value = String(state.dataValue);
	sel.style.display = '';
}

function updateItemPreview() {
	const preview = document.getElementById('itemPreview');
	if (!preview) return;
	const item = findItem(state.itemId);
	if (!item) {
		preview.innerHTML = `<span class="preview-ph">❓</span>`;
		return;
	}
	const name = currentLang === 'es' && item.displayNameEs ? item.displayNameEs : item.displayName;
	preview.innerHTML = '';
	preview.appendChild(createImgTag(item, 48));
	const span = document.createElement('span');
	span.textContent = name;
	preview.appendChild(span);
}

/** Show how the current item resolves in Bedrock (renames, data, availability). */
function renderBedrockInfo() {
	const el = document.getElementById('bedrockInfo');
	if (!el) return;
	const resolved = resolveBedrockItem(state.itemId);
	if (state.platform !== 'bedrock') {
		el.style.display = 'none';
		return;
	}
	if (!resolved.available) {
		el.style.display = '';
		el.className = 'bedrock-info error';
		el.textContent = t().errorBedrockUnavailable;
		return;
	}
	if (!resolved.renamed && resolved.data === undefined) {
		el.style.display = 'none';
		return;
	}
	el.style.display = '';
	el.className = 'bedrock-info';
	el.textContent = `${t().bedrockResolved} minecraft:${resolved.id}${resolved.data !== undefined ? ` · ${t().bedrockResolvedData} ${resolved.data}` : ''}`;
}

// ---- Generic option form (render) ----

function optsHtml(options: FieldOption[] | undefined, value: unknown, lang: GiveTranslations): string {
	if (!options) return '';
	return options.map((o) => {
		const label = o.labelKey ? (lang[o.labelKey] ?? o.labelKey) : (o.label ?? o.value);
		const sel = String(value) === o.value ? ' selected' : '';
		return `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(label)}</option>`;
	}).join('');
}

/** Autocomplete list attribute + <datalist> element for text inputs. */
function datalistHtml(field: FieldDef, id: string): { attr: string; html: string } {
	if (!field.datalist || field.datalist.length === 0) return { attr: '', html: '' };
	const options = field.datalist.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
	return { attr: ` list="${id}"`, html: `<datalist id="${id}">${options}</datalist>` };
}

function fieldHtml(field: FieldDef, value: unknown, lang: GiveTranslations): string {
	const label = lang[field.labelKey] ?? field.labelKey;
	const help = field.helpKey ? `<p class="hint">${escapeHtml(lang[field.helpKey] ?? '')}</p>` : '';
	const ph = field.placeholderKey ? escapeHtml(lang[field.placeholderKey] ?? '') : '';
	const v = value === undefined || value === null ? '' : String(value);

	switch (field.type) {
		case 'text': {
			const dl = datalistHtml(field, `dl-${field.key}`);
			return `<div class="opt-field"><label class="editor-label">${label}</label><input type="text" class="text-input" data-key="${field.key}" value="${escapeHtml(v)}" placeholder="${ph}" spellcheck="false" autocomplete="off"${dl.attr}>${dl.html}${help}</div>`;
		}
		case 'number':
			return `<div class="opt-field"><label class="editor-label">${label}</label><input type="number" class="text-input" data-key="${field.key}" value="${escapeHtml(v)}" min="${field.min ?? ''}" max="${field.max ?? ''}" step="${field.step ?? ''}">${help}</div>`;
		case 'checkbox':
			return `<div class="opt-field"><label class="check-label"><input type="checkbox" data-key="${field.key}"${value === true ? ' checked' : ''}> ${label}</label>${help}</div>`;
		case 'select':
		case 'mcColor':
			return `<div class="opt-field"><label class="editor-label">${label}</label><select class="station-select" data-key="${field.key}">${optsHtml(field.options, value, lang)}</select>${help}</div>`;
		case 'color':
			return `<div class="opt-field"><label class="editor-label">${label}</label><input type="color" class="color-input" data-key="${field.key}" value="${/^#[0-9a-fA-F]{6}$/.test(v) ? v : '#813f3f'}">${help}</div>`;
		case 'textarea':
			return `<div class="opt-field"><label class="editor-label">${label}</label><textarea class="text-input area" data-key="${field.key}" rows="3" placeholder="${ph}" spellcheck="false">${escapeHtml(v)}</textarea>${help}</div>`;
		case 'list':
			return listFieldHtml(field, value, lang);
	}
	return '';
}

function listFieldHtml(field: FieldDef, value: unknown, lang: GiveTranslations): string {
	const label = lang[field.labelKey] ?? field.labelKey;
	const help = field.helpKey ? `<p class="hint">${escapeHtml(lang[field.helpKey] ?? '')}</p>` : '';
	const rows = Array.isArray(value) ? value : [];
	const body = rows.map((row, i) => {
		const fields = (field.listFields || [])
			.map((f) => rowFieldHtml(f, (row as Record<string, unknown>)[f.key], i, lang))
			.join('');
		return `<div class="list-row" data-row="${i}">${fields}<button type="button" class="row-remove" data-remove="${i}" title="${escapeHtml(lang.removeRow)}">✕</button></div>`;
	}).join('');
	return `<div class="opt-field" data-list="${field.key}"><label class="editor-label">${label}</label>${help}${body}<button type="button" class="btn btn-ghost row-add" data-add="${field.key}">${escapeHtml(lang.addRow)}</button></div>`;
}

function rowFieldHtml(field: FieldDef, value: unknown, index: number, lang: GiveTranslations): string {
	const label = lang[field.labelKey] ?? field.labelKey;
	const v = value === undefined || value === null ? '' : String(value);
	const ph = field.rowPlaceholder ? escapeHtml(field.rowPlaceholder) : '';
	switch (field.type) {
		case 'text': {
			const dl = datalistHtml(field, `dl-${field.key}-${index}`);
			return `<div class="row-field"><label class="row-label">${label}</label><input type="text" class="text-input" data-row-key="${field.key}" data-index="${index}" value="${escapeHtml(v)}" placeholder="${ph}" spellcheck="false" autocomplete="off"${dl.attr}>${dl.html}</div>`;
		}
		case 'number':
			return `<div class="row-field"><label class="row-label">${label}</label><input type="number" class="text-input" data-row-key="${field.key}" data-index="${index}" value="${escapeHtml(v)}" min="${field.min ?? ''}" max="${field.max ?? ''}" step="${field.step ?? ''}"></div>`;
		case 'select':
			return `<div class="row-field"><label class="row-label">${label}</label><select class="station-select" data-row-key="${field.key}" data-index="${index}">${optsHtml(field.options, value, lang)}</select></div>`;
		case 'checkbox':
			return `<div class="row-field"><label class="row-check"><input type="checkbox" data-row-key="${field.key}" data-index="${index}"${value === true ? ' checked' : ''}> ${label}</label></div>`;
		default:
			return '';
	}
}

function readControl(el: HTMLElement): unknown {
	if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
	if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return el.value;
	return '';
}

function newRow(listFields: FieldDef[]): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	for (const f of listFields) {
		row[f.key] = f.defaultValue !== undefined ? f.defaultValue : (f.type === 'checkbox' ? false : '');
	}
	return row;
}

function findField(key: string): FieldDef | undefined {
	for (const section of sectionsFor(state.platform)) {
		const found = section.fields.find((f) => f.key === key);
		if (found) return found;
	}
	return undefined;
}

// ---- Generic option form (events: single delegated listener set) ----

/**
 * Wire the option form with three delegated listeners (input/change/click) on
 * the container. Replaces the previous per-control listener fan-out, so forms
 * with hundreds of row inputs cost O(1) listeners. Idempotent across
 * `renderSections()` re-renders (the container element itself persists).
 */
function wireFields(container: HTMLElement) {
	if ((container as HTMLElement & { __wired?: boolean }).__wired) return;
	(container as HTMLElement & { __wired?: boolean }).__wired = true;

	const readKey = (el: HTMLElement): string | null => el.getAttribute('data-key');
	const readRowKey = (el: HTMLElement): { listKey: string; subKey: string; index: number } | null => {
		const subKey = el.getAttribute('data-row-key');
		if (!subKey) return null;
		const listEl = el.closest<HTMLElement>('[data-list]');
		if (!listEl) return null;
		return {
			listKey: listEl.getAttribute('data-list')!,
			subKey,
			index: parseInt(el.getAttribute('data-index') || '0', 10),
		};
	};

	// Text/number/textarea/checkbox writes (selects are handled on 'change').
	container.addEventListener('input', (e) => {
		const target = e.target as HTMLElement | null;
		if (!target || target instanceof HTMLSelectElement) return;
		if (readKey(target)) {
			setValue(readKey(target)!, readControl(target));
			renderOutput();
			return;
		}
		const row = target instanceof HTMLElement ? readRowKey(target) : null;
		if (row) {
			const list = state.values[row.listKey];
			if (Array.isArray(list) && list[row.index]) {
				(list[row.index] as Record<string, unknown>)[row.subKey] = readControl(target);
			}
			renderOutput();
		}
	});

	// Select writes.
	container.addEventListener('change', (e) => {
		const target = e.target as HTMLElement | null;
		if (!target || !(target instanceof HTMLSelectElement)) return;
		if (readKey(target)) {
			setValue(readKey(target)!, readControl(target));
			renderOutput();
			return;
		}
		const row = readRowKey(target);
		if (row) {
			const list = state.values[row.listKey];
			if (Array.isArray(list) && list[row.index]) {
				(list[row.index] as Record<string, unknown>)[row.subKey] = readControl(target);
			}
			renderOutput();
		}
	});

	// Add/remove list rows (delegation with data-action attributes).
	container.addEventListener('click', (e) => {
		const target = e.target as HTMLElement | null;
		if (!target) return;
		const removeBtn = target.closest<HTMLButtonElement>('[data-remove]');
		if (removeBtn && container.contains(removeBtn)) {
			const listEl = removeBtn.closest<HTMLElement>('[data-list]');
			if (!listEl) return;
			const listKey = listEl.getAttribute('data-list')!;
			const index = parseInt(removeBtn.getAttribute('data-remove') || '0', 10);
			const list = state.values[listKey];
			if (Array.isArray(list)) {
				list.splice(index, 1);
				setValue(listKey, list);
			}
			renderSections();
			renderOutput();
			return;
		}
		const addBtn = target.closest<HTMLButtonElement>('[data-add]');
		if (addBtn && container.contains(addBtn)) {
			const key = addBtn.getAttribute('data-add')!;
			const list = Array.isArray(state.values[key]) ? (state.values[key] as Record<string, unknown>[]) : [];
			const field = findField(key);
			list.push(newRow(field?.listFields || []));
			setValue(key, list);
			renderSections();
			renderOutput();
		}
	});
}

function renderSections() {
	const wrap = document.getElementById('sections');
	if (!wrap) return;
	const lang = t();
	const sections = sectionsFor(state.platform);
	// Keep the user's open sections open across re-renders (list add/remove, language change).
	const openKeys = new Set(
		[...wrap.querySelectorAll('details.opt-section[open]')].map((d) => d.getAttribute('data-section') || '')
	);
	const note = state.platform === 'bedrock'
		? `<p class="bedrock-note">${escapeHtml(lang.bedrockComponentsNote ?? '')}</p>`
		: '';
	wrap.innerHTML = note + sections.map((section) => `
		<details class="opt-section" data-section="${section.key}"${section === sections[0] || openKeys.has(section.key) ? ' open' : ''}>
			<summary>${section.icon} ${escapeHtml(lang[section.titleKey] ?? section.titleKey)}${section.key === 'advanced' ? ` <span class="badge-expert">${escapeHtml(lang.badgeExpert)}</span>` : ''}</summary>
			<div class="opt-section-body">${section.fields.map((f) => fieldHtml(f, state.values[f.key], lang)).join('')}</div>
		</details>
	`).join('');
	wireFields(wrap);
}

// ---- Item preview (Minecraft-style tooltip) ----

const MC_COLOR_HEX: Record<string, string> = {
	black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
	dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
	dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
	red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF',
};

const ROMAN_TABLE: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const romanCache = new Map<number, string>();

function romanNumeral(n: number): string {
	const hit = romanCache.get(n);
	if (hit !== undefined) return hit;
	let out = '';
	let rest = n;
	for (const [v, sym] of ROMAN_TABLE) {
		while (rest >= v) { out += sym; rest -= v; }
	}
	if (romanCache.size >= 500) romanCache.clear();
	romanCache.set(n, out);
	return out;
}

function rowsFor(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}
function rowText(row: Record<string, unknown>, key: string): string {
	const v = row[key];
	return typeof v === 'string' ? v : '';
}
function rowNum(row: Record<string, unknown>, key: string, fallback: number): number {
	const v = row[key];
	const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
	return Number.isFinite(n) ? n : fallback;
}

/** Render the item as it will appear in-game (icon + tooltip). */
function renderPreview() {
	const slot = document.getElementById('previewSlot');
	const tooltip = document.getElementById('previewTooltip');
	if (!slot || !tooltip) return;
	const lang = t();
	const isJava = state.platform === 'java';
	const item = findItem(state.itemId);

	slot.innerHTML = '';
	tooltip.innerHTML = '';
	slot.classList.remove('glint');

	if (!item) {
		slot.innerHTML = `<span class="preview-ph">❓</span>`;
		const name = document.createElement('span');
		name.className = 'tt-name';
		name.textContent = state.itemId.trim() || '? ';
		tooltip.appendChild(name);
		return;
	}

	slot.appendChild(createImgTag(item, 96));

	// Name (custom name + color/rarity on Java, default name otherwise)
	const nameEl = document.createElement('span');
	nameEl.className = 'tt-name';
	const rarity = typeof state.values.rarity === 'string' ? state.values.rarity : '';
	const customName = typeof state.values.customName === 'string' ? state.values.customName.trim() : '';
	if (isJava && customName) {
		nameEl.textContent = customName;
		const color = typeof state.values.customNameColor === 'string' ? state.values.customNameColor : 'white';
		if (color && color !== 'white' && MC_COLOR_HEX[color]) nameEl.style.color = MC_COLOR_HEX[color];
		if (state.values.customNameItalic !== false) nameEl.classList.add('italic');
		if (state.values.customNameBold === true) nameEl.classList.add('bold');
	} else {
		nameEl.textContent = currentLang === 'es' && item.displayNameEs ? item.displayNameEs : item.displayName;
	}
	if (isJava && rarity && rarity !== 'common') nameEl.classList.add('rarity-' + rarity);
	tooltip.appendChild(nameEl);

	// Lore (Java)
	if (isJava) {
		const lore = typeof state.values.lore === 'string' ? state.values.lore : '';
		for (const l of lore.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
			const line = document.createElement('span');
			line.className = 'tt-lore';
			line.textContent = l;
			tooltip.appendChild(line);
		}
	}

	// Enchantments (Java only — Bedrock /give has no enchantment component)
	const ench = isJava
		? rowsFor(state.values.enchantments).filter((r) => rowText(r, 'enchantment'))
		: [];
	for (const r of ench) {
		const line = document.createElement('span');
		line.className = 'tt-ench';
		const key = rowText(r, 'enchantment');
		line.textContent = (lang['ench_' + key] ?? key) + ' ' + romanNumeral(rowNum(r, 'level', 1));
		tooltip.appendChild(line);
	}

	// Unbreakable + unavailable warning
	if (isJava && state.values.unbreakable === true) {
		const line = document.createElement('span');
		line.className = 'tt-gray';
		line.textContent = lang.ttUnbreakable;
		tooltip.appendChild(line);
	}
	if (!isJava && !resolveBedrockItem(state.itemId).available) {
		const line = document.createElement('span');
		line.className = 'tt-error';
		line.textContent = lang.errorBedrockUnavailable;
		tooltip.appendChild(line);
	}

	// Enchanted glint (Java): forced on, or default when the item is enchanted
	const hasEnch = ench.length > 0;
	if (isJava && (state.values.glint === 'true' || (state.values.glint !== 'false' && hasEnch))) {
		slot.classList.add('glint');
	}
}

// ---- Output ----

function renderOutput() {
	renderPreview();
	const textarea = document.getElementById('commandOutput') as HTMLTextAreaElement | null;
	const errorEl = document.getElementById('outputError');
	const hintEl = document.getElementById('outputHint');
	if (!textarea) return;
	const lang = t();
	const result = buildCommand(state);
	if (result.error) {
		textarea.value = '';
		if (errorEl) errorEl.textContent = lang[result.error] ?? result.error;
	} else {
		textarea.value = result.command;
		if (errorEl) errorEl.textContent = '';
	}
	if (hintEl) hintEl.textContent = state.platform === 'java' ? lang.outputHintJava : lang.outputHintBedrock;
}

function applyPlatformUI() {
	document.querySelectorAll('.platform-tab').forEach((tab) => {
		tab.classList.toggle('active', tab.getAttribute('data-platform') === state.platform);
	});
	const dataValueField = document.getElementById('dataValueField');
	if (dataValueField) dataValueField.style.display = state.platform === 'java' ? 'none' : '';
	updatePotionSelect();
	renderBedrockInfo();
	renderOutput();
}

// ---- Bootstrap ----

const uiHooks = {
	onLangChange: (lang: string) => {
		currentLang = lang;
		renderSections();
		renderOutput();
		updateItemPreview();
		updatePotionSelect();
		renderBedrockInfo();
	},
};

export function init() {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initTool);
	} else {
		initTool();
	}
}

async function initTool() {
	const app = document.getElementById('app') || document.body;
	app.innerHTML = `
		<h1 data-i18n="heading">🎁 Creador de /give</h1>
		<p class="subtitle" data-i18n="description">Genera comandos /give personalizados para Minecraft Java y Bedrock.</p>

		<div class="platform-switch" role="tablist" aria-label="Edition">
			<button type="button" class="platform-tab active" data-platform="java" role="tab">☕ <span data-i18n="platformJava">Java</span></button>
			<button type="button" class="platform-tab" data-platform="bedrock" role="tab">🪨 <span data-i18n="platformBedrock">Bedrock</span></button>
		</div>

		<div class="give-layout">
			<div class="give-main">
				<div class="card main-card">
					<div class="controls-grid">
						<div class="opt-field">
							<label class="editor-label" data-i18n="targetLabel">Jugador objetivo</label>
							<select class="station-select" id="targetSelect">
								<option value="@p">@p</option>
								<option value="@a">@a</option>
								<option value="@r">@r</option>
								<option value="@s">@s</option>
								<option value="custom" data-i18n="optCustom">Nombre / UUID</option>
							</select>
							<input type="text" id="customTarget" class="text-input" data-i18n="phCustomTarget" style="display:none;margin-top:8px" spellcheck="false" autocomplete="off">
						</div>
						<div class="opt-field">
							<label class="editor-label" data-i18n="countLabel">Cantidad</label>
							<input type="number" id="countInput" class="text-input" min="1" max="32767" step="1" value="1">
						</div>
						<div class="opt-field" id="dataValueField" style="display:none">
							<label class="editor-label" id="dataValueLabel" data-i18n="dataValueLabel">Data value</label>
							<input type="number" id="dataValueInput" class="text-input" min="0" max="32767" step="1" value="0">
							<select id="potionDataSelect" class="station-select" style="display:none;margin-top:8px"></select>
							<p class="hint" data-i18n="helpDataValue"></p>
						</div>
					</div>
					<div class="opt-field">
						<label class="editor-label" data-i18n="itemLabel">ID del item</label>
						<div class="item-row">
							<div class="item-preview" id="itemPreview"><span class="preview-ph">❓</span></div>
							<input type="text" id="itemIdInput" class="text-input" value="minecraft:diamond_sword" spellcheck="false" autocomplete="off" placeholder="minecraft:diamond_sword">
							<button type="button" class="btn btn-secondary" id="pickItemBtn" data-i18n="pickItemBtn">🧱 Elegir item</button>
						</div>
						<div class="quick-search-wrap">
							<input type="text" id="quickSearch" class="text-input" data-i18n="quickSearchPh" autocomplete="off" spellcheck="false">
							<div class="quick-results" id="quickResults" style="display:none"></div>
						</div>
						<p class="bedrock-info" id="bedrockInfo" style="display:none"></p>
					</div>
				</div>

				<div id="sections"></div>
			</div>

			<aside class="give-output-col">
				<div class="card preview-card">
					<label class="editor-label" data-i18n="previewLabel">Vista previa</label>
					<div class="preview-stage">
						<div class="preview-slot" id="previewSlot"><span class="preview-ph">❓</span></div>
						<div class="item-tooltip" id="previewTooltip"></div>
					</div>
					<p class="hint" data-i18n="previewHint"></p>
				</div>
				<div class="card output-card">
					<label class="editor-label" data-i18n="outputLabel">Comando generado</label>
					<textarea id="commandOutput" class="output-textarea" readonly spellcheck="false" rows="5"></textarea>
					<div class="output-actions">
						<button type="button" class="btn btn-primary" id="copyBtn" data-i18n="copyBtn">📋 Copiar</button>
						<button type="button" class="btn btn-ghost" id="resetBtn" data-i18n="resetBtn">Reiniciar opciones</button>
					</div>
					<p class="error-text" id="outputError"></p>
					<p class="hint" id="outputHint"></p>
				</div>
			</aside>
		</div>
	`;

	currentLang = initUi(translations, uiHooks);

	// Platform switch (delegated: two tabs, one listener on the switch).
	document.querySelector('.platform-switch')?.addEventListener('click', (e) => {
		const tab = (e.target as HTMLElement).closest('.platform-tab') as HTMLElement | null;
		if (!tab) return;
		const p = tab.getAttribute('data-platform');
		if (p === 'java' || p === 'bedrock') {
			// Synthetic potion names are only valid Bedrock IDs; on Java fall
			// back to the generic potion item (customisable via the potion section).
			if (p === 'java' && potionItems.some((i) => i.name === state.itemId.replace(/^minecraft:/, ''))) {
				state.itemId = 'minecraft:potion';
				const itemIdInput = document.getElementById('itemIdInput') as HTMLInputElement | null;
				if (itemIdInput) itemIdInput.value = state.itemId;
			}
			setPlatform(p as Platform);
			applyPlatformUI();
			renderSections();
		}
	});

	// Target
	const targetSelect = document.getElementById('targetSelect') as HTMLSelectElement | null;
	const customTarget = document.getElementById('customTarget') as HTMLInputElement | null;
	if (targetSelect) {
		targetSelect.value = state.target === 'custom' ? 'custom' : state.target;
		targetSelect.addEventListener('change', () => {
			state.target = targetSelect.value;
			if (customTarget) customTarget.style.display = targetSelect.value === 'custom' ? '' : 'none';
			renderOutput();
		});
	}
	if (customTarget) {
		customTarget.value = state.customTarget;
		customTarget.addEventListener('input', () => { state.customTarget = customTarget.value; renderOutput(); });
	}

	// Item id
	const itemIdInput = document.getElementById('itemIdInput') as HTMLInputElement | null;
	if (itemIdInput) {
		itemIdInput.value = state.itemId;
		itemIdInput.addEventListener('input', () => {
			state.itemId = itemIdInput.value;
			syncDataValue();
			updateItemPreview();
			renderBedrockInfo();
			renderOutput();
		});
	}
	document.getElementById('pickItemBtn')?.addEventListener('click', () => openPicker());

	// Quick search (debounced; delegated row clicks wired once).
	const quickSearch = document.getElementById('quickSearch') as HTMLInputElement | null;
	if (quickSearch) {
		quickSearch.addEventListener('input', () => debouncedQuickSearch(quickSearch.value));
		quickSearch.addEventListener('focus', () => debouncedQuickSearch(quickSearch.value));
		quickSearch.addEventListener('blur', () => {
			const list = document.getElementById('quickResults');
			if (list) setTimeout(() => { list.style.display = 'none'; }, 150);
		});
	}
	wireQuickResultsOnce();

	// Count
	const countInput = document.getElementById('countInput') as HTMLInputElement | null;
	if (countInput) {
		countInput.value = String(state.count);
		countInput.addEventListener('input', () => {
			const n = parseInt(countInput.value, 10);
			state.count = Number.isFinite(n) ? n : 1;
			renderOutput();
		});
	}

	// Bedrock data value
	const dataValueInput = document.getElementById('dataValueInput') as HTMLInputElement | null;
	if (dataValueInput) {
		dataValueInput.value = String(state.dataValue);
		dataValueInput.addEventListener('input', () => {
			const n = parseInt(dataValueInput.value, 10);
			state.dataValue = Number.isFinite(n) ? n : 0;
			state.dataOverridden = true;
			updatePotionSelect();
			renderOutput();
		});
	}

	// Bedrock potion / arrow effect dropdown (sets the same data value)
	const potionDataSelect = document.getElementById('potionDataSelect') as HTMLSelectElement | null;
	if (potionDataSelect) {
		potionDataSelect.addEventListener('change', () => {
			const n = parseInt(potionDataSelect.value, 10);
			state.dataValue = Number.isFinite(n) ? n : 0;
			state.dataOverridden = true;
			if (dataValueInput) dataValueInput.value = String(state.dataValue);
			renderOutput();
		});
	}

	// Copy
	const copyBtn = document.getElementById('copyBtn') as HTMLButtonElement | null;
	if (copyBtn) {
		copyBtn.addEventListener('click', async () => {
			const textarea = document.getElementById('commandOutput') as HTMLTextAreaElement | null;
			if (!textarea || !textarea.value) return;
			try {
				await navigator.clipboard.writeText(textarea.value);
			} catch {
				textarea.select();
				document.execCommand('copy');
			}
			const original = copyBtn.textContent;
			copyBtn.textContent = t().copied;
			setTimeout(() => { copyBtn.textContent = original; }, 1500);
		});
	}

	// Reset
	document.getElementById('resetBtn')?.addEventListener('click', () => {
		resetValues();
		renderSections();
		renderOutput();
	});

	applyPlatformUI();
	renderSections();
	renderOutput();
	updatePotionSelect();

	await loadItems();
}

async function loadItems() {
	try {
		const res = await fetch('/data/items.json');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data: ItemData[] = await res.json();
		// Synthetic items (generated potions, id >= 900000) are kept apart: on
		// Java they are covered by the potion component section, but on Bedrock
		// they are real items whose data value the resolver handles.
		allItems = data.filter((item) => item.id < 900000);
		potionItems = data.filter((item) => item.id >= 900000);
		rebuildItemIndex();
		updateItemPreview();
		renderOutput(); // refresh the big preview now that the item is known
	} catch (err) {
		console.error('Failed to load items:', err);
	}
}
