// Shared UI helpers: language switching, theme toggling and the language
// dropdown. Every tool and the home page use the same top-bar markup
// (#langToggle / #langDropdown / #themeToggle), so this logic lives here once.
//
// HOW TO ADD A NEW LANGUAGE
//   1. Add an entry to LANGUAGES below (code, flag, label, name).
//   2. Add a "<code>" object to the `translations` table of each tool/page you
//      want to translate (see `translations` in each tool's source).
//   3. Run `bun run build` to regenerate public/assets/ui.js.
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
export const FALLBACK_LANG = 'en';

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
	for (let i = 0; i < LANGUAGES.length; i++) {
		if (LANGUAGES[i].code === code) return LANGUAGES[i];
	}
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Safe storage + cached DOM refs (perf + privacy-mode resilience)      */
/* ------------------------------------------------------------------ */

function safeGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* Storage unavailable (private mode / blocked): ignore. */
	}
}

/** Cache of top-level elements by id; revalidates `isConnected`. */
const elCache = new Map<string, HTMLElement | null>();

function getEl(id: string): HTMLElement | null {
	const cached = elCache.get(id);
	if (cached !== undefined) {
		if (cached === null) {
			// May have been added to the DOM after the first miss.
			const fresh = document.getElementById(id);
			if (fresh) elCache.set(id, fresh);
			return fresh;
		}
		if (cached.isConnected) return cached;
		elCache.delete(id);
	}
	const el = document.getElementById(id);
	elCache.set(id, el);
	return el;
}

let darkMediaQuery: MediaQueryList | null = null;

/** Cached `matchMedia('(prefers-color-scheme: dark)')`. */
function prefersDark(): boolean {
	try {
		if (!darkMediaQuery) {
			darkMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		}
		return darkMediaQuery.matches;
	} catch {
		return false;
	}
}

/** Set `<span class="noto-color-emoji-regular">emoji</span>` without innerHTML. */
function setEmojiIcon(container: Element, emoji: string): void {
	// Fast path: reuse the existing span when present.
	const first = container.firstElementChild;
	if (
		first &&
		first.tagName === "SPAN" &&
		first.classList.contains("noto-color-emoji-regular") &&
		container.childNodes.length === 1
	) {
		first.textContent = emoji;
		return;
	}
	container.textContent = "";
	const span = document.createElement("span");
	span.className = "noto-color-emoji-regular";
	span.textContent = emoji;
	container.appendChild(span);
}

/** True when an i18n string carries markup and needs innerHTML. */
function hasMarkup(value: string): boolean {
	return value.indexOf("<") !== -1 && value.indexOf(">") !== -1;
}

/**
 * Set element text preserving observable output: plain strings go through
 * the fast/safe `textContent` path, strings with markup keep `innerHTML`
 * so translated `<strong>/<u>/…` still renders.
 */
function setI18nContent(el: Element, value: string): void {
	if (hasMarkup(value)) {
		el.innerHTML = value;
	} else if (el.textContent !== value) {
		el.textContent = value;
	}
}

/** The user's preferred language: saved choice -> browser -> fallback. */
export function getLang(): string {
	const saved = safeGet('lang');
	if (saved && languageByCode(saved)) return saved;
	let browser = "";
	try {
		browser = (navigator.language || navigator.languages?.[0] || '').toLowerCase();
	} catch {
		browser = "";
	}
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
	const langToggle = getEl('langToggle');
	if (!langToggle) return;
	const meta = languageByCode(lang);
	const flag = meta ? meta.flag : '';
	const label = meta ? meta.label : lang.toUpperCase();
	// Reuse existing spans when possible to avoid layout churn.
	const flagSpan = langToggle.querySelector(':scope > .noto-color-emoji-regular');
	const labelSpan = langToggle.querySelector(':scope > .label');
	if (flagSpan && labelSpan && langToggle.childNodes.length === 3) {
		if (flagSpan.textContent !== flag) flagSpan.textContent = flag;
		if (labelSpan.textContent !== label) labelSpan.textContent = label;
		return;
	}
	langToggle.textContent = '';
	const flagEl = document.createElement('span');
	flagEl.className = 'noto-color-emoji-regular';
	flagEl.textContent = flag;
	const labelEl = document.createElement('span');
	labelEl.className = 'label';
	labelEl.textContent = label;
	langToggle.append(flagEl, document.createTextNode(' '), labelEl);
}

/**
 * Build the language dropdown from LANGUAGES. Languages the current page hasn't
 * translated are shown disabled, so the switcher always reflects what the page
 * actually supports.
 */
function buildLangMenu(translations: TranslationTable): void {
	const dropdown = getEl('langDropdown');
	if (!dropdown) return;
	dropdown.textContent = '';
	const frag = document.createDocumentFragment();
	for (const meta of LANGUAGES) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'lang-option';
		btn.setAttribute('role', 'menuitem');
		btn.dataset.lang = meta.code;
		btn.title = meta.name;
		const flagEl = document.createElement('span');
		flagEl.className = 'noto-color-emoji-regular';
		flagEl.textContent = meta.flag;
		btn.append(flagEl, document.createTextNode(' ' + meta.label));
		if (!translations[meta.code]) {
			(btn as HTMLButtonElement).disabled = true;
			btn.setAttribute('aria-disabled', 'true');
		}
		frag.appendChild(btn);
	}
	dropdown.appendChild(frag);
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
		const nodes = document.querySelectorAll('[data-i18n]');
		for (let i = 0; i < nodes.length; i++) {
			const el = nodes[i] as HTMLElement;
			const key = el.getAttribute('data-i18n');
			if (!key) continue;
			const value = t[key];
			if (value === undefined) continue;
			if (el instanceof HTMLInputElement && el.type !== 'submit' && el.type !== 'button') {
				if (el.placeholder !== value) el.placeholder = value;
			} else if (el instanceof HTMLTextAreaElement) {
				if (el.placeholder !== value) el.placeholder = value;
			} else {
				setI18nContent(el, value);
			}
		}
	}
	hooks?.onApplyLang?.(lang);
}

/** Update the tooltip/aria-label of the language and theme buttons. */
export function applyTitles(lang: string, translations: TranslationTable): void {
	const t = translations[lang];
	if (!t) return;
	const langToggle = getEl('langToggle');
	if (langToggle) {
		if (langToggle.title !== t.changeLanguageTitle) langToggle.title = t.changeLanguageTitle;
		if (langToggle.getAttribute('aria-label') !== t.changeLanguageTitle) {
			langToggle.setAttribute('aria-label', t.changeLanguageTitle);
		}
	}
	const themeToggle = getEl('themeToggle');
	if (themeToggle) {
		const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
		const title = isDark ? t.switchToLightTitle : t.switchToDarkTitle;
		if (themeToggle.title !== title) themeToggle.title = title;
		if (themeToggle.getAttribute('aria-label') !== title) {
			themeToggle.setAttribute('aria-label', title);
		}
	}
}

export function setLang(lang: string, translations: TranslationTable, hooks?: UiHooks): void {
	safeSet('lang', lang);
	applyLang(lang, translations, hooks);
	applyTitles(lang, translations);
	hooks?.onLangChange?.(lang);
}

export function initTheme(): void {
	const themeToggle = getEl('themeToggle');
	if (!themeToggle) return;
	const savedTheme = safeGet('theme');
	if (savedTheme === 'dark') {
		document.documentElement.setAttribute('data-theme', 'dark');
		setEmojiIcon(themeToggle, '🌙');
	} else if (savedTheme === 'light') {
		document.documentElement.removeAttribute('data-theme');
		setEmojiIcon(themeToggle, '☀️');
	} else if (prefersDark()) {
		document.documentElement.setAttribute('data-theme', 'dark');
		setEmojiIcon(themeToggle, '🌙');
		safeSet('theme', 'dark');
	} else {
		document.documentElement.removeAttribute('data-theme');
		setEmojiIcon(themeToggle, '☀️');
		safeSet('theme', 'light');
	}
}

const THEME_BOUND = 'data-ui-theme-bound';

export function initThemeToggle(translations: TranslationTable): void {
	const themeToggle = getEl('themeToggle');
	if (!themeToggle) return;
	if (themeToggle.hasAttribute(THEME_BOUND)) return;
	themeToggle.setAttribute(THEME_BOUND, '1');
	themeToggle.addEventListener('click', () => {
		const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
		if (isDark) {
			document.documentElement.removeAttribute('data-theme');
			safeSet('theme', 'light');
			setEmojiIcon(themeToggle, '☀️');
		} else {
			document.documentElement.setAttribute('data-theme', 'dark');
			safeSet('theme', 'dark');
			setEmojiIcon(themeToggle, '🌙');
		}
		applyTitles(resolveLang(translations, getLang()), translations);
	});
}

/* Single delegated document listener for the language dropdown. */
let dropdownDelegated = false;
let dropdownState: { translations: TranslationTable; hooks?: UiHooks } | null = null;

function ensureDropdownDelegation(): void {
	if (dropdownDelegated) return;
	dropdownDelegated = true;
	document.addEventListener('click', (e) => {
		const state = dropdownState;
		if (!state) return;
		const langDropdown = getEl('langDropdown');
		const langToggle = getEl('langToggle');
		if (!langDropdown || !langToggle) return;
		const target = e.target as Element | null;
		if (!target) return;
		const option = (target as HTMLElement).closest
			? (target as HTMLElement).closest('.lang-option')
			: null;
		if (option && langDropdown.contains(option)) {
			const lang = option.getAttribute('data-lang');
			if (lang !== null && state.translations[lang]) {
				setLang(lang, state.translations, state.hooks);
			}
			langDropdown.classList.remove('open');
			return;
		}
		if (target === langToggle || (target instanceof Node && langToggle.contains(target))) {
			langDropdown.classList.toggle('open');
			return;
		}
		if (!langDropdown.contains(target as Node)) {
			langDropdown.classList.remove('open');
		}
	});
}

export function initDropdowns(translations: TranslationTable, hooks?: UiHooks): void {
	const langToggle = getEl('langToggle');
	const langDropdown = getEl('langDropdown');
	if (!langToggle || !langDropdown) return;
	// Latest table/hooks win; the single document listener reads them.
	dropdownState = { translations, hooks };
	ensureDropdownDelegation();
}

/** Wire up theme + language for a page. Returns the active language. */
export function initUi(translations: TranslationTable, hooks?: UiHooks): string {
	buildLangMenu(translations);
	const lang = resolveLang(translations, getLang());
	// Persist the resolved language so later getLang() calls (e.g. in event
	// handlers) return a language this page actually supports.
	safeSet('lang', lang);
	initTheme();
	applyLang(lang, translations, hooks);
	applyTitles(lang, translations);
	initThemeToggle(translations);
	initDropdowns(translations, hooks);
	return lang;
}
