// Minecraft Bedrock Recipe Creator
// Create custom recipes (shaped / shapeless / furnace) using Minecraft's vanilla GUIs and
// export them all together as a single .mcpack addon. Reuses the 3D models and
// (ES/EN) names from the minecraft-items tool.

import { initUi, setLang as uiSetLang } from '../../shared/ui';
import type { ItemData } from './types';
import { translations } from './translations';
import {
	currentLang,
	platform,
	packName,
	javaPackFormat,
	setCurrentLang,
	setPlatform as setPlatformState,
	resetEditorState,
	setAllItems,
	setPackName,
	setJavaPackFormat,
} from './state';
import { renderRecipeList, renderEditor, addRecipe, currentPickerQuery, renderPickerGrid } from './editor';
import { handleImport } from './import';
import { exportMcpack, JAVA_VERSIONS } from './export';

// ---- Language / theme (shared logic, page-specific hooks) ----

const uiHooks = {
	onApplyLang: (lang: string) => {
		const search = document.getElementById('pickerSearch') as HTMLInputElement | null;
		if (search) search.placeholder = translations[lang].searchPlaceholder;
	},
	onLangChange: (lang: string) => {
		setCurrentLang(lang);
		applyPlatformUI();
		renderRecipeList();
		renderEditor();
		renderPickerGrid(currentPickerQuery());
	},
};

function setLang(lang: string) {
	uiSetLang(lang, translations, uiHooks);
}

// ---- Platform (Bedrock / Java) ----

function applyPlatformUI() {
	const isJava = platform === 'java';
	const t = translations[currentLang];
	document.querySelectorAll('.platform-tab').forEach((tab) => {
		tab.classList.toggle('active', tab.getAttribute('data-platform') === platform);
	});

	// The import card is always visible, but imports addons (Bedrock) or data packs (Java).
	const importHint = document.getElementById('importHint');
	if (importHint) importHint.textContent = isJava ? t.importHintJava : t.importHint;
	const importBtn = document.getElementById('importBtn');
	if (importBtn) importBtn.innerHTML = isJava ? t.importBtnJava : t.importBtn;
	const importInput = document.getElementById('importInput') as HTMLInputElement | null;
	if (importInput) importInput.accept = isJava ? '.zip' : '.mcpack,.mcaddon,.zip';

	const versionRow = document.getElementById('versionRow');
	if (versionRow) versionRow.style.display = isJava ? '' : 'none';

	const exportBtn = document.getElementById('exportBtn');
	if (exportBtn) {
		exportBtn.innerHTML = isJava ? t.exportBtnJava : t.exportBtn;
	}
}

function resetVersionSelect() {
	setJavaPackFormat(71);
	const sel = document.getElementById('versionSelect') as HTMLSelectElement | null;
	if (sel) {
		sel.querySelectorAll('option[data-imported]').forEach((o) => o.remove());
		sel.value = '71';
	}
}

function setPlatform(p: 'bedrock' | 'java') {
	if (platform === p) return;
	setPlatformState(p);
	// Each edition has different export/import rules, so start fresh on switch.
	resetEditorState();
	const input = document.getElementById('packNameInput') as HTMLInputElement | null;
	if (input) input.value = packName;
	const status = document.getElementById('status');
	if (status) status.innerHTML = '';
	resetVersionSelect();
	applyPlatformUI();
	addRecipe();
}

function startFresh() {
	resetEditorState();
	const input = document.getElementById('packNameInput') as HTMLInputElement | null;
	if (input) input.value = packName;
	const status = document.getElementById('status');
	if (status) status.innerHTML = '';
	resetVersionSelect();
	addRecipe();
}

// ---- Bootstrap ----

async function loadItems() {
	try {
		const res = await fetch('/data/items.json');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data: ItemData[] = await res.json();
		// Exclude synthetic items (generated potions, id >= 900000) that don't
		// have a real Bedrock identifier usable in a recipe.
		setAllItems(data.filter((item) => item.id < 900000));
		renderEditor();
	} catch (err) {
		console.error('Failed to load items:', err);
		const editor = document.getElementById('editor');
		if (editor) editor.innerHTML = `<p class="error">${translations[currentLang].errorLoad}</p>`;
	}
}

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
		<h1 data-i18n="heading">⚒️ Creador de Recetas</h1>
		<p class="subtitle" data-i18n="description">Diseña recetas de crafteo y horno para Minecraft Bedrock con las GUIs oficiales y expórtalas todas juntas en un addon .mcpack.</p>

		<div class="platform-switch" role="tablist" aria-label="Edition">
			<button type="button" class="platform-tab active" data-platform="bedrock" role="tab">🪨 <span data-i18n="platformBedrock">Bedrock</span></button>
			<button type="button" class="platform-tab" data-platform="java" role="tab">☕ <span data-i18n="platformJava">Java</span></button>
		</div>

		<div class="import-card" id="importCard">
			<div class="import-drop" id="importDrop">
				<span class="import-ico">📦</span>
				<p class="import-hint" id="importHint">Suelta aquí un .mcpack o .mcaddon (o haz clic para elegir)</p>
				<input type="file" id="importInput" accept=".mcpack,.mcaddon,.zip" hidden>
			</div>
			<div class="import-actions">
				<button type="button" id="importBtn" class="btn btn-secondary">📦 Importar addon</button>
				<button type="button" id="freshBtn" class="btn btn-ghost" data-i18n="newPackBtn">Empezar de nuevo</button>
			</div>
		</div>

		<div class="recipe-bar">
			<div class="recipe-list" id="recipeList"></div>
			<button type="button" class="add-recipe-btn" id="addRecipeBtn">＋ <span data-i18n="addRecipe">Añadir receta</span></button>
		</div>

		<div class="editor-card" id="editor">
			<div class="loading">${translations[currentLang].loading}</div>
		</div>

		<div class="export-card">
			<label class="editor-label" for="packNameInput" data-i18n="packNameLabel">Nombre del pack</label>
			<input type="text" id="packNameInput" class="text-input" value="Custom Recipes" spellcheck="false">

			<div class="version-row" id="versionRow" style="display:none">
				<label class="editor-label" for="versionSelect" data-i18n="versionLabel">Versión de Minecraft (data pack)</label>
				<select class="station-select" id="versionSelect">
					${JAVA_VERSIONS.map((v) => `<option value="${v.format}"${v.format === javaPackFormat ? ' selected' : ''}>${v.label}</option>`).join('')}
				</select>
			</div>

			<button type="button" id="exportBtn" class="btn btn-primary export-btn">⬇️ Exportar .mcpack</button>
			<div id="status"></div>
		</div>
	`;

	setCurrentLang(initUi(translations, uiHooks));

	document.getElementById('addRecipeBtn')?.addEventListener('click', addRecipe);

	// Platform toggle (Bedrock / Java).
	document.querySelectorAll('.platform-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			const p = tab.getAttribute('data-platform');
			if (p === 'bedrock' || p === 'java') setPlatform(p);
		});
	});

	// Import: file input + click + drag & drop.
	const importInput = document.getElementById('importInput') as HTMLInputElement | null;
	const importDrop = document.getElementById('importDrop');
	if (importInput) {
		importInput.addEventListener('change', () => {
			const file = importInput.files?.[0];
			if (file) handleImport(file);
			importInput.value = '';
		});
	}
	if (importDrop) {
		importDrop.addEventListener('click', (e) => {
			if (e.target instanceof HTMLInputElement) return;
			importInput?.click();
		});
		['dragenter', 'dragover'].forEach((ev) => importDrop.addEventListener(ev, (e) => {
			e.preventDefault();
			importDrop.classList.add('dragover');
		}));
		['dragleave', 'drop'].forEach((ev) => importDrop.addEventListener(ev, (e) => {
			e.preventDefault();
			importDrop.classList.remove('dragover');
		}));
		importDrop.addEventListener('drop', (e) => {
			const file = e.dataTransfer?.files?.[0];
			if (file) handleImport(file);
		});
	}
	document.getElementById('importBtn')?.addEventListener('click', () => importInput?.click());
	document.getElementById('freshBtn')?.addEventListener('click', startFresh);

	const packNameInput = document.getElementById('packNameInput') as HTMLInputElement | null;
	if (packNameInput) {
		packNameInput.addEventListener('input', () => { setPackName(packNameInput.value); });
	}
	const exportBtn = document.getElementById('exportBtn');
	if (exportBtn) exportBtn.addEventListener('click', exportMcpack);

	// Java version selector (pack_format).
	const versionSelect = document.getElementById('versionSelect') as HTMLSelectElement | null;
	if (versionSelect) {
		versionSelect.addEventListener('change', () => {
			setJavaPackFormat(parseInt(versionSelect.value, 10) || 71);
		});
	}

	// Reflect the current platform (export label, import visibility, active tab).
	applyPlatformUI();

	// Start with one empty recipe.
	addRecipe();

	await loadItems();
}
