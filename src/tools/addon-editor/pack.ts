// In-memory file tree + zip helpers for the Addon Editor.
//
// A "pack" (or any uploaded archive) is represented as a flat map of
// `path -> bytes`. Folders are implicit in the file paths, plus a separate
// `Set<string>` keeps track of folders the user explicitly created while they
// are still empty. Every folder path ends with "/" and file paths never do.

import { unzipSync, zipSync } from "fflate";
import { decodeUtf8Sig } from "../../shared/encoding";
import { stripJsonComments } from "../../shared/json";
import { normalizePath } from "../../shared/path";

export type FileMap = Record<string, Uint8Array>;

export type PackKind = "addon" | "behavior" | "resource" | "other";

/** Unzip a .mcpack/.mcaddon/.zip into a flat file map (directory entries skipped). */
export function unzipPack(data: Uint8Array): FileMap {
	const raw = unzipSync(data);
	const out: FileMap = {};
	for (const [path, content] of Object.entries(raw)) {
		const p = normalizePath(path);
		if (p.length === 0 || p.endsWith("/")) continue;
		out[p] = content;
	}
	return out;
}

/** Re-zip a flat file map back into a single archive. */
export function zipPack(files: FileMap): Uint8Array {
	return zipSync(files, { level: 6 });
}

/** `dir` ends with "/" (or is "" for the root). Returns `dir/name`. */
export function joinPath(dir: string, name: string): string {
	const base = dir.replace(/\/+$/, "");
	return base ? base + "/" + name : name;
}

/** Parent directory of a path, ending with "/" ("" for the root). */
export function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i + 1);
}

/** Last path segment (file or folder name, no trailing slash). */
export function baseName(path: string): string {
	const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	const i = trimmed.lastIndexOf("/");
	return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/** Sanitize a name so it is safe to use as a download filename. */
export function sanitizeName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9 _-]/g, "").trim();
	return cleaned || "my_pack";
}

/**
 * List the immediate children of `dir` ("" for root). Folders come from both
 * explicit (still-empty) folders and any folder implied by a file path.
 */
export function listDir(
	files: FileMap,
	explicitFolders: Set<string>,
	dir: string
): { folders: string[]; files: string[] } {
	const folders = new Set<string>();
	const fileList: string[] = [];

	for (const path of Object.keys(files)) {
		if (!path.startsWith(dir)) continue;
		const rest = path.slice(dir.length);
		if (!rest) continue;
		const slash = rest.indexOf("/");
		if (slash === -1) fileList.push(rest);
		else folders.add(rest.slice(0, slash));
	}

	for (const folder of explicitFolders) {
		if (folder === dir || !folder.startsWith(dir)) continue;
		const rest = folder.slice(dir.length).replace(/\/+$/, "");
		if (!rest || rest.includes("/")) continue;
		folders.add(rest);
	}

	return {
		folders: [...folders].sort((a, b) => a.localeCompare(b)),
		files: fileList.sort((a, b) => a.localeCompare(b)),
	};
}

/** Parse a manifest.json and return the list of module types found in it. */
function manifestTypes(text: string): string[] {
	const types: string[] = [];
	try {
		const m = JSON.parse(stripJsonComments(text));
		const modules = Array.isArray(m?.modules) ? m.modules : [];
		for (const mod of modules) {
			if (mod && typeof mod.type === "string") types.push(mod.type);
		}
		if (m?.header && typeof m.header.module_type === "string") {
			types.push(m.header.module_type);
		}
	} catch {
		// Not valid JSON (or commented) — ignore.
	}
	return types;
}

/** Classify a project by the module types declared in its manifests. */
export function detectKind(files: FileMap): PackKind {
	const types = new Set<string>();
	for (const path of Object.keys(files)) {
		if (baseName(path).toLowerCase() !== "manifest.json") continue;
		for (const t of manifestTypes(decodeUtf8Sig(files[path]))) types.add(t);
	}
	const hasData = types.has("data");
	const hasResources = types.has("resources");
	if (hasData && hasResources) return "addon";
	if (hasData) return "behavior";
	if (hasResources) return "resource";
	return "other";
}

/** Best-effort pack name from the first manifest with a header.name. */
export function manifestName(files: FileMap): string | null {
	for (const path of Object.keys(files)) {
		if (baseName(path).toLowerCase() !== "manifest.json") continue;
		try {
			const m = JSON.parse(stripJsonComments(decodeUtf8Sig(files[path])));
			const name = m?.header?.name;
			if (typeof name === "string" && name.trim()) return name.trim();
		} catch {
			// Ignore.
		}
	}
	return null;
}

/** Suggest a download filename for the current project. */
export function downloadName(files: FileMap): string {
	const kind = detectKind(files);
	const ext = kind === "addon" ? ".mcaddon" : kind === "other" ? ".zip" : ".mcpack";
	const name = manifestName(files);
	const base = name ? sanitizeName(name) : "my_pack";
	return base + ext;
}
