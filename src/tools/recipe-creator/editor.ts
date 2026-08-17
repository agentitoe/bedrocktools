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
import { uuid, sanitizeName, escapeHtml } from './util';

// ---- Item picker ----

let pickerOnSelect: ((id: number | null) => void) | null = null;
let pickerQuery = '';

export function currentPickerQuery(): string {
	const input = document.getElementById('pickerSearch') as HTMLInputElement | null;
	return input ? input.value : pickerQuery;
}

function openPicker(onSelect: (id: number | null) => void) {
	pickerOnSelect = onSelect;
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

	overlay.querySelector('.picker-close')?.addEventListener('click', () => closePicker(overlay));
	overlay.querySelector('.picker-clear')?.addEventListener('click', () => {
		if (pickerOnSelect) pickerOnSelect(null);
		closePicker(overlay);
	});
	overlay.addEventListener('click', (e) => { if (e.target === overlay) closePicker(overlay); });
	search.addEventListener('input', () => {
		pickerQuery = search.value;
		renderPickerGrid(search.value);
	});

	renderPickerGrid('');
	search.focus();
}

function closePicker(overlay: HTMLElement) {
	overlay.remove();
	pickerOnSelect = null;
}

export function renderPickerGrid(query: string) {
	const grid = document.getElementById('pickerGrid');
	if (!grid) return;
	const t = translations[currentLang];
	const q = query.toLowerCase().trim();

	// Vanilla items first, then custom items extracted from imported addons.
	const combined: AnyItem[] = [...allItems, ...customItems];
	const filtered = combined.filter((item) => {
		if (!q) return true;
		const identifier = getItemIdentifier(item);
		return (item.displayName || '').toLowerCase().includes(q) ||
			(item.displayNameEs || '').toLowerCase().includes(q) ||
			identifier.toLowerCase().includes(q) ||
			String(item.id).includes(q);
	});

	if (filtered.length === 0) {
		grid.innerHTML = `<p class="picker-empty">${t.pickerEmpty}</p>`;
		return;
	}

	grid.innerHTML = '';
	for (const item of filtered) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'picker-item';
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
		btn.addEventListener('click', () => {
			const overlay = document.querySelector('.picker-overlay');
			if (pickerOnSelect) pickerOnSelect(item.id);
			if (overlay) overlay.remove();
			pickerOnSelect = null;
		});
		grid.appendChild(btn);
	}
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

export function renderRecipeList() {
	const list = document.getElementById('recipeList');
	if (!list) return;
	const t = translations[currentLang];

	if (recipes.length === 0) {
		list.innerHTML = `<span class="recipe-empty">${t.emptyRecipeList}</span>`;
		return;
	}

	list.innerHTML = '';
	recipes.forEach((r, i) => {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = `recipe-chip${i === selectedIndex ? ' active' : ''}`;
		chip.title = r.identifier;
		chip.innerHTML = `
			<span class="chip-icon">${typeIcon(r.type)}</span>
			<span class="chip-name">${recipeShortName(r, i)}</span>
		`;
		const del = document.createElement('span');
		del.className = 'chip-delete';
		del.title = t.deleteRecipe;
		del.textContent = '✕';
		del.addEventListener('click', (e) => {
			e.stopPropagation();
			deleteRecipe(i);
		});
		chip.appendChild(del);
		chip.addEventListener('click', () => selectRecipe(i));
		list.appendChild(chip);
	});
}

function selectRecipe(i: number) {
	if (i < 0 || i >= recipes.length) return;
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

	// Type tabs
	editor.querySelectorAll<HTMLButtonElement>('.type-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			const type = tab.getAttribute('data-type') as RecipeType;
			if (type && type !== r.type) {
				r.type = type;
				renderRecipeList();
				renderEditor();
			}
		});
	});

	// Identifier input
	const idInput = editor.querySelector('#identifierInput') as HTMLInputElement | null;
	if (idInput) {
		idInput.addEventListener('input', () => {
			setIdentifierManuallyEdited(true);
			r.identifier = idInput.value;
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
				buildGui(r);
				const v = controls.querySelector('#countVal');
				if (v) v.textContent = String(r.resultCount);
			});
			if (plus) plus.addEventListener('click', () => {
				r.resultCount = Math.min(64, r.resultCount + 1);
				buildGui(r);
				const v = controls.querySelector('#countVal');
				if (v) v.textContent = String(r.resultCount);
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
