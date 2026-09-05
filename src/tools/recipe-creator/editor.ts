import type { AnyItem, FurnaceTag, RecipeState, RecipeType } from './types';
import { FURNACE_TAGS } from './types';
import { translations } from './translations';
import {
	allItems,
	customItems,
	recipes,
	selectedIndex,
	currentLang,
	platform,
	identifierManuallyEdited,
	setSelectedIndex,
	setIdentifierManuallyEdited,
} from './state';
import { getItemById, getItemName, getItemIdentifier, createImgTag } from './items';
import { uuid, sanitizeName, escapeHtml, debounce } from './util';

// ---- Item picker (scoped per-instance overlay, debounced + chunked grid) ----

interface PickerInstance {
	overlay: HTMLElement;
	grid: HTMLElement;
	search: HTMLInputElement;
	onSelect: (id: number | null) => void;
	escHandler: (e: KeyboardEvent) => void;
	filtered: AnyItem[];
	rendered: number;
	chunkScheduled: boolean;
}

let picker: PickerInstance | null = null;
let pickerQuery = '';

const PICKER_INITIAL = 200;
const PICKER_CHUNK = 240;

export function currentPickerQuery(): string {
	if (picker) return picker.search.value;
	const input = document.getElementById('pickerSearch') as HTMLInputElement | null;
	return input ? input.value : pickerQuery;
}

/** Always removes the overlay *and* its Esc listener (no leaks, no races). */
function closeCurrentPicker(): void {
	if (!picker) return;
	const { overlay, escHandler } = picker;
	picker = null;
	document.removeEventListener('keydown', escHandler);
	overlay.remove();
}

function openPicker(onSelect: (id: number | null) => void) {
	// Singleton: never stack two pickers (kills the cross-instance race where
	// a global `querySelector('.picker-overlay')` closed the wrong dialog).
	if (picker) closeCurrentPicker();
	pickerQuery = '';
	const t = translations[currentLang];

	const overlay = document.createElement('div');
	overlay.className = 'picker-overlay';
	overlay.innerHTML = `
		<div class="picker" role="dialog" aria-modal="true">
			<div class="picker-head">
				<span class="picker-title">${t.pickTitle}</span>
				<button class="picker-clear" type="button">✕ ${t.clearSlot}</button>
				<button class="picker-close" type="button" aria-label="${t.clearSlot}">✕</button>
			</div>
			<input type="text" id="pickerSearch" class="picker-search" placeholder="${t.searchPlaceholder}" autocomplete="off">
			<div class="picker-grid" id="pickerGrid"></div>
		</div>
	`;
	document.body.appendChild(overlay);

	const search = overlay.querySelector('#pickerSearch') as HTMLInputElement;
	const grid = overlay.querySelector('#pickerGrid') as HTMLElement;
	const inst: PickerInstance = {
		overlay,
		grid,
		search,
		onSelect,
		escHandler: (e: KeyboardEvent) => {
			if (e.key === 'Escape') closeCurrentPicker();
		},
		filtered: [],
		rendered: 0,
		chunkScheduled: false,
	};
	picker = inst;
	document.addEventListener('keydown', inst.escHandler);

	overlay.querySelector('.picker-close')?.addEventListener('click', closeCurrentPicker);
	overlay.querySelector('.picker-clear')?.addEventListener('click', () => {
		inst.onSelect(null);
		closeCurrentPicker();
	});
	overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCurrentPicker(); });

	const debouncedFilter = debounce(() => {
		pickerQuery = search.value;
		applyPickerFilter(search.value);
	}, 150);
	search.addEventListener('input', debouncedFilter);

	// One delegated click for every (present + future) row — no per-card listeners.
	grid.addEventListener('click', (e) => {
		const btn = (e.target as HTMLElement).closest('.picker-item') as HTMLElement | null;
		if (!btn || picker !== inst) return;
		// Resolve through the instance's own filtered list (never a global query).
		const item = inst.filtered[parseInt(btn.dataset.index || '-1', 10)];
		if (!item) return;
		inst.onSelect(item.id);
		closeCurrentPicker();
	});
	let scrollTicking = false;
	grid.addEventListener('scroll', () => {
		if (scrollTicking || picker !== inst) return;
		scrollTicking = true;
		const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout;
		schedule(() => {
			scrollTicking = false;
			if (picker !== inst) return;
			if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 300) schedulePickerChunk(inst);
		});
	});

	applyPickerFilter('');
	search.focus();
}

function schedulePickerChunk(inst: PickerInstance) {
	if (inst.chunkScheduled) return;
	inst.chunkScheduled = true;
	const run = () => {
		inst.chunkScheduled = false;
		if (picker !== inst) return;
		appendPickerChunk(inst, PICKER_CHUNK);
	};
	if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
	else setTimeout(run, 0);
}

function buildPickerButton(item: AnyItem, index: number): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'picker-item';
	btn.dataset.index = String(index);
	btn.appendChild(createImgTag(item, 40));
	const meta = document.createElement('div');
	meta.className = 'picker-meta';
	const name = document.createElement('span');
	name.className = 'picker-name';
	name.textContent = getItemName(item);
	const id = document.createElement('span');
	id.className = 'picker-id';
	id.textContent = getItemIdentifier(item);
	meta.appendChild(name);
	meta.appendChild(id);
	btn.appendChild(meta);
	return btn;
}

function appendPickerChunk(inst: PickerInstance, size: number) {
	const end = Math.min(inst.filtered.length, inst.rendered + size);
	if (end <= inst.rendered) return;
	const frag = document.createDocumentFragment();
	for (let i = inst.rendered; i < end; i++) {
		frag.appendChild(buildPickerButton(inst.filtered[i], i));
	}
	inst.grid.appendChild(frag);
	inst.rendered = end;
}

function applyPickerFilter(query: string) {
	const inst = picker;
	const grid = inst ? inst.grid : document.getElementById('pickerGrid');
	if (!grid) return;
	const t = translations[currentLang];
	const q = query.toLowerCase().trim();

	// Vanilla items first, then custom items extracted from imported addons.
	const combined: AnyItem[] = [...allItems, ...customItems];
	// Bounded pre-filter: scan all (cheap string test), but only ever
	// materialize rows for what is shown (initial slice + scroll chunks).
	const filtered = combined.filter((item) => {
		if (!q) return true;
		const identifier = getItemIdentifier(item);
		return (item.displayName || '').toLowerCase().includes(q) ||
			(item.displayNameEs || '').toLowerCase().includes(q) ||
			identifier.toLowerCase().includes(q) ||
			String(item.id).includes(q);
	});

	if (inst) {
		inst.filtered = filtered;
		inst.rendered = 0;
	}
	grid.innerHTML = '';
	if (filtered.length === 0) {
		grid.innerHTML = `<p class="picker-empty">${t.pickerEmpty}</p>`;
		return;
	}

	if (inst) {
		// First paint is capped so a keystroke never builds 3000 buttons;
		// the rest streams in via infinite scroll.
		appendPickerChunk(inst, Math.min(PICKER_INITIAL, filtered.length));
		return;
	}
	// No active instance (e.g. external caller): paint the capped first slice.
	const frag = document.createDocumentFragment();
	const end = Math.min(filtered.length, PICKER_INITIAL);
	for (let i = 0; i < end; i++) {
		frag.appendChild(buildPickerButton(filtered[i], i));
	}
	grid.appendChild(frag);
}

export function renderPickerGrid(query: string) {
	pickerQuery = query;
	if (picker) {
		applyPickerFilter(query);
		return;
	}
	applyPickerFilter(query);
}

// ---- Recipe list + editor ----

function typeIcon(type: RecipeType): string {
	return type === 'shaped' ? '▦' : type === 'shapeless' ? '🔀' : '🔥';
}

export function recipeShortName(r: RecipeState, i: number): string {
	const name = r.identifier.split(':').pop();
	return name ? name : `${currentLang === 'es' ? 'Receta' : 'Recipe'} ${i + 1}`;
}

function newRecipe(): RecipeState {
	return {
		id: uuid(),
		type: 'shaped',
		identifier: nextDefaultIdentifier(),
		grid: new Array(9).fill(null),
		ingredients: [],
		input: null,
		output: null,
		furnaceTag: 'furnace',
		resultId: null,
		resultCount: 1
	};
}

function nextDefaultIdentifier(): string {
	let n = recipes.length + 1;
	let id = `custom:recipe_${n}`;
	while (recipes.some((r) => r.identifier === id)) {
		n++;
		id = `custom:recipe_${n}`;
	}
	return id;
}

/** Update only the active chip label (granular; no list rebuild, no focus loss). */
function updateActiveChipLabel(r: RecipeState, index: number): void {
	const list = document.getElementById('recipeList');
	if (!list) return;
	const chip = list.querySelector('.recipe-chip.active .chip-name');
	if (chip) chip.textContent = recipeShortName(r, index);
	const active = list.querySelector('.recipe-chip.active');
	if (active) active.setAttribute('title', r.identifier);
}

function wireRecipeListOnce(list: HTMLElement) {
	if ((list as HTMLElement & { __wired?: boolean }).__wired) return;
	(list as HTMLElement & { __wired?: boolean }).__wired = true;
	// Delegated: one listener for every chip (present + future).
	list.addEventListener('click', (e) => {
		const del = (e.target as HTMLElement).closest('.chip-delete') as HTMLElement | null;
		if (del) {
			e.stopPropagation();
			const chip = del.closest('.recipe-chip') as HTMLElement | null;
			deleteRecipe(parseInt(chip?.dataset.index || '-1', 10));
			return;
		}
		const chip = (e.target as HTMLElement).closest('.recipe-chip') as HTMLElement | null;
		if (chip) selectRecipe(parseInt(chip.dataset.index || '-1', 10));
	});
}

export function renderRecipeList() {
	const list = document.getElementById('recipeList');
	if (!list) return;
	const t = translations[currentLang];

	if (recipes.length === 0) {
		list.innerHTML = `<span class="recipe-empty">${t.emptyRecipeList}</span>`;
		return;
	}

	wireRecipeListOnce(list);
	list.innerHTML = '';
	const frag = document.createDocumentFragment();
	recipes.forEach((r, i) => {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = `recipe-chip${i === selectedIndex ? ' active' : ''}`;
		chip.dataset.index = String(i);
		chip.title = r.identifier;
		chip.innerHTML = `
			<span class="chip-icon">${typeIcon(r.type)}</span>
			<span class="chip-name">${escapeHtml(recipeShortName(r, i))}</span>
		`;
		const del = document.createElement('span');
		del.className = 'chip-delete';
		del.title = t.deleteRecipe;
		del.textContent = '✕';
		chip.appendChild(del);
		frag.appendChild(chip);
	});
	list.appendChild(frag);
}

function selectRecipe(i: number) {
	if (!Number.isInteger(i) || i < 0 || i >= recipes.length) return;
	setSelectedIndex(i);
	setIdentifierManuallyEdited(false);
	renderRecipeList();
	renderEditor();
}

export function addRecipe() {
	recipes.push(newRecipe());
	setSelectedIndex(recipes.length - 1);
	setIdentifierManuallyEdited(false);
	renderRecipeList();
	renderEditor();
}

function deleteRecipe(i: number) {
	if (!Number.isInteger(i) || i < 0 || i >= recipes.length) return;
	recipes.splice(i, 1);
	if (recipes.length === 0) {
		setSelectedIndex(0);
	} else if (selectedIndex >= recipes.length) {
		setSelectedIndex(recipes.length - 1);
	} else if (i < selectedIndex) {
		setSelectedIndex(Math.max(0, selectedIndex - 1));
	}
	setIdentifierManuallyEdited(false);
	renderRecipeList();
	renderEditor();
}

function stationLabel(tag: FurnaceTag): string {
	const t = translations[currentLang];
	switch (tag) {
		case 'furnace': return t.stationFurnace;
		case 'blast_furnace': return t.stationBlastFurnace;
		case 'smoker': return t.stationSmoker;
		case 'campfire': return t.stationCampfire;
	}
}

function guiClassForFurnace(tag: FurnaceTag): string {
	switch (tag) {
		case 'blast_furnace': return 'gui-blast';
		case 'smoker': return 'gui-smoker';
		default: return 'gui-furnace';
	}
}

/** Granular result-count refresh: badge + stepper value only, no GUI rebuild. */
function refreshResultCount(r: RecipeState): void {
	const countVal = document.getElementById('countVal');
	if (countVal) countVal.textContent = String(r.resultCount);
	const wrap = document.getElementById('guiWrap');
	if (!wrap) return;
	if (r.type !== 'shaped' && r.type !== 'shapeless') return;
	const slots = wrap.querySelectorAll('.gui-slot');
	if (slots.length === 0) return;
	// The result slot is appended last for crafting panels.
	const resultSlot = slots[slots.length - 1] as HTMLElement;
	let badge = resultSlot.querySelector('.gui-count');
	if (r.resultCount > 1) {
		if (!badge) {
			badge = document.createElement('span');
			badge.className = 'gui-count';
			resultSlot.appendChild(badge);
		}
		badge.textContent = `×${r.resultCount}`;
	} else if (badge) {
		badge.remove();
	}
}

export function renderEditor() {
	const editor = document.getElementById('editor');
	if (!editor) return;
	const t = translations[currentLang];

	if (recipes.length === 0) {
		editor.innerHTML = `
			<div class="editor-empty">
				<p>${t.emptyRecipeList} ${t.emptyRecipeAdd}</p>
				<button type="button" class="btn btn-primary" id="emptyAdd">＋ ${t.addRecipe}</button>
			</div>
		`;
		const emptyAdd = document.getElementById('emptyAdd');
		if (emptyAdd) emptyAdd.addEventListener('click', addRecipe);
		return;
	}

	const r = recipes[selectedIndex];
	const hint = platform === 'java' ? t.identifierHintJava : t.identifierHint;

	editor.innerHTML = `
		<div class="type-tabs" id="typeTabs">
			<button type="button" class="type-tab${r.type === 'shaped' ? ' active' : ''}" data-type="shaped">${t.tabShaped}</button>
			<button type="button" class="type-tab${r.type === 'shapeless' ? ' active' : ''}" data-type="shapeless">${t.tabShapeless}</button>
			<button type="button" class="type-tab${r.type === 'furnace' ? ' active' : ''}" data-type="furnace">${t.tabFurnace}</button>
		</div>

		<div class="identifier-row">
			<label class="editor-label" for="identifierInput">${t.identifierLabel}</label>
			<input type="text" id="identifierInput" class="text-input" value="${escapeHtml(r.identifier)}" spellcheck="false" autocomplete="off">
			<p class="hint">${hint}</p>
		</div>

		<div class="gui-wrap" id="guiWrap"></div>

		<div class="controls-row" id="controlsRow"></div>
	`;

	// Type tabs (delegated on their container).
	editor.querySelector('#typeTabs')?.addEventListener('click', (e) => {
		const tab = (e.target as HTMLElement).closest('.type-tab') as HTMLElement | null;
		if (!tab) return;
		const type = tab.getAttribute('data-type') as RecipeType;
		if (type && type !== r.type) {
			r.type = type;
			renderRecipeList();
			renderEditor();
		}
	});

	// Identifier input: granular chip-label update per keystroke (no full
	// re-render, focus in the input is never touched); full list sync on
	// commit (change/blur) so ordering-dependent state stays consistent.
	const idInput = editor.querySelector('#identifierInput') as HTMLInputElement | null;
	if (idInput) {
		idInput.addEventListener('input', () => {
			setIdentifierManuallyEdited(true);
			r.identifier = idInput.value;
			updateActiveChipLabel(r, selectedIndex);
		});
		idInput.addEventListener('change', () => {
			renderRecipeList();
		});
	}

	// GUI panel
	buildGui(r);

	// Controls (count stepper for shaped/shapeless, station select for furnace)
	const controls = document.getElementById('controlsRow');
	if (controls) {
		if (r.type === 'furnace') {
			controls.innerHTML = `
				<label class="editor-label" for="stationSelect">${t.stationLabel}</label>
				<select class="station-select" id="stationSelect">
					${FURNACE_TAGS.map((tag) => `<option value="${tag}"${tag === r.furnaceTag ? ' selected' : ''}>${stationLabel(tag)}</option>`).join('')}
				</select>
			`;
			const sel = controls.querySelector('#stationSelect') as HTMLSelectElement | null;
			if (sel) sel.addEventListener('change', () => { r.furnaceTag = sel.value as FurnaceTag; buildGui(r); });
		} else {
			controls.innerHTML = `
				<div class="count-stepper-wrap">
					<label class="editor-label">${t.countLabel}</label>
					<div class="count-stepper">
						<button type="button" class="stepper-btn" id="countMinus" aria-label="-">−</button>
						<span class="stepper-val" id="countVal">${r.resultCount}</span>
						<button type="button" class="stepper-btn" id="countPlus" aria-label="+">+</button>
					</div>
				</div>
			`;
			const minus = controls.querySelector('#countMinus');
			const plus = controls.querySelector('#countPlus');
			if (minus) minus.addEventListener('click', () => {
				r.resultCount = Math.max(1, r.resultCount - 1);
				refreshResultCount(r);
			});
			if (plus) plus.addEventListener('click', () => {
				r.resultCount = Math.min(64, r.resultCount + 1);
				refreshResultCount(r);
			});
		}
	}
}

/** Build a clickable slot positioned over the vanilla GUI texture. */
function createGuiSlot(id: number | null, x: number, y: number, onClick: () => void, count?: number): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'gui-slot gui-slot-btn';
	btn.style.left = `calc(var(--s) * ${x}px)`;
	btn.style.top = `calc(var(--s) * ${y}px)`;
	btn.addEventListener('click', onClick);

	if (id != null) {
		const item = getItemById(id);
		if (item) {
			btn.title = getItemName(item);
			btn.appendChild(createImgTag(item, 32));
			if (count != null && count > 1) {
				const badge = document.createElement('span');
				badge.className = 'gui-count';
				badge.textContent = `×${count}`;
				btn.appendChild(badge);
			}
		}
	}
	return btn;
}

function buildGui(r: RecipeState) {
	const wrap = document.getElementById('guiWrap');
	if (!wrap) return;
	wrap.innerHTML = '';

	let panel: HTMLDivElement;
	if (r.type === 'shaped' || r.type === 'shapeless') {
		panel = document.createElement('div');
		panel.className = 'recipe-gui gui-crafting';

		const positions: (number | null)[] = [];
		if (r.type === 'shaped') {
			for (let i = 0; i < 9; i++) positions.push(r.grid[i]);
		} else {
			// shapeless: fill ingredients in order, rest empty
			for (let i = 0; i < 9; i++) positions.push(i < r.ingredients.length ? r.ingredients[i] : null);
		}

		for (let i = 0; i < 9; i++) {
			const c = i % 3;
			const row = Math.floor(i / 3);
			const id = positions[i];
			const slotIndex = i;
			panel.appendChild(createGuiSlot(id, 30 + c * 18, 17 + row * 18, () => {
				openPicker((picked) => {
					if (r.type === 'shaped') {
						r.grid[slotIndex] = picked;
					} else {
						if (picked == null) {
							if (slotIndex < r.ingredients.length) r.ingredients.splice(slotIndex, 1);
						} else if (slotIndex < r.ingredients.length) {
							r.ingredients[slotIndex] = picked;
						} else if (r.ingredients.length < 9) {
							r.ingredients.push(picked);
						}
					}
					renderEditor();
				});
			}));
		}

		// Result slot
		panel.appendChild(createGuiSlot(r.resultId, 124, 35, () => {
			openPicker((picked) => {
				r.resultId = picked;
				if (picked != null && !identifierManuallyEdited && !r.preserveIdentifier) {
					const item = getItemById(picked);
					if (item) {
						const ident = getItemIdentifier(item);
						r.identifier = 'custom:' + sanitizeName(ident.split(':').pop() || ident);
					}
				}
				renderEditor();
			});
		}, r.resultCount));
	} else {
		// furnace
		panel = document.createElement('div');
		panel.className = `recipe-gui ${guiClassForFurnace(r.furnaceTag)}`;

		panel.appendChild(createGuiSlot(r.input, 56, 17, () => {
			openPicker((picked) => { r.input = picked; renderEditor(); });
		}));
		panel.appendChild(createGuiSlot(r.output, 116, 35, () => {
			openPicker((picked) => { r.output = picked; renderEditor(); });
		}));
	}

	wrap.appendChild(panel);
}
