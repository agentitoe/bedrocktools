import { unzipSync, zipSync } from "fflate";
import { decodeUtf8Sig, encodeUtf8 } from "../../shared/encoding";
import { normalizePath } from "../../shared/path";
import { stripJsonComments } from "../../shared/json";

const TYPE_TO_FOLDER: Record<string, string> = {
	resources: "resource_packs",
	data: "behavior_packs",
	skin_pack: "skin_packs",
	world_template: "minecraftWorlds",
};

const APP_FOLDER = "Microsoft.MinecraftUWPConsole_8wekyb3d8bbwe";
const BASE_PATH = "LocalState/games/com.mojang";

function cleanName(name: string, fallback: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9 _-]/g, "").trim();
	return cleaned || fallback;
}

function parseManifest(text: string): { type: string; name: string } | null {
	const cleaned = stripJsonComments(text);
	let manifest: any;
	try {
		manifest = JSON.parse(cleaned);
	} catch {
		return null;
	}
	if (!manifest || typeof manifest !== "object") return null;

	const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
	let type = "world_template";
	for (const mod of modules) {
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

	return { type, name: manifest.header?.name ?? "" };
}

function isLikelyWorld(raw: Record<string, Uint8Array>): boolean {
	for (const path of Object.keys(raw)) {
		const lower = normalizePath(path).toLowerCase();
		if (lower === "level.dat" || lower.startsWith("db/") || lower.startsWith("db\\")) {
			return true;
		}
	}
	return false;
}

function processSingle(data: Uint8Array, fileName?: string): Record<string, Uint8Array> {
	const raw = unzipSync(data);
	const toZip: Record<string, Uint8Array> = {};

	const packDirs: Array<{ dir: string; folder: string; packName: string }> = [];

	for (const [path, content] of Object.entries(raw)) {
		const normalized = normalizePath(path);
		const lower = normalized.toLowerCase();
		if (!lower.endsWith("manifest.json")) continue;

		const parts = normalized.split("/");
		parts.pop();
		const dir = parts.length > 0 ? parts.join("/") + "/" : "";

		const text = decodeUtf8Sig(content);
		const parsed = parseManifest(text);
		if (!parsed) continue;

		const fallback = fileName
			? fileName.replace(/\.[^/.]+$/, "").trim()
			: dir.replace(/\/$/, "").trim() || "pack";

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

	if (packDirs.length === 0 && isLikelyWorld(raw)) {
		const fallback = fileName
			? fileName.replace(/\.[^/.]+$/, "").trim()
			: "world";
		const basePrefix = APP_FOLDER + "/" + BASE_PATH + "/minecraftWorlds/" + fallback + "/";
		for (const [path, content] of Object.entries(raw)) {
			const normalized = normalizePath(path);
			if (normalized.endsWith("/")) continue;
			toZip[basePrefix + normalized] = content;
		}
		return toZip;
	}

	packDirs.sort((a, b) => b.dir.length - a.dir.length);

	for (const [path, content] of Object.entries(raw)) {
		const normalized = normalizePath(path);
		if (normalized.endsWith("/")) continue;

		let matched = false;
		for (const pack of packDirs) {
			if (pack.dir === "" || normalized.startsWith(pack.dir)) {
				const relative = pack.dir ? normalized.slice(pack.dir.length) : normalized;
				const basePrefix = APP_FOLDER + "/" + BASE_PATH + "/" + pack.folder + "/" + pack.packName + "/";
				toZip[basePrefix + relative] = content;
				matched = true;
				break;
			}
		}

		if (!matched) {
			const fallback = fileName
				? fileName.replace(/\.[^/.]+$/, "").trim()
				: "world";
			const basePrefix = APP_FOLDER + "/" + BASE_PATH + "/minecraftWorlds/" + fallback + "/";
			toZip[basePrefix + normalized] = content;
		}
	}

	return toZip;
}

export async function process(data: Uint8Array): Promise<Uint8Array> {
	const toZip = processSingle(data);
	return zipSync(toZip, { level: 6 });
}

export async function processFiles(datas: Uint8Array[], fileNames?: string[]): Promise<Uint8Array> {
	const merged: Record<string, Uint8Array> = {};
	for (let i = 0; i < datas.length; i++) {
		const toZip = processSingle(datas[i], fileNames?.[i]);
		for (const [path, content] of Object.entries(toZip)) {
			merged[path] = content;
		}
	}
	return zipSync(merged, { level: 6 });
}