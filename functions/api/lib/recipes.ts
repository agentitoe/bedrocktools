import { loadJson } from "./assets";

/**
 * Recipe lookups.
 *
 * `recipes.json` is a map of numeric item-id strings to recipe arrays. The API
 * accepts item names too, so callers never need a second request to translate
 * `stone` -> `1`.
 */

/** JSON is only ever proxied through, never inspected: keep it loosely typed. */
export type RecipeData = Record<string, unknown>;
export type RecipesMap = Record<string, RecipeData[]>;

export async function loadRecipes(): Promise<RecipesMap> {
	return (await loadJson<RecipesMap>("/data/recipes.json")) ?? {};
}

export interface ResolvedRecipes {
	id: number;
	name: string;
	recipes: RecipeData[];
}

/** Collect recipes for the given item ids, keeping request order. */
export function collectRecipes(map: RecipesMap, ids: number[], names: Map<number, string>): ResolvedRecipes[] {
	return ids.map((id) => ({
		id,
		name: names.get(id) ?? String(id),
		recipes: map[String(id)] ?? []
	}));
}
