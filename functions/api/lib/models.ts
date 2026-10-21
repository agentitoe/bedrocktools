import { loadJson } from "./assets";

/**
 * Block model resolution.
 *
 * Server-side port of `src/tools/minecraft-items/model-parser.ts`'s
 * `resolveModel`: walks the `parent` chain from root to leaf, resolving
 * `#ref` texture references and inheriting display transforms with vanilla
 * semantics. Clients currently download the 216 KB `models/all.json` bundle
 * to resolve a single model; this returns the already-resolved model.
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

/**
 * Fold the `textures` declarations of a root→leaf chain into a single map.
 *
 * Literals and the 26.1 `{ sprite: ... }` objects are assigned where they are
 * found; `#ref` values are kept verbatim so `resolveTextureRefs` can substitute
 * them against the finished map — a parent may point at a key declared by one
 * of its descendants (e.g. `cube_all`'s `#all`, which only the leaf `stone`
 * defines), so a single pass in declaration order cannot resolve them.
 */
function mergeTextures(chain: RawModel[], inherited: Record<string, string>): Record<string, string> {
	const merged: Record<string, string> = { ...inherited };
	for (const model of chain) {
		if (!model.textures) continue;
		for (const [key, value] of Object.entries(model.textures)) {
			if (value && typeof value === "object" && typeof (value as { sprite?: unknown }).sprite === "string") {
				// Minecraft 26.1 texture format: { sprite: "minecraft:block/foo", ... }
				merged[key] = (value as { sprite: string }).sprite;
			} else if (typeof value === "string") {
				merged[key] = value;
			}
		}
	}
	return merged;
}

/**
 * Substitute every `#ref` value with the texture it points at, repeating until
 * the map stops changing so chained refs (`a` -> `#b` -> `#c` -> literal)
 * collapse. The iteration is bounded by the maximum chain depth, and a ref with
 * no matching key keeps its raw "#key" value for the caller to handle.
 */
function resolveTextureRefs(textures: Record<string, string>): Record<string, string> {
	const resolved: Record<string, string> = { ...textures };
	for (let pass = 0; pass <= MAX_MODEL_DEPTH; pass++) {
		let changed = false;
		for (const [key, value] of Object.entries(resolved)) {
			if (!value.startsWith("#")) continue;
			// A self-referencing key cannot progress; leave it for the caller.
			const target = resolved[value.slice(1)];
			if (target === undefined || target === value) continue;
			resolved[key] = target;
			changed = true;
		}
		if (!changed) break;
	}
	return resolved;
}

/**
 * Fold the `display` declarations of a root→leaf chain one transform slot at a
 * time.
 *
 * Vanilla keeps every slot (`gui`, `fixed`, `ground`, `head`, `thirdperson_*`,
 * `firstperson_*`, `on_shelf`) unless the model overrides that exact slot, so a
 * partial `display` must merge into the inherited object instead of replacing
 * it wholesale.
 */
function mergeDisplay(chain: RawModel[]): Record<string, unknown> | null {
	let merged: Record<string, unknown> | null = null;
	for (const model of chain) {
		const own = model.display;
		// Only objects carry transform slots; anything else inherits untouched.
		if (!own || typeof own !== "object" || Array.isArray(own)) continue;
		merged = { ...merged, ...(own as Record<string, unknown>) };
	}
	return merged;
}

/**
 * Pick the elements of a root→leaf chain.
 *
 * A model that declares `elements` defines the entire cuboid list for itself
 * and may not be combined with its parent's, so the closest declaration to the
 * leaf wins and a child never appends to (nor prefixes) its ancestors'.
 */
function mergeElements(chain: RawModel[]): unknown[] {
	for (let i = chain.length - 1; i >= 0; i--) {
		const own = chain[i]!.elements;
		if (Array.isArray(own)) return [...own];
	}
	return [];
}

/**
 * Collect the parent chain of `name`, ordered root→leaf, plus the resolved
 * state. Returns `null` when the model does not exist. The `seen` set guards
 * against parent cycles in data (and bounds the walk) and `inherited` seeds
 * the texture map the chain is accumulated onto, mirroring the client's
 * `resolveModel(name, textures)` signature.
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

	// Walk leaf→root collecting the chain, stopping on a cycle, a missing
	// parent or the depth guard (truncating, like the previous recursion).
	const chain: RawModel[] = [model];
	let current: RawModel = model;
	while (current.parent) {
		const parentName = stripParentPrefix(current.parent);
		if (seen.has(parentName) || seen.size >= MAX_MODEL_DEPTH) break;
		const parent = all[parentName];
		if (!parent) break;
		seen.add(parentName);
		chain.push(parent);
		current = parent;
	}
	// Fold root→leaf so the closest declaration wins: vanilla resolves a model
	// against its parent's already-resolved state, never the other way round.
	chain.reverse();

	return {
		name,
		elements: mergeElements(chain),
		textures: resolveTextureRefs(mergeTextures(chain, inherited)),
		display: mergeDisplay(chain)
	};
}
