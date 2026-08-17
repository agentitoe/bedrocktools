import type { ItemData, RecipeData, RecipeType } from './types';
import { translations } from './translations';
import { currentLang, getItemById, getItemByDisplayName, getItemName, getRecipeForItem, isBlockItem } from './data';
import { createImgTag } from './images';

export type RecipeCategory = 'crafting' | 'smelting' | 'blasting' | 'smoking' | 'campfire_cooking' | 'stonecutting' | 'smithing' | 'brewing';

export function getRecipeCategory(type: RecipeType): RecipeCategory {
	switch (type) {
		case 'crafting_shaped':
		case 'crafting_shapeless': return 'crafting';
		case 'smelting': return 'smelting';
		case 'blasting': return 'blasting';
		case 'smoking': return 'smoking';
		case 'campfire_cooking': return 'campfire_cooking';
		case 'stonecutting': return 'stonecutting';
		case 'smithing': return 'smithing';
		case 'brewing': return 'brewing';
	}
}

export function getRecipeCategoryLabel(category: RecipeCategory): string {
	const t = translations[currentLang];
	switch (category) {
		case 'crafting': return t.recipeCategoryCrafting;
		case 'smelting': return t.recipeCategorySmelting;
		case 'blasting': return t.recipeCategoryBlasting;
		case 'smoking': return t.recipeCategorySmoking;
		case 'campfire_cooking': return t.recipeCategoryCampfire;
		case 'stonecutting': return t.recipeCategoryStonecutting;
		case 'smithing': return t.recipeCategorySmithing;
		case 'brewing': return t.recipeCategoryBrewing;
	}
}

const RECIPE_CATEGORY_ICONS: Record<RecipeCategory, string> = {
	crafting: '🛠️',
	smelting: '🔥',
	blasting: '💥',
	smoking: '💨',
	campfire_cooking: '🏕️',
	stonecutting: '🪨',
	smithing: '⚒️',
	brewing: '🧪',
};

function createRecipeSlot(id: number | null | undefined, size: number): HTMLDivElement {
	const slot = document.createElement('div');
	slot.className = 'recipe-slot';
	if (id === null || id === undefined) {
		slot.classList.add('empty');
		return slot;
	}
	const ingItem = getItemById(id);
	if (ingItem) {
		slot.appendChild(createImgTag(ingItem, size));
		const tooltip = document.createElement('span');
		tooltip.className = 'item-name-tooltip';
		tooltip.textContent = getItemName(ingItem);
		slot.appendChild(tooltip);
	} else {
		slot.classList.add('unknown');
		slot.textContent = '?';
	}
	return slot;
}

function createRecipeArrow(): HTMLSpanElement {
	const arrow = document.createElement('span');
	arrow.className = 'recipe-arrow';
	return arrow;
}

function normalizeCraftingCells(recipe: RecipeData): Array<number | null> {
	const cells: Array<number | null> = new Array(9).fill(null);
	if (recipe.type === 'crafting_shapeless') {
		const ingredients = recipe.ingredients || [];
		for (let i = 0; i < Math.min(9, ingredients.length); i++) cells[i] = ingredients[i];
	} else {
		const shape = recipe.inShape || [];
		for (let r = 0; r < Math.min(3, shape.length); r++) {
			const row = shape[r] || [];
			for (let c = 0; c < Math.min(3, row.length); c++) cells[r * 3 + c] = row[c] ?? null;
		}
	}
	return cells;
}

/**
 * Slot positioned over a vanilla GUI texture. `x`/`y` are vanilla logical
 * coordinates (176x166 grid); CSS scales them with the `--s` variable.
 */
function createGuiSlot(id: number | null | undefined, size: number, x: number, y: number, count?: number): HTMLDivElement {
	const slot = document.createElement('div');
	slot.className = 'gui-slot';
	slot.style.left = `calc(var(--s) * ${x}px)`;
	slot.style.top = `calc(var(--s) * ${y}px)`;
	if (id === null || id === undefined) return slot;

	const ingItem = getItemById(id);
	if (!ingItem) {
		slot.classList.add('unknown');
		slot.textContent = '?';
		return slot;
	}

	slot.appendChild(createImgTag(ingItem, size));
	if (count != null && count > 1) {
		const badge = document.createElement('span');
		badge.className = 'gui-count';
		badge.textContent = `×${count}`;
		slot.appendChild(badge);
	}
	const tooltip = document.createElement('span');
	tooltip.className = 'item-name-tooltip';
	tooltip.textContent = getItemName(ingItem);
	slot.appendChild(tooltip);
	return slot;
}

function renderVanillaGui(recipe: RecipeData): HTMLDivElement {
	const panel = document.createElement('div');

	switch (recipe.type) {
		case 'crafting_shaped':
		case 'crafting_shapeless': {
			panel.className = 'recipe-gui gui-crafting';
			const cells = normalizeCraftingCells(recipe);
			for (let r = 0; r < 3; r++) {
				for (let c = 0; c < 3; c++) {
					const id = cells[r * 3 + c];
					if (id === null) continue;
					panel.appendChild(createGuiSlot(id, 32, 30 + c * 18, 17 + r * 18));
				}
			}
			panel.appendChild(createGuiSlot(recipe.result?.id, 32, 124, 35, recipe.result?.count));
			break;
		}
		case 'smelting':
		case 'blasting':
		case 'smoking':
		case 'campfire_cooking': {
			const gui = recipe.type === 'blasting' ? 'gui-blast' : recipe.type === 'smoking' ? 'gui-smoker' : 'gui-furnace';
			panel.className = `recipe-gui ${gui}`;
			panel.appendChild(createGuiSlot(recipe.ingredient, 32, 56, 17));
			panel.appendChild(createGuiSlot(recipe.result?.id, 32, 116, 35, recipe.result?.count));
			break;
		}
		case 'stonecutting': {
			panel.className = 'recipe-gui gui-stonecutter';
			panel.appendChild(createGuiSlot(recipe.ingredient, 32, 20, 33));
			panel.appendChild(createGuiSlot(recipe.result?.id, 32, 143, 33, recipe.result?.count));
			break;
		}
		case 'smithing': {
			panel.className = 'recipe-gui gui-smithing';
			panel.appendChild(createGuiSlot(recipe.template, 32, 8, 48));
			panel.appendChild(createGuiSlot(recipe.base, 32, 26, 48));
			panel.appendChild(createGuiSlot(recipe.addition, 32, 44, 48));
			panel.appendChild(createGuiSlot(recipe.result?.id, 32, 98, 48, recipe.result?.count));
			break;
		}
		default: {
			panel.className = 'recipe-gui';
		}
	}

	return panel;
}

function createGuiLabelSlot(text: string, x: number, y: number): HTMLDivElement {
	const slot = document.createElement('div');
	slot.className = 'gui-slot gui-label';
	slot.style.left = `calc(var(--s) * ${x}px)`;
	slot.style.top = `calc(var(--s) * ${y}px)`;
	const label = document.createElement('span');
	label.className = 'gui-label-text';
	label.textContent = text;
	slot.appendChild(label);
	return slot;
}

function renderBrewingChain(recipe: RecipeData): HTMLDivElement {
	const wrapper = document.createElement('div');
	wrapper.className = 'brewing-chain';

	// Every brewing recipe carries the full step chain (water -> base ->
	// effect -> upgrade -> splash -> lingering). Each step is drawn inside
	// the vanilla brewing stand GUI.
	const steps = recipe.steps && recipe.steps.length > 0
		? recipe.steps
		: (recipe.ingredient != null ? [{ ingredient: recipe.ingredient, baseLabel: recipe.baseLabel || '', resultLabel: recipe.resultLabel || '' }] : []);

	for (const [i, step] of steps.entries()) {
		const panel = document.createElement('div');
		panel.className = 'recipe-gui gui-brewing';

		// Step number chip.
		const chip = document.createElement('span');
		chip.className = 'brew-step-chip';
		chip.textContent = String(i + 1);
		panel.appendChild(chip);

		// Ingredient (top slot).
		panel.appendChild(createGuiSlot(step.ingredient, 32, 79, 17));

		// Base potion (left bottle).
		const baseItem = getItemByDisplayName(step.baseLabel);
		if (baseItem) panel.appendChild(createGuiSlot(baseItem.id, 32, 56, 51));
		else panel.appendChild(createGuiLabelSlot(step.baseLabel, 56, 51));

		// Arrow between base and result (middle bottle position).
		const arrow = document.createElement('span');
		arrow.className = 'brew-arrow';
		arrow.textContent = '→';
		arrow.style.left = `calc(var(--s) * 79px)`;
		arrow.style.top = `calc(var(--s) * 51px)`;
		panel.appendChild(arrow);

		// Result potion (right bottle).
		const resultItem = getItemByDisplayName(step.resultLabel);
		if (resultItem) panel.appendChild(createGuiSlot(resultItem.id, 32, 102, 51));
		else panel.appendChild(createGuiLabelSlot(step.resultLabel, 102, 51));

		wrapper.appendChild(panel);
	}

	return wrapper;
}

function renderRecipeCard(recipe: RecipeData): HTMLDivElement {
	const t = translations[currentLang];
	const card = document.createElement('div');
	card.className = 'recipe-card';

	if (recipe.type === 'brewing') {
		card.appendChild(renderBrewingChain(recipe));
		return card;
	}

	card.appendChild(renderVanillaGui(recipe));

	if (recipe.type === 'smelting' || recipe.type === 'blasting' || recipe.type === 'smoking' || recipe.type === 'campfire_cooking') {
		const meta: string[] = [];
		if (recipe.experience != null) meta.push(`${t.recipeExperience}: ${recipe.experience}`);
		if (recipe.cookingtime) meta.push(`${(recipe.cookingtime / 20).toFixed(0)}s`);
		if (meta.length) {
			const note = document.createElement('div');
			note.className = 'gui-meta';
			note.textContent = meta.join(' · ');
			card.appendChild(note);
		}
	}

	return card;
}

function buildModalHeader(item: ItemData): HTMLDivElement {
	const t = translations[currentLang];
	const header = document.createElement('div');
	header.className = 'modal-header';

	const icon = document.createElement('div');
	icon.className = 'header-icon';
	icon.appendChild(createImgTag(item, 34));
	header.appendChild(icon);

	const titles = document.createElement('div');
	titles.className = 'header-titles';
	const h3 = document.createElement('h3');
	h3.textContent = getItemName(item);
	titles.appendChild(h3);
	const sub = document.createElement('span');
	sub.className = 'header-sub';
	sub.textContent = t.recipeTitle;
	titles.appendChild(sub);
	header.appendChild(titles);

	const close = document.createElement('button');
	close.className = 'modal-close';
	close.type = 'button';
	close.setAttribute('aria-label', t.close);
	close.title = t.close;
	close.textContent = '✕';
	header.appendChild(close);

	return header;
}

function attachModalClose(modal: HTMLElement) {
	modal.querySelector('.modal-close')?.addEventListener('click', () => modal.remove());
	modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
	const handleEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			modal.remove();
			document.removeEventListener('keydown', handleEsc);
		}
	};
	document.addEventListener('keydown', handleEsc);
}

export function renderRecipeModal(item: ItemData) {
	const t = translations[currentLang];
	const recipes = getRecipeForItem(item.id);
	const isBlock = isBlockItem(item.id);

	const modal = document.createElement('div');
	modal.className = 'modal-overlay';
	const modalContent = document.createElement('div');
	modalContent.className = 'modal mc-modal';
	modalContent.appendChild(buildModalHeader(item));

	const body = document.createElement('div');
	body.className = 'modal-body';

	if (!recipes || recipes.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'no-recipe-empty';
		const bigIcon = document.createElement('div');
		bigIcon.className = 'no-recipe-icon';
		bigIcon.appendChild(createImgTag(item, 64));
		empty.appendChild(bigIcon);
		const p = document.createElement('p');
		p.className = 'no-recipe';
		p.textContent = isBlock ? t.noRecipeBlock : t.noRecipeItem;
		empty.appendChild(p);
		body.appendChild(empty);
	} else {
		// Group recipes by their crafting station so all recipes of the same
		// category appear together under one header.
		const categoryOrder: RecipeCategory[] = ['crafting', 'smelting', 'blasting', 'smoking', 'campfire_cooking', 'stonecutting', 'smithing', 'brewing'];
		const grouped = new Map<RecipeCategory, RecipeData[]>();
		for (const recipe of recipes) {
			const cat = getRecipeCategory(recipe.type);
			if (!grouped.has(cat)) grouped.set(cat, []);
			grouped.get(cat)!.push(recipe);
		}

		for (const cat of categoryOrder) {
			const catRecipes = grouped.get(cat);
			if (!catRecipes || catRecipes.length === 0) continue;
			const section = document.createElement('div');
			section.className = 'recipe-category';
			const header = document.createElement('div');
			header.className = 'recipe-category-header';
			const icon = document.createElement('span');
			icon.className = 'cat-icon';
			icon.textContent = RECIPE_CATEGORY_ICONS[cat] || '📜';
			header.appendChild(icon);
			const label = document.createElement('span');
			label.className = 'cat-label';
			label.textContent = getRecipeCategoryLabel(cat);
			header.appendChild(label);
			section.appendChild(header);
			for (const recipe of catRecipes) section.appendChild(renderRecipeCard(recipe));
			body.appendChild(section);
		}
	}

	modalContent.appendChild(body);
	modal.appendChild(modalContent);
	document.body.appendChild(modal);
	attachModalClose(modal);
}
