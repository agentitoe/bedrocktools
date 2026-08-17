// Shared UI helpers: language switching, theme toggling and the language
// dropdown. Every tool and the home page use the same top-bar markup
// (#langToggle / #langDropdown / #themeToggle), so this logic lives here once.
//
// HOW TO ADD A NEW LANGUAGE
//   1. Add an entry to LANGUAGES below (code, flag, label, name).
//   2. Add a "<code>" object to the `translations` table of each tool/page you
//      want to translate (see `translations` in each tool's source).
//   3. Run `npm run build` to regenerate public/assets/ui.js.
// That's it. The dropdown, the toggle label and the fallback pick it up
// automatically. Pages that haven't been translated yet show that language
// disabled, and every page always falls back to at least one language.

export interface Language {
	/** ISO language code, e.g. "en". */
	code: string;
	/** Emoji flag shown in the switcher. */
	flag: string;
	/** Short code shown next to the flag, e.g. "EN". */
	label: string;
	/** Native name, used for the option's tooltip. */
	name: string;
}

/** Every language the site supports. Order here is the dropdown order. */
export const LANGUAGES: Language[] = [
	{ code: 'es', flag: '🇪🇸', label: 'ES', name: 'Español' },
	{ code: 'en', flag: '🇬🇧', label: 'EN', name: 'English' },
];

/** Language used when the user's preference isn't available. */
export const FALLBACK_LANG = 'es';

export interface I18nDict {
	changeLanguageTitle: string;
	switchToLightTitle: string;
	switchToDarkTitle: string;
	[key: string]: string;
}

export type TranslationTable = Record<string, I18nDict>;

export interface UiHooks {
	/** Runs after the language is changed (e.g. re-render dynamic content). */
	onLangChange?: (lang: string) => void;
	/** Runs right after [data-i18n] elements are updated (e.g. page-specific placeholders/status). */
	onApplyLang?: (lang: string) => void;
}

function languageByCode(code: string): Language | undefined {
	return LANGUAGES.find((l) => l.code === code);
}

/** The user's preferred language: saved choice -> browser -> fallback. */
export function getLang(): string {
	const saved = localStorage.getItem('lang');
	if (saved && languageByCode(saved)) return saved;
	const browser = (navigator.language || navigator.languages?.[0] || '').toLowerCase();
	const base = browser.split('-')[0];
	if (base && languageByCode(base)) return base;
	return FALLBACK_LANG;
}

/**
 * Resolve a requested language to one the page actually has translations for.
 * Guarantees every page ends up with at least one valid language.
 */
function resolveLang(translations: TranslationTable, requested: string): string {
	if (translations[requested]) return requested;
	if (translations[FALLBACK_LANG]) return FALLBACK_LANG;
	const first = Object.keys(translations)[0];
	return first || FALLBACK_LANG;
}

function setLangToggleLabel(lang: string): void {
	const langToggle = document.getElementById('langToggle');
	if (!langToggle) return;
	const meta = languageByCode(lang);
	const flag = meta ? meta.flag : '';
	const label = meta ? meta.label : lang.toUpperCase();
	langToggle.innerHTML = `<span class="noto-color-emoji-regular">${flag}</span> <span class="label">${label}</span>`;
}

/**
 * Build the language dropdown from LANGUAGES. Languages the current page hasn't
 * translated are shown disabled, so the switcher always reflects what the page
 * actually supports.
 */
function buildLangMenu(translations: TranslationTable): void {
	const dropdown = document.getElementById('langDropdown');
	if (!dropdown) return;
	dropdown.innerHTML = '';
	for (const meta of LANGUAGES) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'lang-option';
		btn.setAttribute('role', 'menuitem');
		btn.dataset.lang = meta.code;
		btn.title = meta.name;
		btn.innerHTML = `<span class="noto-color-emoji-regular">${meta.flag}</span> ${meta.label}`;
		if (!translations[meta.code]) {
			btn.disabled = true;
			btn.setAttribute('aria-disabled', 'true');
		}
		dropdown.appendChild(btn);
	}
}

/**
 * Apply a language to the page: sets <html lang>, the toggle button label and
 * every [data-i18n] element (inputs get their `placeholder` updated instead of
 * their markup).
 */
export function applyLang(lang: string, translations: TranslationTable, hooks?: UiHooks): void {
	document.documentElement.lang = lang;
	setLangToggleLabel(lang);
	const t = translations[lang];
	if (t) {
		document.querySelectorAll('[data-i18n]').forEach((el) => {
			const key = el.getAttribute('data-i18n');
			if (!key || t[key] === undefined) return;
			if (el instanceof HTMLInputElement && el.type !== 'submit' && el.type !== 'button') {
				el.placeholder = t[key];
			} else if (el instanceof HTMLTextAreaElement) {
				el.placeholder = t[key];
			} else {
				el.innerHTML = t[key];
			}
		});
	}
	hooks?.onApplyLang?.(lang);
}

/** Update the tooltip/aria-label of the language and theme buttons. */
export function applyTitles(lang: string, translations: TranslationTable): void {
	const t = translations[lang];
	if (!t) return;
	const langToggle = document.getElementById('langToggle');
	if (langToggle) {
		langToggle.title = t.changeLanguageTitle;
		langToggle.setAttribute('aria-label', t.changeLanguageTitle);
	}
	const themeToggle = document.getElementById('themeToggle');
	if (themeToggle) {
		const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
		themeToggle.title = isDark ? t.switchToLightTitle : t.switchToDarkTitle;
		themeToggle.setAttribute('aria-label', isDark ? t.switchToLightTitle : t.switchToDarkTitle);
	}
}

export function setLang(lang: string, translations: TranslationTable, hooks?: UiHooks): void {
	localStorage.setItem('lang', lang);
	applyLang(lang, translations, hooks);
	applyTitles(lang, translations);
	hooks?.onLangChange?.(lang);
}

export function initTheme(): void {
	const themeToggle = document.getElementById('themeToggle');
	if (!themeToggle) return;
	const savedTheme = localStorage.getItem('theme');
	if (savedTheme === 'dark') {
		document.documentElement.setAttribute('data-theme', 'dark');
		themeToggle.innerHTML = '<span class="noto-color-emoji-regular">🌙</span>';
	} else if (savedTheme === 'light') {
		document.documentElement.removeAttribute('data-theme');
		themeToggle.innerHTML = '<span class="noto-color-emoji-regular">☀️</span>';
	} else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
		document.documentElement.setAttribute('data-theme', 'dark');
		themeToggle.innerHTML = '<span class="noto-color-emoji-regular">🌙</span>';
		localStorage.setItem('theme', 'dark');
	} else {
		document.documentElement.removeAttribute('data-theme');
		themeToggle.innerHTML = '<span class="noto-color-emoji-regular">☀️</span>';
		localStorage.setItem('theme', 'light');
	}
}

export function initThemeToggle(translations: TranslationTable): void {
	const themeToggle = document.getElementById('themeToggle');
	if (!themeToggle) return;
	themeToggle.addEventListener('click', () => {
		const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
		if (isDark) {
			document.documentElement.removeAttribute('data-theme');
			localStorage.setItem('theme', 'light');
			themeToggle.innerHTML = '<span class="noto-color-emoji-regular">☀️</span>';
		} else {
			document.documentElement.setAttribute('data-theme', 'dark');
			localStorage.setItem('theme', 'dark');
			themeToggle.innerHTML = '<span class="noto-color-emoji-regular">🌙</span>';
		}
		applyTitles(resolveLang(translations, getLang()), translations);
	});
}

export function initDropdowns(translations: TranslationTable, hooks?: UiHooks): void {
	const langToggle = document.getElementById('langToggle');
	const langDropdown = document.getElementById('langDropdown');
	if (!langToggle || !langDropdown) return;
	langToggle.addEventListener('click', (e) => {
		e.stopPropagation();
		langDropdown.classList.toggle('open');
	});
	document.querySelectorAll('.lang-option').forEach((option) => {
		option.addEventListener('click', () => {
			const lang = option.getAttribute('data-lang');
			if (lang === null) return;
			setLang(lang, translations, hooks);
			langDropdown.classList.remove('open');
		});
	});
	document.addEventListener('click', (e) => {
		const target = e.target;
		if (target instanceof Node && !langDropdown.contains(target) && target !== langToggle) {
			langDropdown.classList.remove('open');
		}
	});
}

/** Wire up theme + language for a page. Returns the active language. */
export function initUi(translations: TranslationTable, hooks?: UiHooks): string {
	buildLangMenu(translations);
	const lang = resolveLang(translations, getLang());
	// Persist the resolved language so later getLang() calls (e.g. in event
	// handlers) return a language this page actually supports.
	localStorage.setItem('lang', lang);
	initTheme();
	applyLang(lang, translations, hooks);
	applyTitles(lang, translations);
	initThemeToggle(translations);
	initDropdowns(translations, hooks);
	return lang;
}
