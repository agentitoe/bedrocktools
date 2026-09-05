// Monaco editor integration for the Addon Editor.
//
// Monaco is loaded lazily from a CDN (the page includes the tiny AMD loader in
// its <head>). `loadMonaco` resolves once the full editor is ready; if the CDN
// is unreachable it rejects and the caller falls back to a plain <textarea>.
// The module also owns language detection and binary-vs-text classification.

const MONACO_VERSION = "0.52.2";
const MONACO_VS = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;
const MONACO_ORIGIN = "https://cdn.jsdelivr.net";

let monacoPromise: Promise<unknown> | null = null;
let languagesRegistered = false;

/** Minimal Monaco surface used by the editor (typed as unknown externally). */
export interface MonacoInstance {
	editor: {
		create: (mount: HTMLElement, options: Record<string, unknown>) => MonacoEditor;
		setTheme: (theme: string) => void;
	};
	languages: {
		register: (lang: { id: string }) => void;
		setMonarchTokensProvider: (id: string, provider: unknown) => void;
		setLanguageConfiguration: (id: string, config: unknown) => void;
	};
}

export interface MonacoEditor {
	getValue: () => string;
	dispose: () => void;
	onDidChangeModelContent: (cb: () => void) => void;
	focus: () => void;
}

function isMonacoInstance(v: unknown): v is MonacoInstance {
	if (!v || typeof v !== "object") return false;
	const m = v as Record<string, unknown>;
	return (
		typeof m["editor"] === "object" &&
		m["editor"] !== null &&
		typeof (m["editor"] as Record<string, unknown>)["create"] === "function" &&
		typeof m["languages"] === "object" &&
		m["languages"] !== null
	);
}

function ensurePreconnect(): void {
	try {
		if (typeof document === "undefined") return;
		const head = document.head;
		if (!head) return;
		if (head.querySelector(`link[rel="preconnect"][href="${MONACO_ORIGIN}"]`)) return;
		const link = document.createElement("link");
		link.rel = "preconnect";
		link.href = MONACO_ORIGIN;
		link.crossOrigin = "anonymous";
		head.appendChild(link);
	} catch {
		// ignore (non-DOM / test env)
	}
}

export function loadMonaco(): Promise<unknown> {
	const w = window as unknown as Record<string, unknown>;
	if (isMonacoInstance(w["monaco"])) return Promise.resolve(w["monaco"]);
	if (monacoPromise) return monacoPromise;

	ensurePreconnect();

	const p: Promise<unknown> = new Promise((resolve, reject) => {
		const req = w["require"] as
			| { config: (opts: unknown) => void; (mods: string[], ok: () => void, err: (e: unknown) => void): void }
			| undefined;
		if (typeof req !== "function") {
			reject(new Error("Monaco loader not available"));
			return;
		}
		try {
			req.config({ paths: { vs: MONACO_VS } });
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}
		req(
			["vs/editor/editor.main"],
			() => {
				const monaco = (window as unknown as Record<string, unknown>)["monaco"];
				if (!isMonacoInstance(monaco)) {
					reject(new Error("Monaco failed to load"));
					return;
				}
				try {
					registerBedrockLanguages(monaco);
				} catch {
					// non-fatal
				}
				resolve(monaco);
			},
			(err: unknown) => reject(err instanceof Error ? err : new Error(String(err)))
		);
	});

	monacoPromise = p;
	// Reset the cached promise on rejection so a later call retries.
	p.then(undefined, () => {
		if (monacoPromise === p) monacoPromise = null;
	});

	return monacoPromise;
}

function registerBedrockLanguages(monaco: MonacoInstance): void {
	if (languagesRegistered) return;
	languagesRegistered = true;

	// .mcfunction — Bedrock function files. Commands, selectors, comments.
	monaco.languages.register({ id: "mcfunction" });
	monaco.languages.setMonarchTokensProvider("mcfunction", {
		defaultToken: "",
		tokenizer: {
			root: [
				[/^#.*$/, "comment"],
				[/^\/\/.*$/, "comment"],
				[
					/\b(execute|function|say|give|setblock|fill|summon|tp|teleport|kill|clear|clone|effect|enchant|gamemode|gamerule|kick|list|locate|particle|playsound|replaceitem|scoreboard|setworldspawn|spawnpoint|spreadplayers|stopsound|tag|tell|tellraw|testfor|testforblock|testforblocks|time|title|toggledownfall|weather|xp|structure|damage|camera|inputpermission|dialogue)\b/,
					"keyword",
				],
				[/\b(if|unless|as|at|positioned|rotated|facing|align|anchored|in|store|run|result|success|block|blocks|entity|entities)\b/, "keyword.control"],
				[/@[aeprs](\[[^\]]*\])?/, "variable"],
				[/"([^"\\]|\\.)*"/, "string"],
				[/\b\d+(\.\d+)?\b/, "number"],
				[/\b(true|false)\b/, "keyword.constant"],
				[/[a-zA-Z_][a-zA-Z0-9_:.]*/, "identifier"],
				[/[+\-*/%<>!=?:&|]+/, "operator"],
			],
		},
	});
	monaco.languages.setLanguageConfiguration("mcfunction", {
		comments: { lineComment: "#" },
		brackets: [["[", "]"], ["{", "}"]],
	});

	// .molang — Bedrock expression language.
	monaco.languages.register({ id: "molang" });
	monaco.languages.setMonarchTokensProvider("molang", {
		defaultToken: "",
		tokenizer: {
			root: [
				[/\b(query|math|variable|temp|context|array|geometry|material|texture|c|q|v|t|m)\./, "type"],
				[/\b(return|if|else|loop|for_each|break|continue|this)\b/, "keyword"],
				[/\b(true|false)\b/, "keyword.constant"],
				[/\b\d+(\.\d+)?\b/, "number"],
				[/"([^"\\]|\\.)*"/, "string"],
				[/\b[a-zA-Z_][a-zA-Z0-9_.]*\b/, "identifier"],
				[/[+\-*/%<>!=?:&|]+/, "operator"],
			],
		},
	});
}

/** Extension -> Monaco language id (longest/specific first via exact ext match). */
const EXT_LANG = new Map<string, string>([
	[".mcfunction", "mcfunction"],
	[".molang", "molang"],
	[".mcmeta", "json"],
	[".json", "json"],
	[".js", "javascript"],
	[".ts", "typescript"],
	[".lang", "ini"],
	[".properties", "ini"],
	[".ini", "ini"],
	[".css", "css"],
	[".html", "html"],
	[".htm", "html"],
	[".md", "plaintext"],
	[".txt", "plaintext"],
]);

/** Map a file path to a Monaco language id. */
export function languageForPath(path: string): string {
	const lower = path.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot === -1) return "plaintext";
	const ext = lower.slice(dot);
	return EXT_LANG.get(ext) ?? "plaintext";
}

const BINARY_EXTS = new Set([
	".png", ".tga", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico",
	".ogg", ".wav", ".mp3", ".fsb", ".fnt", ".ttf", ".otf",
	".zip", ".mcpack", ".mcaddon", ".mcworld", ".bin", ".dat", ".db",
	".glb", ".nbt", ".mcstructure",
]);

const TEXT_EXTS = new Set([
	".json", ".mcmeta", ".js", ".ts", ".lang", ".properties", ".ini",
	".mcfunction", ".molang", ".css", ".html", ".htm", ".md", ".txt",
]);

/** True when a file should be treated as binary (not editable as text). */
export function isBinary(path: string, data: Uint8Array): boolean {
	const dot = path.lastIndexOf(".");
	const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
	if (BINARY_EXTS.has(ext)) return true;
	if (TEXT_EXTS.has(ext)) return false;

	// Unknown extension: treat as binary if it contains NUL bytes up front.
	const n = data.length < 1024 ? data.length : 1024;
	for (let i = 0; i < n; i++) {
		if (data[i] === 0) return true;
	}
	return false;
}
