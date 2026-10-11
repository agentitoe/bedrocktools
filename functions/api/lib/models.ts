import { loadJson } from "./assets";

/**
 * Block model resolution.
 *
 * Server-side port of `src/tools/minecraft-items/model-parser.ts`'s
 * `resolveModel`: merges the `parent` chain, resolves `#ref` texture
 * references and inherits display transforms. Clients currently download the
 * 216 KB `models/all.json` bundle to resolve a single model; this returns the
 * already-resolved model.
 */

type RawModel = {
	parent?: string;
	textures?: Record<string, unknown>;
	elements?: unknown[];
	display?: unknown;
};

export interface ResolvedModel {
	name: string;
	elements: unknown[];
	textures: Record<string, string>;
	display: unknown | null;
}

const MAX_MODEL_DEPTH = 16;

export async function loadAllModels(): Promise<Record<string, RawModel>> {
	return (await loadJson<Record<string, RawModel>>("/data/models/all.json")) ?? {};
}

function stripParentPrefix(parent: string): string {
	return parent.replace("minecraft:block/", "").replace("block/", "");
}

function mergeTextures(model: RawModel, inherited: Record<string, string>): Record<string, string> {
	const merged: Record<string, string> = { ...inherited };
	if (!model.textures) return merged;
	for (const [key, value] of Object.entries(model.textures)) {
		if (typeof value === "string" && value.startsWith("#")) {
			const ref = value.slice(1);
			merged[key] = merged[ref] ?? value;
		} else if (value && typeof value === "object" && typeof (value as { sprite?: unknown }).sprite === "string") {
			// Minecraft 26.1 texture format: { sprite: "minecraft:block/foo", ... }
			merged[key] = (value as { sprite: string }).sprite;
		} else if (typeof value === "string") {
			merged[key] = value;
		}
	}
	return merged;
}

/**
 * Resolve a model by name (from all.json). Returns `null` when the model does
 * not exist. The `seen` set guards against parent cycles in data and
 * `inherited` carries texture context down the parent chain, mirroring the
 * client's `resolveModel(name, textures)` signature.
 */
export function resolveModel(
	all: Record<string, RawModel>,
	name: string,
	seen: Set<string> = new Set(),
	inherited: Record<string, string> = {}
): ResolvedModel | null {
	const model = all[name];
	if (!model) return null;
	if (seen.has(name) || seen.size >= MAX_MODEL_DEPTH) return null;
	seen.add(name);

	const ownTextures = mergeTextures(model, inherited);
	let elements: unknown[] = model.elements ? [...model.elements] : [];
	let display: unknown | null = model.display ?? null;
	let textures = ownTextures;

	if (model.parent) {
		const parent = resolveModel(all, stripParentPrefix(model.parent), seen, ownTextures);
		if (parent) {
			// Parent elements come first; the child appends its own.
			elements = [...parent.elements, ...elements];
			display = model.display ?? parent.display ?? null;
			// Parent textures (fully resolved) win over the child's `#ref` placeholders.
			textures = { ...ownTextures, ...parent.textures };
		}
	}

	return { name, elements, textures, display };
}
