/*
 * Seed Map — ui/controls.ts
 * E6 toolbar + sidebar + status bar wiring around the SeedMapHandle.
 *
 * Owns:
 *   - seed box: change/blur/submit -> parseSeedInput -> setState + canonical
 *     URL (?seed=, debounced 300 ms via history.replaceState — never a new
 *     history entry); parse failures show the seedInvalid notice.
 *   - random seed: one crypto.getRandomValues draw of a full i64.
 *   - version select: fills #smVersion from ui/versions.ts; a change keeps
 *     the current seed and re-applies the layer filter (types the new
 *     version does not offer render disabled).
 *   - dimension select: stays disabled (Overworld only in this phase) —
 *     the options exist in index.html for when Nether/End arrive.
 *   - layers panel: checkbox toggles per catalog type with color swatch and
 *     struct_* translation; persist to localStorage 'seed-map:layers'
 *     (JSON array of active ids) and apply on load.
 *   - legend: LEGEND_IDS entries with biome_* translations and the palette
 *     CSS color, repainted on language change.
 *   - status bar: cursor coords (handle.onCursorMove), seed/version (on
 *     every applied state), tile generation count (250 ms interval reading
 *     handle.tilesPending() — no TileManager surface is added).
 *
 * Language: shared/initUi sets <html lang> on every switch; this module
 * watches that attribute with a MutationObserver and repaints the dynamic
 * parts (data-i18n static markup is already handled by shared/ui).
 */

import { STRUCTURE_CATALOG, structuresForMc, type StructureEntry } from '../structures/catalog';
import { biomeCssColor, defaultPalette } from '../biome-colors';
import { translations } from '../translations';
import { canonicalSeedText, parseSeedInput } from './seed-text';
import { DEFAULT_MC_VERSION, MC_VERSION_CHOICES, versionLabel } from './versions';
import { LEGEND_IDS, legendBiomeKey } from './legend';
import type { I18nDict } from '../../../shared/ui';
import type { SeedMapHandle } from '../index';

/** Per-tool localStorage keys (namespaced, plain JSON). */
const LAYERS_STORAGE_KEY = 'seed-map:layers';
const URL_SYNC_DEBOUNCE_MS = 300;
const TILES_POLL_MS = 250;

export type MountControlsOptions = {
	/** Extra hook for the language repaint (tests / future consumers). */
	onLangChange?: (lang: string) => void;
};

/** Translation dict of the current page language (falls back to EN like shared). */
function dictFor(): I18nDict {
	const lang = document.documentElement.getAttribute('lang') || 'en';
	return translations[lang] ?? translations.en;
}

/**
 * Wires every interactive piece of the seed map page around the handle.
 * Call after initUi + mountSeedMap; throws when the page markup is missing.
 */
export function mountControls(handle: SeedMapHandle, opts: MountControlsOptions = {}): void {
	const form = requireEl<HTMLFormElement>('smToolbar');
	const seedInput = requireEl<HTMLInputElement>('smSeed');
	const randomButton = requireEl<HTMLButtonElement>('smRandomBtn');
	const seedError = requireEl<HTMLElement>('smSeedError');
	const versionSelect = requireEl<HTMLSelectElement>('smVersion');
	const dimSelect = requireEl<HTMLSelectElement>('smDim');
	const layersHost = requireEl<HTMLElement>('smLayers');
	const legendHost = requireEl<HTMLElement>('smLegend');
	const statusCoords = requireEl<HTMLElement>('smStatusCoords');
	const statusSeed = requireEl<HTMLElement>('smStatusSeed');
	const statusVersion = requireEl<HTMLElement>('smStatusVersion');
	const statusTiles = requireEl<HTMLElement>('smStatusTiles');

	// ------------------------------------------------------------- state

	/** Active seed (exact i64); the only place `Number(seed of the box)` is FORBIDDEN. */
	let currentSeed = initialSeedFromParams();
	let currentVersion = DEFAULT_MC_VERSION;
	/** ids the user left ON (full-catalog scope; version filter is separate). */
	let activeIds = loadActiveIds();
	let urlSyncTimer: number | undefined = undefined;
	const palette = defaultPalette();

	// ------------------------------------------------------------- helpers

	function paintStatus(): void {
		const dict = dictFor();
		statusSeed.textContent = canonicalSeedText(currentSeed);
		statusVersion.textContent = versionLabel(currentVersion);
		statusCoords.textContent = dict.statusEmpty;
	}

	function showSeedError(): void {
		seedError.hidden = false;
	}

	function hideSeedError(): void {
		seedError.hidden = true;
	}

	/** Canonical URL text of ?seed= for a seed; keeps other query params. */
	function scheduleUrlSync(seed: bigint): void {
		const params = new URLSearchParams(window.location.search);
		params.set('seed', canonicalSeedText(seed));
		const query = params.toString();
		const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
		if (urlSyncTimer !== undefined) clearTimeout(urlSyncTimer);
		urlSyncTimer = window.setTimeout(() => {
			urlSyncTimer = undefined;
			history.replaceState(null, '', nextUrl);
		}, URL_SYNC_DEBOUNCE_MS);
	}

	/**
	 * Parses seed text (Java-faithful) and applies it. Never re-uploads while
	 * the text is not a valid seed: only the last valid state stays applied.
	 */
	function applySeedText(text: string, syncUrl: boolean): void {
		try {
			currentSeed = parseSeedInput(text);
		} catch {
			showSeedError();
			return;
		}
		hideSeedError();
		seedInput.value = canonicalSeedText(currentSeed);
		void handle.setState({ seed: currentSeed, version: currentVersion, dim: 0 });
		paintStatus();
		if (syncUrl) scheduleUrlSync(currentSeed);
	}

	function applyEnabledIds(): void {
		handle.setStructuresEnabled([...activeIds]);
	}

	// ---------------------------------------------------------------- seed

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		applySeedText(seedInput.value, true);
	});
	seedInput.addEventListener('change', () => {
		applySeedText(seedInput.value, true);
	});
	seedInput.addEventListener('blur', () => {
		applySeedText(seedInput.value, true);
	});

	// Full i64 draw; wrapping into the signed range via asIntN keeps the
	// exact same i64 range parseSeedInput accepts.
	randomButton.addEventListener('click', () => {
		const draw = crypto.getRandomValues(new BigInt64Array(1))[0];
		const seed = BigInt.asIntN(64, draw);
		seedInput.value = canonicalSeedText(seed);
		applySeedText(seedInput.value, true);
	});

	// ------------------------------------------------------------- version

	for (const choice of MC_VERSION_CHOICES) {
		const option = document.createElement('option');
		option.value = String(choice.enum);
		option.text = choice.label;
		versionSelect.appendChild(option);
	}
	versionSelect.value = String(currentVersion);

	versionSelect.addEventListener('change', () => {
		currentVersion = Number(versionSelect.value);
		// The scan relay filters by version inside setState; the layer panel
		// re-filters here (unavailable types render disabled, not hidden).
		renderLayers();
		void handle.setState({ seed: currentSeed, version: currentVersion, dim: 0 });
		paintStatus();
	});

	// Dimension stays disabled: options exist (index.html) for Nether/End.
	dimSelect.value = '0';

	// ------------------------------------------------------------- layers

	function layerAvailable(entry: StructureEntry): boolean {
		return structuresForMc(currentVersion).some((e) => e.id === entry.id);
	}

	function renderLayers(): void {
		const dict = dictFor();
		layersHost.textContent = '';
		for (const entry of STRUCTURE_CATALOG) {
			const row = document.createElement('label');
			row.className = 'sm-layer';
			const available = layerAvailable(entry);
			if (!available) row.classList.add('is-disabled');

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = activeIds.has(entry.id);
			checkbox.disabled = !available;
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) activeIds.add(entry.id);
				else activeIds.delete(entry.id);
				saveActiveIds(activeIds);
				applyEnabledIds();
			});

			const swatch = document.createElement('span');
			swatch.className = 'sm-layer-dot';
			swatch.style.background = entry.marker.color;

			const name = document.createElement('span');
			name.textContent = dict['struct_' + entry.id] ?? entry.id;

			row.append(checkbox, swatch, name);
			layersHost.appendChild(row);
		}
	}

	// ------------------------------------------------------------- legend

	function renderLegend(): void {
		const dict = dictFor();
		legendHost.textContent = '';
		for (const id of LEGEND_IDS) {
			const item = document.createElement('span');
			item.className = 'sm-legend-item';

			const swatch = document.createElement('span');
			swatch.className = 'sm-legend-swatch';
			swatch.dataset.biome = String(id);
			swatch.style.background = biomeCssColor(palette, id);

			const name = document.createElement('span');
			name.textContent = dict[legendBiomeKey(id)] ?? String(id);

			item.append(swatch, name);
			legendHost.appendChild(item);
		}
	}

	// ------------------------------------------------------------- status

	window.setInterval(() => {
		const pending = handle.tilesPending();
		statusTiles.textContent = String(pending);
		statusTiles.classList.toggle('is-pending', pending > 0);
	}, TILES_POLL_MS);

	handle.onCursorMove((pos) => {
		const dict = dictFor();
		statusCoords.textContent = pos === null ? dict.statusEmpty : `${pos.x}, ${pos.z}`;
	});

	// ---------------------------------------------------------- language

	function repaintI18n(): void {
		const dict = dictFor();
		renderLayers();
		renderLegend();
		statusCoords.textContent = dict.statusEmpty;
		statusSeed.textContent = canonicalSeedText(currentSeed);
		statusVersion.textContent = versionLabel(currentVersion);
		opts.onLangChange?.(document.documentElement.getAttribute('lang') || 'en');
	}

	// shared/initUi repaints [data-i18n] AND rewrites <html lang>; watching
	// that attribute is the minimal viable change signal for dynamic content.
	const langObserver = new MutationObserver(repaintI18n);
	langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

	// ------------------------------------------------------------- mount

	seedInput.value = canonicalSeedText(currentSeed);
	applyEnabledIds(); // persisted toggles apply before the first scan batch
	renderLayers();
	renderLegend();
	paintStatus();
	void handle.setState({ seed: currentSeed, version: currentVersion, dim: 0 });
	scheduleUrlSync(currentSeed);
}

// ------------------------------------------------------------------ pieces

function requireEl<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (el === null) throw new Error('seed map page is missing #' + id);
	return el as T;
}

/** ?seed= of the current URL parsed Java-faithfully; junk falls back to 0n. */
function initialSeedFromParams(): bigint {
	const raw = new URLSearchParams(window.location.search).get('seed');
	try {
		return parseSeedInput(raw ?? '');
	} catch {
		return 0n;
	}
}

/** Persisted layer toggles; unknown or corrupt entries reset to all-on. */
function loadActiveIds(): Set<string> {
	const known = STRUCTURE_CATALOG.map((entry) => entry.id);
	try {
		const raw = localStorage.getItem(LAYERS_STORAGE_KEY);
		if (raw === null) return new Set(known);
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set(known);
		const stored = new Set(parsed.filter((v): v is string => typeof v === 'string'));
		// Intersection with the catalog: stale ids from older must not exist.
		return new Set(known.filter((id) => stored.has(id)));
	} catch {
		return new Set(known); // corrupt storage must never brick the page
	}
}

function saveActiveIds(activeIds: Set<string>): void {
	localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify([...activeIds]));
}
