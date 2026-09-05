// Minecraft Items & Blocks Browser
// Browse every Minecraft item and block with their recipes
// Every block is also an item; they differ by whether they place a block in the world
// Isometric 3D rendering for block models
// Optimized: event delegation, DocumentFragment, chunked grid (200) + lazy 3D,
// cached DOM refs, focus-preserving search.

import { initUi, setLang as uiSetLang } from '../../shared/ui';
import { translations } from './translations';
import { allItems, currentLang, setCurrentLang, loadData, getItemById, getItemName, isBlockItem, hasRecipe } from './data';
import { createImgTag } from './images';
import { renderRecipeModal } from './recipes';
import { renderModel, canRenderModel } from './canvas-renderer';
import type { ItemData } from './types';

type Filter = 'all' | 'blocks' | 'items' | 'craftable';

let currentFilter: Filter = 'all';

// ---- Cached DOM refs (avoid repeated getElementById / querySelectorAll) ----

let gridEl: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
let countEl: HTMLElement | null = null;
let gridDelegated = false;
let renderToken = 0;

const GRID_CHUNK = 200;

function getGrid(): HTMLElement | null {
	if (gridEl && gridEl.isConnected) return gridEl;
	gridEl = document.getElementById('itemsGrid');
	if (gridEl && !gridDelegated) {
		gridDelegated = true;
		// Single delegated listener for all cards (no N listeners).
		gridEl.addEventListener('click', (e) => {
			const target = e.target as HTMLElement | null;
			const card = target?.closest?.('[data-item-id]') as HTMLElement | null;
			if (!card || !gridEl!.contains(card)) return;
			const itemId = Number(card.getAttribute('data-item-id'));
			if (!Number.isFinite(itemId)) return;
			const foundItem = getItemById(itemId);
			if (foundItem) renderRecipeModal(foundItem);
		});
	}
	return gridEl;
}

function getSearch(): HTMLInputElement | null {
	if (searchEl && searchEl.isConnected) return searchEl;
	searchEl = document.getElementById('searchInput') as HTMLInputElement | null;
	return searchEl;
}

function getCount(): HTMLElement | null {
	if (countEl && countEl.isConnected) return countEl;
	countEl = document.getElementById('itemCount');
	return countEl;
}

// ---- Language / theme (shared logic, page-specific hooks) ----

const uiHooks = {
	onApplyLang: (lang: string) => {
		const input = getSearch();
		if (input) input.placeholder = translations[lang].searchPlaceholder;
	},
	onLangChange: (lang: string) => {
		setCurrentLang(lang);
		renderItems(getSearch()?.value || '');
	},
};

function setLang(lang: string) {
	uiSetLang(lang, translations, uiHooks);
}

function applyFilter(filter: Filter) {
	currentFilter = filter;
	// Update active button (scoped query, cached on demand)
	document.querySelectorAll('.filter-btn').forEach(btn => {
		btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
	});
	renderItems(getSearch()?.value || '');
}

// ---- Filtering (single pass, lower-cased once) ----

function getFilteredItems(filter: string): ItemData[] {
	const q = filter.trim().toLowerCase();
	const needQuery = q.length > 0;
	const out: ItemData[] = [];
	const items = allItems;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (currentFilter === 'blocks' && !isBlockItem(item.id)) continue;
		if (currentFilter === 'items' && isBlockItem(item.id)) continue;
		if (currentFilter === 'craftable' && !hasRecipe(item.id)) continue;
		if (needQuery) {
			const dn = (item.displayName || '').toLowerCase();
			const des = (item.displayNameEs || '').toLowerCase();
			const nm = item.name.toLowerCase();
			if (
				dn.indexOf(q) === -1 &&
				des.indexOf(q) === -1 &&
				nm.indexOf(q) === -1 &&
				String(item.id).indexOf(filter.trim()) === -1
			) {
				continue;
			}
		}
		out.push(item);
	}
	return out;
}

function buildCard(item: ItemData): HTMLDivElement {
	const t = translations[currentLang];
	const card = document.createElement('div');
	card.className = `item-card${isBlockItem(item.id) ? ' block-item' : ''}`;
	card.dataset.itemId = String(item.id);
	card.title = `${getItemName(item)} (${item.name})${isBlockItem(item.id) ? ` — ${t.blockBadge}` : ''}`;

	// Flat placeholder renders immediately; 3D upgrade is lazy (IntersectionObserver in images.ts).
	card.appendChild(createImgTag(item, 48));

	const infoDiv = document.createElement('div');
	infoDiv.className = 'item-info';

	const nameSpan = document.createElement('span');
	nameSpan.className = 'item-name';
	nameSpan.textContent = getItemName(item);
	infoDiv.appendChild(nameSpan);

	const idSpan = document.createElement('span');
	idSpan.className = 'item-id';
	idSpan.textContent = item.name;
	infoDiv.appendChild(idSpan);

	if (isBlockItem(item.id)) {
		const badge = document.createElement('span');
		badge.className = 'item-badge block-badge';
		badge.textContent = t.blockBadge;
		infoDiv.appendChild(badge);
	}
	card.appendChild(infoDiv);
	return card;
}

// ---- Grid rendering (Fragment + chunked append, focus-preserving) ----

function renderItems(filter = '') {
	const token = ++renderToken;
	const t = translations[currentLang];
	const grid = getGrid();
	if (!grid) return;

	const filteredItems = getFilteredItems(filter);

	if (filteredItems.length === 0) {
		grid.innerHTML = '';
		const p = document.createElement('p');
		p.className = 'no-results';
		p.textContent = t.noResults;
		grid.appendChild(p);
		updateCount(0);
		return;
	}

	// Clear and append first chunk synchronously via DocumentFragment.
	grid.innerHTML = '';
	const frag = document.createDocumentFragment();
	const first = filteredItems.length < GRID_CHUNK ? filteredItems.length : GRID_CHUNK;
	for (let i = 0; i < first; i++) frag.appendChild(buildCard(filteredItems[i]));
	grid.appendChild(frag);
	updateCount(filteredItems.length);

	// Remaining chunks appended async to keep input responsive.
	if (filteredItems.length > first) {
		let idx = first;
		const appendNext = () => {
			if (token !== renderToken) return; // superseded by newer search
			const g = getGrid();
			if (!g) return;
			const f2 = document.createDocumentFragment();
			const end = Math.min(idx + GRID_CHUNK, filteredItems.length);
			for (let i = idx; i < end; i++) f2.appendChild(buildCard(filteredItems[i]));
			g.appendChild(f2);
			idx = end;
			if (idx < filteredItems.length) {
				if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(appendNext);
				else setTimeout(appendNext, 0);
			}
		};
		if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(appendNext);
		else setTimeout(appendNext, 0);
	}
}

function updateCount(filteredCount: number) {
	const el = getCount();
	if (el) el.textContent = `${filteredCount} / ${allItems.length} ${translations[currentLang].itemCount}`;
}

// ---- Bootstrap ----

export function init() {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initTool);
	} else {
		initTool();
	}
}

// Export rendering functions for testing/external use
export { renderModel, canRenderModel };

async function initTool() {
	// Reset cached refs on full re-init.
	gridEl = null;
	searchEl = null;
	countEl = null;
	gridDelegated = false;

	const appElement = document.getElementById('app') || document.body;
	appElement.innerHTML = `
		<h1 data-i18n="heading">📦 Items y Bloques de Minecraft</h1>
		<p class="subtitle" data-i18n="description">Explora todos los items y bloques disponibles. Haz clic en uno para ver su receta. Usa los filtros para ver solo bloques, solo items, o items crafteables.</p>

		<div class="filter-bar">
			<button class="filter-btn active" data-filter="all" data-i18n="filterAll">Todos</button>
			<button class="filter-btn" data-filter="blocks" data-i18n="filterBlocks">Bloques</button>
			<button class="filter-btn" data-filter="items" data-i18n="filterItems">Items</button>
			<button class="filter-btn" data-filter="craftable" data-i18n="filterCraftable">Crafteables</button>
		</div>

		<div class="search-container">
			<input type="text" id="searchInput" class="search-input" placeholder="Buscar items y bloques..." aria-label="Buscar items y bloques">
			<span class="search-icon">🔍</span>
		</div>

		<div class="stats-bar">
			<span id="itemCount" class="item-count"></span>
		</div>

		<div class="items-grid" id="itemsGrid">
			<div class="loading" data-i18n="loading">Cargando datos...</div>
		</div>
	`;

	setCurrentLang(initUi(translations, uiHooks));

	// Filter buttons
	document.querySelectorAll('.filter-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			const filter = btn.getAttribute('data-filter') as Filter;
			if (filter) applyFilter(filter);
		});
	});

	const searchInput = getSearch();
	if (searchInput) {
		let searchTimeout: number | undefined;
		searchInput.addEventListener('input', () => {
			if (searchTimeout !== undefined) clearTimeout(searchTimeout);
			searchTimeout = window.setTimeout(() => {
				searchTimeout = undefined;
				// Preserve focus + caret after re-render (render doesn't touch input).
				const active = document.activeElement === searchInput;
				const selStart = searchInput.selectionStart;
				const selEnd = searchInput.selectionEnd;
				renderItems(searchInput.value);
				if (active) {
					searchInput.focus({ preventScroll: true });
					try {
						if (selStart !== null && selEnd !== null) searchInput.setSelectionRange(selStart, selEnd);
					} catch {
						// ignore (non-text inputs)
					}
				}
			}, 150);
		});
	}

	await loadData();
	renderItems(getSearch()?.value || '');
}
