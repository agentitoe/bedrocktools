import type { AnyItem, CustomItemData, ItemData } from './types';
import { allItems, customItems, currentLang, allocateCustomId } from './state';
import { titleCase } from './util';
import { createIconElement } from '../../shared/mc-render/icons';
import type { IconItem } from '../../shared/mc-render/icons';

// ---- Item rendering (delegates to the shared icon factory) ----

const PLACEHOLDER_SVG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22 viewBox=%220 0 48 48%22%3E%3Crect fill=%22%23666%22 width=%2248%22 height=%2248%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22 font-family=%22monospace%22%3E?%3C/text%3E%3C/svg%3E";

export function getItemName(item: AnyItem): string {
	return currentLang === 'es' && item.displayNameEs ? item.displayNameEs : item.displayName;
}

export function getItemById(id: number | null): AnyItem | undefined {
	if (id == null) return undefined;
	if (id >= 0) return allItems.find((i) => i.id === id);
	return customItems.find((i) => i.id === id);
}

export function getItemIdentifier(item: AnyItem): string {
	if ('name' in item) return 'minecraft:' + item.name;
	return item.identifier;
}

/** Resolve a full identifier ("minecraft:stone" or "mypack:thing") to an AnyItem. */
export function findItemByIdentifier(identifier: string): AnyItem | undefined {
	if (!identifier) return undefined;
	const lower = identifier.toLowerCase();
	if (lower.startsWith('minecraft:')) {
		const name = lower.slice('minecraft:'.length);
		return allItems.find((i) => i.name === name);
	}
	return customItems.find((i) => i.identifier === identifier);
}

/** Get an existing custom item, or register a new one (negative id, no collision with vanilla). */
export function getOrCreateCustomItem(identifier: string, kind: 'item' | 'block', textureUrl?: string): CustomItemData {
	const existing = customItems.find((i) => i.identifier === identifier);
	if (existing) {
		if (textureUrl && !existing.textureUrl) existing.textureUrl = textureUrl;
		if (existing.kind === 'item' && kind === 'block') existing.kind = 'block';
		return existing;
	}
	const fallback = identifier.split(':').pop() || identifier;
	const item: CustomItemData = {
		id: allocateCustomId(),
		identifier,
		displayName: titleCase(fallback.replace(/[_-]/g, ' ')),
		kind,
		textureUrl
	};
	customItems.push(item);
	return item;
}

/** Resolve an identifier string to a numeric item id (creating a custom entry for unknown ids). */
export function resolveItemId(identifier: string): number {
	const existing = findItemByIdentifier(identifier);
	if (existing) return existing.id;
	return getOrCreateCustomItem(identifier, 'item').id;
}

/** Extract an item identifier from a value that may be a plain string or an { "item" / "id" / "name" } object. */
export function extractItemIdentifier(value: any): string | null {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		if (typeof value.id === 'string') return value.id;
		if (typeof value.item === 'string') return value.item;
		if (typeof value.name === 'string') return value.name;
	}
	return null;
}

/** The render description the shared icon factory needs for this item. */
function toIconItem(item: AnyItem): IconItem {
	// `CustomItemData` (extracted from an imported addon) carries no model, so it
	// can only ever be a flat texture.
	if ('kind' in item) return { id: item.id, textureUrl: item.textureUrl };
	return {
		id: item.id,
		renderAs: item.renderAs,
		modelName: item.modelName,
		textureUrl: item.textureUrl
	};
}

export function createImgTag(item: AnyItem, size = 48): HTMLCanvasElement | HTMLImageElement {
	const icon = createIconElement(toIconItem(item), size);
	if (icon instanceof HTMLImageElement) {
		const image: HTMLImageElement = icon;
		image.alt = getItemName(item);
		if (image.getAttribute('src') === null) image.src = PLACEHOLDER_SVG;
		image.onerror = () => {
			image.onerror = null;
			image.src = PLACEHOLDER_SVG;
		};
	}
	return icon;
}
