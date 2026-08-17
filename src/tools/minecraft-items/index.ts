// Minecraft Items & Blocks Browser
// Browse every Minecraft item and block with their recipes
// Every block is also an item; they differ by whether they place a block in the world
// Isometric 3D rendering for block models

import { initUi, setLang as uiSetLang } from '../../shared/ui';
import { translations } from './translations';
import { allItems, currentLang, setCurrentLang, loadData, getItemName, isBlockItem, hasRecipe } from './data';
import { createImgTag } from './images';
import { renderRecipeModal } from './recipes';
import { renderModel, canRenderModel } from './canvas-renderer';

type Filter = 'all' | 'blocks' | 'items' | 'craftable';

let currentFilter: Filter = 'all';

// ---- Language / theme (shared logic, page-specific hooks) ----

const uiHooks = {
	onApplyLang: (lang: string) => {
		const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
		if (searchInput) searchInput.placeholder = translations[lang].searchPlaceholder;
	},
	onLangChange: (lang: string) => {
		setCurrentLang(lang);
		renderItems(((document.getElementById('searchInput') as HTMLInputElement | null))?.value || '');
	},
};

function setLang(lang: string) {
	uiSetLang(lang, translations, uiHooks);
}

function applyFilter(filter: Filter) {
	currentFilter = filter;
	// Update active button
	document.querySelectorAll('.filter-btn').forEach(btn => {
		btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
	});
	renderItems(((document.getElementById('searchInput') as HTMLInputElement | null))?.value || '');
}

// ---- Grid rendering ----

function renderItems(filter = '') {
	const t = translations[currentLang];
	const grid = document.getElementById('itemsGrid');
	if (!grid) return;

	let filteredItems = allItems.filter(item => {
		const q = filter.toLowerCase();
		return (item.displayName || '').toLowerCase().includes(q) ||
			(item.displayNameEs || '').toLowerCase().includes(q) ||
			item.name.toLowerCase().includes(q) ||
			String(item.id).includes(filter);
	});

	// Apply type filter
	if (currentFilter === 'blocks') {
		filteredItems = filteredItems.filter(item => isBlockItem(item.id));
	} else if (currentFilter === 'items') {
		filteredItems = filteredItems.filter(item => !isBlockItem(item.id));
	} else if (currentFilter === 'craftable') {
		filteredItems = filteredItems.filter(item => hasRecipe(item.id));
	}

	if (filteredItems.length === 0) {
		grid.innerHTML = `<p class="no-results">${t.noResults}</p>`;
		return;
	}

	// Clear grid and build elements
	grid.innerHTML = '';
	for (const item of filteredItems) {
		const card = document.createElement('div');
		card.className = `item-card${isBlockItem(item.id) ? ' block-item' : ''}`;
		card.dataset.itemId = String(item.id);
		card.title = `${getItemName(item)} (${item.name})${isBlockItem(item.id) ? ` — ${t.blockBadge}` : ''}`;

		const imgElement = createImgTag(item, 48);
		card.appendChild(imgElement);

		const infoDiv = document.createElement('div');
		infoDiv.className = 'item-info';
		infoDiv.innerHTML = `
			<span class="item-name">${getItemName(item)}</span>
			<span class="item-id">${item.name}</span>
			${isBlockItem(item.id) ? `<span class="item-badge block-badge">${t.blockBadge}</span>` : ''}
		`;
		card.appendChild(infoDiv);

		card.addEventListener('click', () => {
			const itemId = parseInt(card.getAttribute('data-item-id') || '0');
			const foundItem = allItems.find(i => i.id === itemId);
			if (foundItem) renderRecipeModal(foundItem);
		});

		grid.appendChild(card);
	}

	updateCount(filteredItems.length);
}

function updateCount(filteredCount: number) {
	const countEl = document.getElementById('itemCount');
	if (countEl) countEl.textContent = `${filteredCount} / ${allItems.length} ${translations[currentLang].itemCount}`;
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

	const searchInput = document.getElementById('searchInput') as HTMLInputElement;
	if (searchInput) {
		let searchTimeout: number;
		searchInput.addEventListener('input', () => {
			clearTimeout(searchTimeout);
			searchTimeout = window.setTimeout(() => {
				renderItems(searchInput.value);
			}, 150);
		});
	}

	await loadData();
	renderItems();
}
