// Monaco editor integration for the Addon Editor.
//
// Monaco is loaded lazily from a CDN (the page includes the tiny AMD loader in
// its <head>). `loadMonaco` resolves once the full editor is ready; if the CDN
// is unreachable it rejects and the caller falls back to a plain <textarea>.
// The module also owns language detection and binary-vs-text classification.

const MONACO_VERSION = "0.52.2";
const MONACO_VS = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;

let monacoPromise: Promise<any> | null = null;
let languagesRegistered = false;

export function loadMonaco(): Promise<any> {
	const w = window as any;
	if (w.monaco) return Promise.resolve(w.monaco);
	if (monacoPromise) return monacoPromise;

	monacoPromise = new Promise((resolve, reject) => {
		const require = w.require;
		if (!require) {
			reject(new Error("Monaco loader not available"));
			return;
		}
		require.config({ paths: { vs: MONACO_VS } });
		require(
			["vs/editor/editor.main"],
			() => {
				if (!w.monaco) {
					reject(new Error("Monaco failed to load"));
					return;
				}
				registerBedrockLanguages(w.monaco);
				resolve(w.monaco);
			},
			(err: unknown) => reject(err instanceof Error ? err : new Error(String(err)))
		);
	});

	return monacoPromise;
}

function registerBedrockLanguages(monaco: any): void {
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

/** Map a file path to a Monaco language id. */
export function languageForPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".json") || lower.endsWith(".mcmeta")) return "json";
	if (lower.endsWith(".js")) return "javascript";
	if (lower.endsWith(".ts")) return "typescript";
	if (lower.endsWith(".mcfunction")) return "mcfunction";
	if (lower.endsWith(".molang")) return "molang";
	if (lower.endsWith(".lang") || lower.endsWith(".properties") || lower.endsWith(".ini")) return "ini";
	if (lower.endsWith(".css")) return "css";
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
	if (lower.endsWith(".md") || lower.endsWith(".txt")) return "plaintext";
	return "plaintext";
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
	const n = Math.min(data.length, 1024);
	for (let i = 0; i < n; i++) {
		if (data[i] === 0) return true;
	}
	return false;
}
