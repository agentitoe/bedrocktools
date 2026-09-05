import { unzipSync, zipSync } from "fflate";
import { decodeUtf8Sig } from "../../shared/encoding";
import { sanitizeZipPath } from "../../shared/path";
import { stripJsonComments } from "../../shared/json";

const TYPE_TO_FOLDER: Record<string, string> = {
	resources: "resource_packs",
	data: "behavior_packs",
	skin_pack: "skin_packs",
	world_template: "minecraftWorlds",
};

const APP_FOLDER = "Microsoft.MinecraftUWPConsole_8wekyb3d8bbwe";
const BASE_PATH = "LocalState/games/com.mojang";

/** Anti zip-bomb limits (same policy as addon-converter). */
export const MAX_ENTRIES = 2000;
export const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
export const MAX_FILE = 50 * 1024 * 1024;

interface PackDir {
	dir: string;
	folder: string;
	packName: string;
}

interface ZipEntry {
	/** Sanitized relative path (`/`-separated). */
	path: string;
	/** Lowercased path, precomputed once. */
	lower: string;
	content: Uint8Array;
}

/**
 * Unicode-preserving filename cleaner: strips only control chars and the
 * Windows-forbidden `<>:"/\|?*`, then trims. Accents, CJK, emoji, spaces,
 * dots and dashes survive (unlike the old ASCII-only filter).
 */
function cleanName(name: string, fallback: string): string {
	const cleaned = name.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "").trim();
	// A pack/fallback name becomes a single zip path segment. Dot-segments
	// would create "/../" in the output archive (Zip-Slip on extraction).
	if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
	return cleaned;
}

function stripExtension(fileName: string): string {
	return fileName.replace(/\.[^/.]+$/, "").trim();
}

function tryParseJson(text: string): any | null {
	try {
		return JSON.parse(stripJsonComments(text));
	} catch {
		return null;
	}
}

function parseManifest(text: string): { type: string; name: string } | null {
	const manifest = tryParseJson(text);
	if (!manifest || typeof manifest !== "object") return null;

	const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
	let type = "world_template";
	for (let i = 0; i < modules.length; i++) {
		const mod = modules[i];
		if (
			typeof mod === "object" &&
			mod !== null &&
			typeof mod.type === "string" &&
			TYPE_TO_FOLDER[mod.type]
		) {
			type = mod.type;
			break;
		}
	}

	if (
		type === "world_template" &&
		typeof manifest.header === "object" &&
		manifest.header !== null &&
		typeof manifest.header.module_type === "string" &&
		TYPE_TO_FOLDER[manifest.header.module_type]
	) {
		type = manifest.header.module_type;
	}

	const rawName = manifest.header?.name;
	return { type, name: typeof rawName === "string" ? rawName : "" };
}

function safeUnzip(data: Uint8Array): Record<string, Uint8Array> {
	let raw: Record<string, Uint8Array>;
	try {
		raw = unzipSync(data);
	} catch {
		throw new Error("Invalid pack file (could not unzip)");
	}
	const names = Object.keys(raw);
	if (names.length > MAX_ENTRIES) {
		throw new Error(`Pack too large: exceeds ${MAX_ENTRIES} files limit`);
	}
	let total = 0;
	for (let i = 0; i < names.length; i++) {
		const size = raw[names[i]].length;
		if (size > MAX_FILE) {
			throw new Error("Pack too large: a file exceeds 50 MB");
		}
		total += size;
		if (total > MAX_TOTAL_UNCOMPRESSED) {
			throw new Error("Pack too large: exceeds 200 MB uncompressed");
		}
	}
	return raw;
}

/**
 * Single-pass intake: sanitize + precompute `lower` once per entry while
 * collecting manifest dirs and world markers. Returns cached entries so
 * later phases never re-normalize paths.
 */
function collectEntries(raw: Record<string, Uint8Array>): ZipEntry[] {
	const names = Object.keys(raw);
	const entries: ZipEntry[] = [];
	for (let i = 0; i < names.length; i++) {
		const rawPath = names[i];
		if (rawPath.endsWith("/")) continue;
		const safe = sanitizeZipPath(rawPath);
		if (safe === null) continue;
		entries.push({ path: safe, lower: safe.toLowerCase(), content: raw[rawPath] });
	}
	return entries;
}

function isLikelyWorld(entries: ZipEntry[]): boolean {
	for (let i = 0; i < entries.length; i++) {
		const lower = entries[i].lower;
		if (lower === "level.dat" || lower.startsWith("db/") || lower.startsWith("db\\")) {
			return true;
		}
	}
	return false;
}

/** Insert without silent overwrite: `file.txt` -> `file_1.txt` on collision. */
function insertUnique(map: Map<string, Uint8Array>, path: string, content: Uint8Array): void {
	if (!map.has(path)) {
		map.set(path, content);
		return;
	}
	const slash = path.lastIndexOf("/");
	const dir = slash === -1 ? "" : path.slice(0, slash + 1);
	const file = slash === -1 ? path : path.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	const base = dot <= 0 ? file : file.slice(0, dot);
	const ext = dot <= 0 ? "" : file.slice(dot);
	for (let n = 1; ; n++) {
		const candidate = dir + base + "_" + n + ext;
		if (!map.has(candidate)) {
			map.set(candidate, content);
			return;
		}
	}
}

function processSingle(data: Uint8Array, fileName?: string): Record<string, Uint8Array> {
	const raw = safeUnzip(data);
	const entries = collectEntries(raw);
	const toZip = new Map<string, Uint8Array>();

	const packDirs: PackDir[] = [];
	// File.name is a basename per spec, but never trust it: route it through
	// cleanName so "../evil" style names can't become output path segments.
	const fallbackFile = fileName ? cleanName(stripExtension(fileName), "pack") : "";

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry.lower.endsWith("manifest.json")) continue;

		const slash = entry.path.lastIndexOf("/");
		const dir = slash === -1 ? "" : entry.path.slice(0, slash + 1);

		const parsed = parseManifest(decodeUtf8Sig(entry.content));
		if (!parsed) continue;

		const fallback = fallbackFile || dir.replace(/\/$/, "").trim() || "pack";

		let packName = parsed.name.trim();
		if (!packName || packName.startsWith("pack.")) {
			packName = fallback;
		}
		packName = cleanName(packName, fallback);

		packDirs.push({
			dir,
			folder: TYPE_TO_FOLDER[parsed.type],
			packName,
		});
	}

	if (packDirs.length === 0 && isLikelyWorld(entries)) {
		const fallback = fallbackFile || "world";
		const basePrefix = APP_FOLDER + "/" + BASE_PATH + "/minecraftWorlds/" + fallback + "/";
		for (let i = 0; i < entries.length; i++) {
			insertUnique(toZip, basePrefix + entries[i].path, entries[i].content);
		}
		return Object.fromEntries(toZip);
	}

	// Longest prefix first so nested packs match their own dir.
	packDirs.sort((a, b) => b.dir.length - a.dir.length);

	const worldFallback = fallbackFile || "world";
	const worldPrefix = APP_FOLDER + "/" + BASE_PATH + "/minecraftWorlds/" + worldFallback + "/";
	// Precompute full prefixes once (sorted order preserved).
	const prefixes: string[] = new Array(packDirs.length);
	for (let i = 0; i < packDirs.length; i++) {
		prefixes[i] =
			APP_FOLDER + "/" + BASE_PATH + "/" + packDirs[i].folder + "/" + packDirs[i].packName + "/";
	}

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		let matched = false;
		for (let j = 0; j < packDirs.length; j++) {
			const dir = packDirs[j].dir;
			if (dir === "" || entry.path.startsWith(dir)) {
				const relative = dir ? entry.path.slice(dir.length) : entry.path;
				insertUnique(toZip, prefixes[j] + relative, entry.content);
				matched = true;
				break;
			}
		}

		if (!matched) {
			insertUnique(toZip, worldPrefix + entry.path, entry.content);
		}
	}

	return Object.fromEntries(toZip);
}

export async function process(data: Uint8Array): Promise<Uint8Array> {
	const toZip = processSingle(data);
	return zipSync(toZip, { level: 6 });
}

export async function processFiles(datas: Uint8Array[], fileNames?: string[]): Promise<Uint8Array> {
	const merged = new Map<string, Uint8Array>();
	for (let i = 0; i < datas.length; i++) {
		const toZip = processSingle(datas[i], fileNames?.[i]);
		const names = Object.keys(toZip);
		for (let j = 0; j < names.length; j++) {
			insertUnique(merged, names[j], toZip[names[j]]);
		}
	}
	return zipSync(Object.fromEntries(merged), { level: 6 });
}