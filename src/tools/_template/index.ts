// Reference template for new tools.
// Copy this folder, rename it to the tool slug, and adjust `manifest.ts` and
// this file. Language/theme/dropdown are already handled in src/shared/ui.ts,
// so here you only define the texts and the tool's own UI.

import { initUi, type TranslationTable, type UiHooks } from '../../shared/ui';

const translations: TranslationTable = {
	es: {
		title: 'Nueva Herramienta — Bedrock Tools',
		heading: 'Nueva Herramienta',
		description: 'Descripción de lo que hace esta herramienta.',
		changeLanguageTitle: 'Cambiar idioma',
		switchToLightTitle: 'Cambiar a tema claro',
		switchToDarkTitle: 'Cambiar a tema oscuro',
		backHome: 'Volver al inicio',
	},
	en: {
		title: 'New Tool — Bedrock Tools',
		heading: 'New Tool',
		description: 'Description of what this tool does.',
		changeLanguageTitle: 'Change language',
		switchToLightTitle: 'Switch to light theme',
		switchToDarkTitle: 'Switch to dark theme',
		backHome: 'Back to home',
	},
};

// Optional hooks: run when the language changes/applies.
const uiHooks: UiHooks = {
	onLangChange: () => {
		// Re-render dynamic content if it depends on the language.
	},
};

export function init() {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initTool);
	} else {
		initTool();
	}
}

function initTool() {
	const app = document.getElementById('app') || document.body;
	app.innerHTML = `
		<h1 data-i18n="heading">Nueva Herramienta</h1>
		<p class="subtitle" data-i18n="description">Descripción de lo que hace esta herramienta.</p>
	`;

	// Applies language + theme + dropdowns; returns the active language.
	initUi(translations, uiHooks);

	// Add the tool's own logic here.
}

// For tools that only process files, use `process` (see organizar-packs).
export async function process(data: Uint8Array): Promise<Uint8Array> {
	return data;
}
