// Addon Editor — create and edit Minecraft Bedrock Behavior/Resource Packs.
//
// The whole project lives in memory as a flat `path -> bytes` map (see pack.ts)
// plus a set of still-empty folders the user created explicitly. The UI has two
// screens: a landing (create a pack from a template, or open a .mcpack/.mcaddon/
// .zip) and an editor (file tree + breadcrumb on the left, a Monaco editor on
// the right, with file/folder operations and a final download).

import { initUi } from '../../shared/ui';
import { decodeUtf8Sig, encodeUtf8 } from '../../shared/encoding';
import { translations } from './translations';
import { buildTemplate, type TemplateKind } from './templates';
import { QUICK_TEMPLATES, buildQuickTemplate, type QuickTemplate, docsUrlForPath } from './quick-templates';
import { loadMonaco, languageForPath, isBinary } from './monaco';
import {
	type FileMap,
	unzipPack,
	zipPack,
	joinPath,
	dirOf,
	baseName,
	listDir,
	manifestName,
	downloadName,
} from './pack';
import { saveProject, loadProject, clearProject, type ProjectSnapshot } from './storage';

// ---- State ----

let currentLang = 'es';
let loaded = false;
let files: FileMap = {};
let explicitFolders = new Set<string>();
let currentDir = '';
let openPath: string | null = null;
let projectName = '';
let pendingName = '';
let dirty = false;
let currentText = '';
let editor: any = null;
let editorKind: 'monaco' | 'textarea' | null = null;
let monacoRef: any = null;
let editorToken = 0;
let treeRegistry: Array<{ action: string; path: string }> = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const MAX_BYTES = 100 * 1024 * 1024;

// ---- Small helpers ----

function t() {
	return translations[currentLang];
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatSize(n: number): string {
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function register(action: string, path: string): number {
	treeRegistry.push({ action, path });
	return treeRegistry.length - 1;
}

// ---- Inline dialogs (replaces prompt/confirm/alert, which are blocked in
// embedded contexts and are a poor fit for the rest of the UI) ----

interface ModalOptions {
	title: string;
	message?: string;
	input?: boolean;
	value?: string;
	placeholder?: string;
	confirmLabel: string;
	cancelLabel?: string;
	danger?: boolean;
}

interface ModalResult {
	confirmed: boolean;
	value: string;
}

function showModal(opts: ModalOptions): Promise<ModalResult> {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'ae-modal-overlay';
		overlay.innerHTML = `
			<div class="ae-modal" role="dialog" aria-modal="true">
				<div class="ae-modal-title">${escapeHtml(opts.title)}</div>
				${opts.message ? `<div class="ae-modal-message">${escapeHtml(opts.message)}</div>` : ''}
				${opts.input ? `<input type="text" class="text-input ae-modal-input" value="${escapeHtml(opts.value ?? '')}" placeholder="${escapeHtml(opts.placeholder ?? '')}" spellcheck="false" autocomplete="off">` : ''}
				<div class="ae-modal-actions">
					<button type="button" class="btn btn-ghost ae-modal-cancel">${escapeHtml(opts.cancelLabel ?? t().cancel)}</button>
					<button type="button" class="btn ${opts.danger ? 'ae-modal-danger' : 'btn-primary'} ae-modal-confirm">${escapeHtml(opts.confirmLabel)}</button>
				</div>
			</div>
		`;
		document.body.appendChild(overlay);

		const input = overlay.querySelector<HTMLInputElement>('.ae-modal-input');
		const confirmBtn = overlay.querySelector<HTMLButtonElement>('.ae-modal-confirm')!;
		const cancelBtn = overlay.querySelector<HTMLButtonElement>('.ae-modal-cancel')!;

		const close = (confirmed: boolean) => {
			const value = input ? input.value : '';
			overlay.remove();
			resolve({ confirmed, value });
		};

		confirmBtn.addEventListener('click', () => close(true));
		cancelBtn.addEventListener('click', () => close(false));
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) close(false);
		});
		overlay.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') close(false);
		});
		input?.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') close(true);
		});
		input?.focus();
		input?.select();
	});
}

function showToast(message: string, kind: 'error' | 'info' = 'error') {
	const toast = document.createElement('div');
	toast.className = 'ae-toast ' + (kind === 'error' ? 'ae-toast-error' : 'ae-toast-info');
	toast.textContent = message;
	document.body.appendChild(toast);
	setTimeout(() => toast.remove(), 4000);
}

// ---- Persistence (IndexedDB) ----

function snapshot(): ProjectSnapshot {
	return {
		files,
		explicitFolders: [...explicitFolders],
		projectName,
		currentDir,
		openPath,
		dirty,
		currentText,
	};
}

/** Save right away (used for structural changes: create/rename/delete/upload/save). */
function persistNow() {
	if (!loaded) return;
	void saveProject(snapshot());
}

/** Debounced save (used while typing or navigating). */
function schedulePersist() {
	if (!loaded) return;
	if (saveTimer !== undefined) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = undefined;
		persistNow();
	}, 400);
}

// ---- Rendering ----

function renderApp() {
	const app = document.getElementById('app');
	if (!app) return;
	app.innerHTML = loaded ? editorShellHtml() : landingHtml();
	if (loaded) {
		wireEditorShell();
		renderTree();
		renderFileHead();
		void remountEditor();
	} else {
		wireLanding();
	}
}

function landingHtml(): string {
	const l = t();
	return `
		<h1>${escapeHtml(l.heading)}</h1>
		<p class="subtitle">${l.description}</p>
		<div class="ae-landing-grid">
			<div class="card ae-card">
				<h2>${escapeHtml(l.createTitle)}</h2>
				<p class="hint">${escapeHtml(l.createHint)}</p>
				<label class="editor-label">${escapeHtml(l.packNameLabel)}</label>
				<input type="text" id="aeName" class="text-input" value="${escapeHtml(pendingName)}" placeholder="${escapeHtml(l.packNamePh)}" spellcheck="false" autocomplete="off">
				<div class="ae-create-btns">
					<button type="button" class="btn ae-create" data-kind="behavior">
						<span class="ae-create-title">${escapeHtml(l.createBehavior)}</span>
						<span class="ae-create-desc">${escapeHtml(l.createBehaviorDesc)}</span>
					</button>
					<button type="button" class="btn ae-create" data-kind="resource">
						<span class="ae-create-title">${escapeHtml(l.createResource)}</span>
						<span class="ae-create-desc">${escapeHtml(l.createResourceDesc)}</span>
					</button>
					<button type="button" class="btn ae-create" data-kind="addon">
						<span class="ae-create-title">${escapeHtml(l.createAddon)}</span>
						<span class="ae-create-desc">${escapeHtml(l.createAddonDesc)}</span>
					</button>
				</div>
			</div>
			<div class="card ae-card">
				<h2>${escapeHtml(l.openTitle)}</h2>
				<p class="hint">${l.openHint}</p>
				<div class="drop-zone" id="aeDropZone" role="button" tabindex="0" aria-label="${escapeHtml(l.openTitle)}">
					<div class="drop-prompt">
						<span class="drop-icon">📦</span>
						<p class="drop-main">${l.dropPrompt}</p>
						<p class="drop-sub">${escapeHtml(l.dropSub)}</p>
					</div>
				</div>
				<input type="file" id="aePackInput" accept=".mcpack,.mcaddon,.zip" style="display:none">
			</div>
		</div>
		<p class="hint ae-note">${escapeHtml(l.refreshNote)}</p>
	`;
}

function editorShellHtml(): string {
	const l = t();
	return `
		<div class="ae-shell">
			<div class="ae-topbar">
				<div class="ae-title">
					<span class="ae-title-icon">🧩</span>
					<span class="ae-title-name" title="${escapeHtml(projectName)}">${escapeHtml(projectName)}</span>
				</div>
				<div class="ae-actions">
					<button type="button" class="btn btn-ghost" id="aeNewFile">${escapeHtml(l.newFile)}</button>
					<button type="button" class="btn btn-ghost" id="aeNewFolder">${escapeHtml(l.newFolder)}</button>
					<button type="button" class="btn btn-ghost" id="aeQuickAdd">${escapeHtml(l.quickAdd)}</button>
					<button type="button" class="btn btn-ghost" id="aeUploadFiles">${escapeHtml(l.uploadFiles)}</button>
					<button type="button" class="btn btn-primary" id="aeDownload">${escapeHtml(l.download)}</button>
					<button type="button" class="btn btn-ghost" id="aeStartOver" title="${escapeHtml(l.startOver)}">↺</button>
				</div>
			</div>
			<p class="hint ae-note">${escapeHtml(l.refreshNote)}</p>
			<div class="ae-layout">
				<aside class="ae-sidebar">
					<div class="ae-breadcrumb" id="aeBreadcrumb"></div>
					<div class="ae-tree" id="aeTree"></div>
				</aside>
				<section class="ae-main">
					<div class="ae-filehead" id="aeFileHead"></div>
					<div class="ae-editor" id="aeEditorMount"></div>
				</section>
			</div>
		</div>
		<input type="file" id="aeFileInput" multiple style="display:none">
	`;
}

function renderTree() {
	const tree = document.getElementById('aeTree');
	const bc = document.getElementById('aeBreadcrumb');
	if (!tree || !bc) return;
	treeRegistry = [];

	bc.innerHTML = buildBreadcrumb();

	const { folders, files: fileNames } = listDir(files, explicitFolders, currentDir);
	const rows: string[] = [];

	if (currentDir !== '') {
		rows.push(
			`<div class="ae-row ae-row-up"><button type="button" class="ae-entry" data-ae-act="${register('navUp', '')}">⬅️ ${escapeHtml(t().upFolder)}</button></div>`
		);
	}

	for (const name of folders) {
		const path = joinPath(currentDir, name) + '/';
		rows.push(
			`<div class="ae-row ae-row-folder"><button type="button" class="ae-entry" data-ae-act="${register('openFolder', path)}">📁 ${escapeHtml(name)}</button>
				<div class="ae-row-actions">
					<button type="button" class="ae-mini" title="${escapeHtml(t().rename)}" data-ae-act="${register('renameFolder', path)}">✏️</button>
					<button type="button" class="ae-mini" title="${escapeHtml(t().delete)}" data-ae-act="${register('deleteFolder', path)}">🗑️</button>
				</div>
			</div>`
		);
	}

	for (const name of fileNames) {
		const path = joinPath(currentDir, name);
		const active = path === openPath ? ' ae-active' : '';
		const icon = isBinary(path, files[path]) ? '🖼️' : '📄';
		rows.push(
			`<div class="ae-row ae-row-file${active}"><button type="button" class="ae-entry" data-ae-act="${register('openFile', path)}">${icon} ${escapeHtml(name)}</button>
				<div class="ae-row-actions">
					<button type="button" class="ae-mini" title="${escapeHtml(t().rename)}" data-ae-act="${register('renameFile', path)}">✏️</button>
					<button type="button" class="ae-mini" title="${escapeHtml(t().delete)}" data-ae-act="${register('deleteFile', path)}">🗑️</button>
				</div>
			</div>`
		);
	}

	if (rows.length === 0) rows.push(`<div class="ae-empty">${escapeHtml(t().emptyDir)}</div>`);
	tree.innerHTML = rows.join('');

	wireTree(bc);
}

function buildBreadcrumb(): string {
	const parts = currentDir ? currentDir.slice(0, -1).split('/') : [];
	let acc = '';
	let html = `<button type="button" class="ae-crumb" data-ae-nav="${register('navTo', '')}" title="${escapeHtml(t().rootLabel)}">🏠</button>`;
	for (const p of parts) {
		acc = acc ? acc + '/' + p : p;
		html += `<span class="ae-crumb-sep">/</span><button type="button" class="ae-crumb" data-ae-nav="${register('navTo', acc + '/')}">${escapeHtml(p)}</button>`;
	}
	return html;
}

function renderFileHead() {
	const el = document.getElementById('aeFileHead');
	if (!el) return;
	if (!openPath) {
		el.innerHTML = `<div class="ae-filehead-empty">${escapeHtml(t().noFileOpen)}</div>`;
		return;
	}
	const data = files[openPath];
	const bin = isBinary(openPath, data);
	const docsUrl = docsUrlForPath(openPath);
	el.innerHTML = `
		<div class="ae-filehead-left">
			<div class="ae-filehead-path" title="${escapeHtml(openPath)}">${bin ? '🖼️' : '📄'} ${escapeHtml(openPath)}</div>
			<div class="ae-filehead-meta">${escapeHtml(formatSize(data.length))}${bin ? ' · ' + escapeHtml(t().binary) : ''}</div>
		</div>
		<span class="ae-status" id="aeStatus"></span>
		<div class="ae-filehead-actions">
			${bin ? '' : `<button type="button" class="btn btn-primary ae-save" id="aeSave">${escapeHtml(t().save)}</button>`}
			<button type="button" class="btn btn-ghost ae-mini-btn" id="aeRename" title="${escapeHtml(t().rename)}">✏️</button>
			<button type="button" class="btn btn-ghost ae-mini-btn" id="aeDelete" title="${escapeHtml(t().delete)}">🗑️</button>
			${docsUrl ? `<button type="button" class="btn btn-ghost ae-mini-btn ae-docs-btn" id="aeDocs" title="${escapeHtml(t().docsHelpTitle)}">📖</button>` : ''}
		</div>
	`;
	wireFileHead();
	updateStatus();
}

function updateStatus() {
	const el = document.getElementById('aeStatus');
	if (!el) return;
	if (!openPath || isBinary(openPath, files[openPath])) {
		el.textContent = openPath ? t().binary : '';
		el.className = 'ae-status';
		return;
	}
	el.textContent = dirty ? t().unsaved : t().saved;
	el.className = 'ae-status ' + (dirty ? 'ae-dirty' : 'ae-saved');
}

// ---- Event wiring ----

function wireLanding() {
	const nameInput = document.getElementById('aeName') as HTMLInputElement | null;
	nameInput?.addEventListener('input', () => {
		pendingName = nameInput.value;
	});

	document.querySelectorAll<HTMLElement>('[data-kind]').forEach((btn) => {
		btn.addEventListener('click', () => createPack(btn.getAttribute('data-kind') as TemplateKind));
	});

	const dropZone = document.getElementById('aeDropZone');
	const packInput = document.getElementById('aePackInput') as HTMLInputElement | null;
	if (dropZone && packInput) {
		dropZone.addEventListener('click', () => packInput.click());
		dropZone.addEventListener('dragover', (e) => {
			e.preventDefault();
			dropZone.classList.add('dragover');
		});
		dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
		dropZone.addEventListener('drop', (e) => {
			e.preventDefault();
			dropZone.classList.remove('dragover');
			const f = e.dataTransfer?.files?.[0];
			if (f) void openUploadedPack(f);
		});
		packInput.addEventListener('change', () => {
			const f = packInput.files?.[0];
			if (f) void openUploadedPack(f);
		});
	}
}

function wireEditorShell() {
	document.getElementById('aeNewFile')?.addEventListener('click', newFile);
	document.getElementById('aeNewFolder')?.addEventListener('click', newFolder);
	document.getElementById('aeQuickAdd')?.addEventListener('click', showQuickAdd);
	document.getElementById('aeUploadFiles')?.addEventListener('click', () => {
		document.getElementById('aeFileInput')?.click();
	});
	document.getElementById('aeDownload')?.addEventListener('click', download);
	document.getElementById('aeStartOver')?.addEventListener('click', startOver);

	const fileInput = document.getElementById('aeFileInput') as HTMLInputElement | null;
	fileInput?.addEventListener('change', () => {
		if (fileInput.files?.length) void uploadFiles(fileInput.files);
		fileInput.value = '';
	});
}

function wireTree(bc: HTMLElement) {
	bc.querySelectorAll<HTMLElement>('[data-ae-nav]').forEach((el) => {
		el.addEventListener('click', () => {
			const rec = treeRegistry[Number(el.getAttribute('data-ae-nav'))];
			if (!rec) return;
			currentDir = rec.path;
			renderTree();
			schedulePersist();
		});
	});

	const tree = document.getElementById('aeTree');
	if (!tree) return;
	tree.querySelectorAll<HTMLElement>('[data-ae-act]').forEach((el) => {
		el.addEventListener('click', () => {
			const rec = treeRegistry[Number(el.getAttribute('data-ae-act'))];
			if (rec) handleTreeAction(rec.action, rec.path);
		});
	});
}

function wireFileHead() {
	document.getElementById('aeSave')?.addEventListener('click', saveFile);
	document.getElementById('aeRename')?.addEventListener('click', () => {
		if (openPath) renameFile(openPath);
	});
	document.getElementById('aeDelete')?.addEventListener('click', () => {
		if (openPath) deleteFile(openPath);
	});
	document.getElementById('aeDocs')?.addEventListener('click', () => {
		if (openPath) {
			const url = docsUrlForPath(openPath);
			if (url) window.open(url, '_blank', 'noopener');
		}
	});
}

function handleTreeAction(action: string, path: string) {
	switch (action) {
		case 'openFolder':
			currentDir = path;
			renderTree();
			schedulePersist();
			break;
		case 'navUp':
			currentDir = dirOf(currentDir.slice(0, -1));
			renderTree();
			schedulePersist();
			break;
		case 'openFile':
			openFile(path);
			break;
		case 'renameFile':
			renameFile(path);
			break;
		case 'deleteFile':
			deleteFile(path);
			break;
		case 'renameFolder':
			renameFolder(path);
			break;
		case 'deleteFolder':
			deleteFolder(path);
			break;
	}
}

// ---- Editor management ----

function destroyEditor() {
	if (editor && editorKind === 'monaco' && typeof editor.dispose === 'function') {
		editor.dispose();
	}
	editor = null;
	editorKind = null;
}

function getEditorValue(): string {
	if (editorKind === 'monaco' && editor) return editor.getValue();
	if (editorKind === 'textarea' && editor) return (editor as HTMLTextAreaElement).value;
	return currentText;
}

async function createEditor(mount: HTMLElement, path: string, text: string, token: number) {
	try {
		const monaco = await loadMonaco();
		if (token !== editorToken) return;
		monacoRef = monaco;
		const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs';
		editorKind = 'monaco';
		editor = monaco.editor.create(mount, {
			value: text,
			language: languageForPath(path),
			theme,
			automaticLayout: true,
			fontSize: 14,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			tabSize: 2,
			wordWrap: 'on',
		});
		editor.onDidChangeModelContent(() => {
			currentText = editor.getValue();
			dirty = true;
			updateStatus();
			schedulePersist();
		});
		editor.focus();
	} catch (err) {
		if (token !== editorToken) return;
		console.error('Monaco failed to load, using textarea fallback:', err);
		mount.innerHTML = `<textarea id="aeFallback" spellcheck="false" autocapitalize="off"></textarea>`;
		const ta = mount.querySelector('#aeFallback') as HTMLTextAreaElement;
		ta.value = text;
		ta.addEventListener('input', () => {
			currentText = ta.value;
			dirty = true;
			updateStatus();
			schedulePersist();
		});
		editorKind = 'textarea';
		editor = ta;
	}
}

async function remountEditor() {
	const token = ++editorToken;
	const mount = document.getElementById('aeEditorMount');
	if (!mount) return;

	if (!openPath) {
		destroyEditor();
		mount.innerHTML = `<div class="ae-editor-empty">${escapeHtml(t().selectFileHint)}</div>`;
		return;
	}

	const data = files[openPath];
	if (!data) {
		openPath = null;
		dirty = false;
		currentText = '';
		mount.innerHTML = `<div class="ae-editor-empty">${escapeHtml(t().selectFileHint)}</div>`;
		return;
	}
	if (isBinary(openPath, data)) {
		destroyEditor();
		mount.innerHTML = `<div class="ae-editor-empty">🖼️ ${escapeHtml(t().binaryHint)}<br><span class="ae-muted">${escapeHtml(formatSize(data.length))}</span></div>`;
		return;
	}

	destroyEditor();
	mount.innerHTML = '';
	const text = dirty ? currentText : decodeUtf8Sig(data);
	currentText = text;
	await createEditor(mount, openPath, text, token);
}

// ---- Quick-add modal ----

function showQuickAdd() {
	const l = t();
	const categories = [
		{ key: 'behavior' as const, label: l.quickAddCategoryBP },
		{ key: 'resource' as const, label: l.quickAddCategoryRP },
		{ key: 'other' as const, label: l.quickAddCategoryOther },
	];

	let selected: QuickTemplate | null = null;

	function renderTemplateList(filter: string) {
		const list = document.getElementById('aeQuickList');
		if (!list) return;
		const q = filter.toLowerCase();
		const filtered = QUICK_TEMPLATES.filter(
			(t) =>
				t.label.toLowerCase().includes(q) ||
				t.description.toLowerCase().includes(q) ||
				t.filename.toLowerCase().includes(q)
		);

		if (filtered.length === 0) {
			list.innerHTML = `<div class="ae-quick-empty">${escapeHtml(l.quickAddNoMatch)}</div>`;
			return;
		}

		let html = '';
		for (const cat of categories) {
			const items = filtered.filter((t) => t.category === cat.key);
			if (items.length === 0) continue;
			html += `<div class="ae-quick-cat">${escapeHtml(cat.label)}</div>`;
			for (const t of items) {
				const active = selected === t ? ' ae-quick-selected' : '';
				html += `
					<button type="button" class="ae-quick-item${active}" data-ae-tmpl="${QUICK_TEMPLATES.indexOf(t)}">
						<span class="ae-quick-label">${escapeHtml(t.label)}</span>
						<span class="ae-quick-desc">${escapeHtml(t.description)}</span>
						<span class="ae-quick-path">${escapeHtml(t.filename)}</span>
					</button>`;
			}
		}
		list.innerHTML = html;

		list.querySelectorAll<HTMLElement>('[data-ae-tmpl]').forEach((btn) => {
			btn.addEventListener('click', () => {
				const idx = Number(btn.getAttribute('data-ae-tmpl'));
				selected = QUICK_TEMPLATES[idx];
				renderTemplateList(filter);
			});
		});
	}

	const overlay = document.createElement('div');
	overlay.className = 'ae-modal-overlay';
	overlay.innerHTML = `
		<div class="ae-modal ae-quick-modal" role="dialog" aria-modal="true">
			<div class="ae-modal-title">${escapeHtml(l.quickAddHeading)}</div>
			<div class="ae-modal-message">${escapeHtml(l.quickAddHint)}</div>
			<div class="ae-quick-search-wrap">
				<input type="text" class="text-input ae-quick-search" id="aeQuickSearch" placeholder="${escapeHtml(l.quickAddSearch)}" spellcheck="false" autocomplete="off">
			</div>
			<div class="ae-quick-list" id="aeQuickList"></div>
			<label class="editor-label">${escapeHtml(l.quickAddNameLabel)}</label>
			<input type="text" class="text-input" id="aeQuickName" value="" placeholder="${escapeHtml(l.quickAddNamePh)}" spellcheck="false" autocomplete="off">
			<div class="ae-modal-actions">
				<button type="button" class="btn btn-ghost ae-modal-cancel">${escapeHtml(l.cancel)}</button>
				<button type="button" class="btn btn-primary ae-modal-confirm">${escapeHtml(l.create)}</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const confirmBtn = overlay.querySelector<HTMLButtonElement>('.ae-modal-confirm')!;
	const cancelBtn = overlay.querySelector<HTMLButtonElement>('.ae-modal-cancel')!;
	const nameInput = overlay.querySelector<HTMLInputElement>('#aeQuickName')!;
	const searchInput = overlay.querySelector<HTMLInputElement>('#aeQuickSearch')!;

	renderTemplateList('');

	const close = (confirmed: boolean) => {
		overlay.remove();
		if (!confirmed || !selected) return;
		const name = nameInput.value.trim() || 'custom';
		const result = buildQuickTemplate(selected, name);
		for (const [relPath, data] of Object.entries(result)) {
			const path = joinPath(currentDir, relPath);
			if (files[path] !== undefined) {
				showToast(t().exists.replace('{name}', relPath));
				return;
			}
			// Ensure parent folders
			let parent = dirOf(path);
			while (parent) {
				if (!explicitFolders.has(parent) && !Object.keys(files).some((p) => p.startsWith(parent))) {
					explicitFolders.add(parent);
				}
				if (parent === '') break;
				parent = dirOf(parent.slice(0, -1));
			}
			files[path] = data;
		}
		persistNow();
		renderTree();
		// Open the first generated file
		const firstPath = joinPath(currentDir, Object.keys(result)[0]);
		if (files[firstPath] !== undefined) openFile(firstPath);
	};

	confirmBtn.addEventListener('click', () => close(true));
	cancelBtn.addEventListener('click', () => close(false));
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close(false);
	});
	overlay.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') close(false);
	});
	nameInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') close(true);
	});

	searchInput.addEventListener('input', () => {
		renderTemplateList(searchInput.value);
	});

	searchInput.focus();
}

// ---- File operations ----

async function openFile(path: string) {
	if (files[path] === undefined) return;
	if (dirty && openPath && openPath !== path) {
		const res = await showModal({ title: t().unsavedTitle, message: t().unsavedConfirm, confirmLabel: t().discard, danger: true });
		if (!res.confirmed) return;
	}
	openPath = path;
	dirty = false;
	currentText = '';
	renderTree();
	renderFileHead();
	void remountEditor();
	schedulePersist();
}

function saveFile() {
	if (!openPath) return;
	if (isBinary(openPath, files[openPath])) return;
	files[openPath] = encodeUtf8(getEditorValue());
	dirty = false;
	updateStatus();
	persistNow();
}

async function newFile() {
	const res = await showModal({ title: t().newFile, input: true, value: '', placeholder: t().newFileName, confirmLabel: t().create });
	if (!res.confirmed) return;
	const name = res.value.trim();
	if (!name) return;
	const path = joinPath(currentDir, name);
	if (files[path] !== undefined || explicitFolders.has(path + '/')) {
		showToast(t().exists);
		return;
	}
	files[path] = encodeUtf8('');
	persistNow();
	renderTree();
	openFile(path);
}

async function newFolder() {
	const res = await showModal({ title: t().newFolder, input: true, value: '', placeholder: t().newFolderName, confirmLabel: t().create });
	if (!res.confirmed) return;
	const name = res.value.trim().replace(/\/+$/g, '');
	if (!name) return;
	const path = joinPath(currentDir, name) + '/';
	if (explicitFolders.has(path) || Object.keys(files).some((p) => p.startsWith(path))) {
		showToast(t().exists);
		return;
	}
	explicitFolders.add(path);
	persistNow();
	renderTree();
}

async function uploadFiles(list: FileList | File[]) {
	const arr = Array.from(list);
	if (arr.length === 0) return;
	for (const f of arr) {
		if (f.size > MAX_BYTES) {
			showToast(t().fileTooLarge);
			continue;
		}
		const buf = await f.arrayBuffer();
		const data = new Uint8Array(buf);
		const path = joinPath(currentDir, f.name);
		if (files[path] !== undefined) {
			const res = await showModal({ title: t().uploadFiles, message: t().overwriteConfirm.replace('{name}', f.name), confirmLabel: t().overwrite });
			if (!res.confirmed) continue;
		}
		files[path] = data;
	}
	persistNow();
	renderTree();
}

async function renameFile(path: string) {
	const cur = baseName(path);
	const res = await showModal({ title: t().rename, input: true, value: cur, placeholder: t().renamePrompt, confirmLabel: t().ok });
	if (!res.confirmed) return;
	const next = res.value.trim();
	if (!next || next === cur) return;
	const newPath = joinPath(dirOf(path), next);
	if (newPath === path) return;
	if (files[newPath] !== undefined || explicitFolders.has(newPath + '/')) {
		showToast(t().exists);
		return;
	}
	const data = files[path];
	delete files[path];
	files[newPath] = data;
	if (openPath === path) openPath = newPath;
	persistNow();
	renderTree();
	renderFileHead();
}

async function deleteFile(path: string) {
	const res = await showModal({ title: t().delete, message: t().deleteConfirm.replace('{name}', baseName(path)), confirmLabel: t().delete, danger: true });
	if (!res.confirmed) return;
	delete files[path];
	if (openPath === path) {
		openPath = null;
		dirty = false;
		currentText = '';
	}
	persistNow();
	renderTree();
	renderFileHead();
	void remountEditor();
}

async function renameFolder(path: string) {
	const cur = baseName(path);
	const res = await showModal({ title: t().rename, input: true, value: cur, placeholder: t().renamePrompt, confirmLabel: t().ok });
	if (!res.confirmed) return;
	const next = res.value.trim().replace(/\/+$/g, '');
	if (!next || next === cur) return;

	const parent = dirOf(path.slice(0, -1));
	const newPath = parent + next + '/';
	if (newPath === path) return;

	if (
		Object.keys(files).some((p) => p.startsWith(newPath)) ||
		[...explicitFolders].some((f) => f === newPath || f.startsWith(newPath))
	) {
		showToast(t().exists);
		return;
	}

	const prefix = path;
	const newFiles: FileMap = {};
	for (const p of Object.keys(files)) {
		if (p.startsWith(prefix)) newFiles[newPath + p.slice(prefix.length)] = files[p];
		else newFiles[p] = files[p];
	}
	files = newFiles;

	const newFolders = new Set<string>();
	for (const f of explicitFolders) {
		if (f === path || f.startsWith(prefix)) {
			newFolders.add(f === path ? newPath : newPath + f.slice(prefix.length));
		} else {
			newFolders.add(f);
		}
	}
	explicitFolders = newFolders;

	if (openPath && openPath.startsWith(prefix)) openPath = newPath + openPath.slice(prefix.length);
	if (currentDir === path || currentDir.startsWith(prefix)) {
		currentDir = newPath + (currentDir === path ? '' : currentDir.slice(prefix.length));
	}
	persistNow();
	renderTree();
	renderFileHead();
}

async function deleteFolder(path: string) {
	const res = await showModal({ title: t().delete, message: t().deleteFolderConfirm.replace('{name}', baseName(path)), confirmLabel: t().delete, danger: true });
	if (!res.confirmed) return;
	for (const p of Object.keys(files)) {
		if (p.startsWith(path)) delete files[p];
	}
	const newFolders = new Set<string>();
	for (const f of explicitFolders) {
		if (f !== path && !f.startsWith(path)) newFolders.add(f);
	}
	explicitFolders = newFolders;

	if (openPath && openPath.startsWith(path)) {
		openPath = null;
		dirty = false;
		currentText = '';
	}
	if (currentDir === path || currentDir.startsWith(path)) {
		currentDir = dirOf(path.slice(0, -1));
	}
	persistNow();
	renderTree();
	renderFileHead();
	void remountEditor();
}

function download() {
	if (openPath && dirty) saveFile();
	// Copy into a fresh buffer so the typed array satisfies the BlobPart type.
	const zip = zipPack(files);
	const copy = new Uint8Array(zip.byteLength);
	copy.set(zip);
	const blob = new Blob([copy], { type: 'application/zip' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = downloadName(files);
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---- Project lifecycle ----

function resetProjectState() {
	files = {};
	explicitFolders = new Set();
	currentDir = '';
	openPath = null;
	projectName = '';
	currentText = '';
	dirty = false;
	destroyEditor();
	editorToken++;
}

function createPack(kind: TemplateKind) {
	const name = pendingName.trim() || 'My Pack';
	resetProjectState();
	files = buildTemplate(kind, name);
	loaded = true;
	projectName = manifestName(files) || name;
	renderApp();
	persistNow();
}

async function openUploadedPack(file: File) {
	if (file.size > MAX_BYTES) {
		showToast(t().fileTooLarge);
		return;
	}
	try {
		const buf = await file.arrayBuffer();
		const parsed = unzipPack(new Uint8Array(buf));
		if (Object.keys(parsed).length === 0) {
			showToast(t().emptyZip);
			return;
		}
		resetProjectState();
		files = parsed;
		loaded = true;
		projectName = manifestName(files) || file.name.replace(/\.[^.]+$/, '');
		renderApp();
		persistNow();
	} catch (err) {
		console.error('Failed to open pack:', err);
		showToast(t().invalidZip);
	}
}

async function startOver() {
	if (dirty) {
		const res = await showModal({ title: t().unsavedTitle, message: t().unsavedConfirm, confirmLabel: t().discard, danger: true });
		if (!res.confirmed) return;
	}
	loaded = false;
	resetProjectState();
	void clearProject();
	renderApp();
}

// ---- Bootstrap ----

const uiHooks = {
	onLangChange: (lang: string) => {
		currentLang = lang;
		renderApp();
	},
};

export function init() {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initTool);
	} else {
		initTool();
	}
}

async function initTool() {
	currentLang = initUi(translations, uiHooks);

	// Restore the last project so a refresh picks up where the user left off.
	const saved = await loadProject();
	if (saved && Object.keys(saved.files).length > 0) {
		files = saved.files;
		explicitFolders = new Set(saved.explicitFolders);
		projectName = saved.projectName || '';
		currentDir = saved.currentDir || '';
		openPath = saved.openPath;
		dirty = saved.dirty;
		currentText = saved.currentText;
		loaded = true;
	}

	renderApp();

	window.addEventListener('keydown', (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			saveFile();
		}
	});

	window.addEventListener('beforeunload', (e) => {
		if (!dirty) return;
		e.preventDefault();
		(e as BeforeUnloadEvent).returnValue = '';
	});

	// Best-effort flush when the tab is hidden or unloaded, so the last few
	// debounced keystrokes are not lost.
	window.addEventListener('pagehide', () => persistNow());
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') persistNow();
	});

	new MutationObserver(() => {
		if (editorKind === 'monaco' && monacoRef) {
			monacoRef.editor.setTheme(
				document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs'
			);
		}
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
