// In-memory file tree + zip helpers for the Addon Editor.
//
// A "pack" (or any uploaded archive) is represented as a flat map of
// `path -> bytes`. Folders are implicit in the file paths, plus a separate
// `Set<string>` keeps track of folders the user explicitly created while they
// are still empty. Every folder path ends with "/" and file paths never do.

import { unzipSync, zipSync } from "fflate";
import { decodeUtf8Sig } from "../../shared/encoding";
import { stripJsonComments } from "../../shared/json";
import { sanitizeZipPath } from "../../shared/path";

export type FileMap = Record<string, Uint8Array>;

export type PackKind = "addon" | "behavior" | "resource" | "other";

/** Zip-bomb guards: reject archives that exceed these limits. */
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
export const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024;

export { sanitizeZipPath };

/**
 * Unzip a .mcpack/.mcaddon/.zip into a flat file map (directory entries skipped).
 * Zero-copy: entry bytes are referenced, never sliced/copied.
 * Rejects Zip-Slip (`../`, absolute) entries and enforces zip-bomb limits.
 */
export function unzipPack(data: Uint8Array): FileMap {
	const raw = unzipSync(data);
	const keys = Object.keys(raw);
	if (keys.length > MAX_ZIP_ENTRIES) {
		throw new Error(`Zip has too many entries (${keys.length} > ${MAX_ZIP_ENTRIES})`);
	}
	const out: FileMap = {};
	let total = 0;
	for (const rawPath of keys) {
		const content = raw[rawPath];
		// Skip directory entries (fflate marks them with trailing "/").
		if (rawPath.endsWith("/")) continue;
		const p = sanitizeZipPath(rawPath);
		if (p === null || p.length === 0 || p.endsWith("/")) continue;
		if (content.length > MAX_ZIP_FILE_BYTES) {
			throw new Error(`Zip entry too large: ${p} (${content.length} bytes)`);
		}
		total += content.length;
		if (total > MAX_ZIP_BYTES) {
			throw new Error(`Uncompressed zip too large (> ${MAX_ZIP_BYTES} bytes)`);
		}
		// Zero-copy: keep fflate's Uint8Array view as-is.
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
		const parsed: unknown = JSON.parse(stripJsonComments(text));
		if (!parsed || typeof parsed !== "object") return types;
		const m = parsed as { modules?: unknown; header?: unknown };
		const modules = Array.isArray(m.modules) ? m.modules : [];
		for (const mod of modules) {
			if (mod && typeof mod === "object" && typeof (mod as { type?: unknown }).type === "string") {
				types.push((mod as { type: string }).type);
			}
		}
		if (m.header && typeof m.header === "object" && typeof (m.header as { module_type?: unknown }).module_type === "string") {
			types.push((m.header as { module_type: string }).module_type);
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
		try {
			for (const t of manifestTypes(decodeUtf8Sig(files[path]))) types.add(t);
		} catch {
			// Ignore unreadable manifests.
		}
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
			const parsed: unknown = JSON.parse(stripJsonComments(decodeUtf8Sig(files[path])));
			if (!parsed || typeof parsed !== "object") continue;
			const name = (parsed as { header?: unknown }).header;
			if (name && typeof name === "object" && typeof (name as { name?: unknown }).name === "string") {
				const n = ((name as { name: string }).name).trim();
				if (n) return n;
			}
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
