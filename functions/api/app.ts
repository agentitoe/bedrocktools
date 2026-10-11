import { Elysia, t } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import {
	compactFields,
	filterItems,
	findItemByIdOrName,
	loadItems,
	projectItem,
	type Lang
} from "./lib/items";
import { collectRecipes, loadRecipes } from "./lib/recipes";
import { loadAllModels, resolveModel } from "./lib/models";
import { resolveTexture } from "./lib/textures";
import { sanitizeName } from "./lib/assets";

/**
 * BedrockTools API.
 *
 * A single Elysia app mounted behind `functions/api/[[path]].ts`. All data is
 * read from the deployment's own assets (no duplicated data files in the
 * worker bundle) and parsed JSON is cached per isolate.
 *
 * The app is created ONCE per isolate at module scope (isolate startup) and
 * runs in Elysia's dynamic mode (`aot: false`): the Workers runtime forbids
 * `new Function` outside isolate startup (flag `allow_eval_during_startup`),
 * and the dynamic interpreter does no code generation, so the API works on
 * any compatibility date without special flags. The ASSETS binding is not
 * available at startup, so it is bound per request via `bindAssets` from the
 * Pages Function entry point.
 */

const API_VERSION = "1.0.0";
const MAX_RECIPE_IDS = 50;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function parseLang(raw?: string): Lang {
	return raw === "es" ? "es" : "en";
}

function parseFields(raw?: string): string[] | undefined {
	if (!raw) return undefined;
	const fields = raw
		.split(",")
		.map((field) => field.trim())
		.filter((field) => /^[A-Za-z][A-Za-z0-9]*$/.test(field));
	return fields.length > 0 ? fields : undefined;
}

function parseBool(raw?: string): boolean {
	return raw === "1" || raw === "true";
}

function parseLimit(raw?: string): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
	return Math.min(parsed, MAX_LIMIT);
}

function notFound(set: { status?: number | string }): Record<string, unknown> {
	set.status = 404;
	return { error: "not_found" };
}

export function createApp() {
	return (
		new Elysia({ adapter: CloudflareAdapter, aot: false })
			.use(
				cors({
					origin: true,
					credentials: false
				})
			)
			.use(
				openapi({
					path: "/api/docs",
					specPath: "/api/openapi/json",
					provider: "swagger-ui",
					documentation: {
						info: {
							title: "BedrockTools API",
							version: API_VERSION,
							description:
								"Server-side lookups for BedrockTools: item catalog, recipes, block models and textures. Served from the deployment's own data assets."
						},
						tags: [
							{ name: "meta", description: "Service metadata" },
							{ name: "items", description: "Item catalog" },
							{ name: "recipes", description: "Crafting and cooking recipes" },
							{ name: "models", description: "Block models" },
							{ name: "textures", description: "Block and item textures" }
						]
					}
				})
			)
						.onError(({ code, error, set }) => {
				if (code === "NOT_FOUND") {
					set.status = 404;
					return { error: "not_found" };
				}
				if (code === "VALIDATION") {
					set.status = 400;
					return { error: "invalid_request", message: String(error) };
				}
				set.status = 500;
				return { error: "internal_error" };
			})

			// ---- meta ----
			.get(
				"/api/health",
				() => ({ status: "ok", version: API_VERSION }),
				{ detail: { tags: ["meta"], summary: "Health check" } }
			)

			// ---- items ----
			.get(
				"/api/items",
				async ({ query }) => {
					const lang = parseLang(query.lang);
					const fields = parseFields(query.fields) ?? (parseBool(query.compact) ? compactFields() : undefined);
					const items = await loadItems();
					const filtered = filterItems(items, {
						search: query.search,
						kind: query.kind,
						limit: parseLimit(query.limit)
					});
					return filtered.map((item) => projectItem(item, { lang, fields }));
				},
				{
					query: t.Object({
						lang: t.Optional(t.String()),
						compact: t.Optional(t.String()),
						fields: t.Optional(t.String()),
						kind: t.Optional(t.String()),
						search: t.Optional(t.String()),
						limit: t.Optional(t.String())
					}),
					detail: {
						tags: ["items"],
						summary: "List items",
						description:
							"Projected item catalog. `lang=es|en` (default en) localizes displayName; `compact=1` returns id/name/displayName/textureUrl/renderAs; `fields=a,b` custom allowlist (wins over compact); `kind=block|item|layered` filters by renderAs; `search=` substring on names; `limit` default 100, max 500."
					}
				}
			)
			.get(
				"/api/items/:idOrName",
				async ({ params, query, set }) => {
					const lang = parseLang(query.lang);
					const fields = parseFields(query.fields);
					const items = await loadItems();
					const item = findItemByIdOrName(items, params.idOrName);
					if (!item) return notFound(set);
					return projectItem(item, { lang, fields });
				},
				{
					detail: {
						tags: ["items"],
						summary: "Get one item",
						description: "Resolve an item by numeric id or exact name (e.g. `1` or `stone`). Query: `lang=es|en`, `fields=a,b`."
					}
				}
			)

			// ---- recipes ----
			.get(
				"/api/recipes",
				async ({ query }) => {
					const keys = (query.ids ?? "")
						.split(",")
						.map((key) => key.trim())
						.filter(Boolean)
						.slice(0, MAX_RECIPE_IDS);
					const items = await loadItems();
					const map = await loadRecipes();
					const ids: number[] = [];
					const names = new Map<number, string>();
					for (const key of keys) {
						const item = findItemByIdOrName(items, key);
						if (item) {
							ids.push(item.id);
							names.set(item.id, item.name);
						}
					}
					return collectRecipes(map, ids, names);
				},
				{
					detail: {
						tags: ["recipes"],
						summary: "Recipes for several items",
						description:
						"`ids` is a comma-separated list of item ids or names (max 50, e.g. `stone,stick`). Unknown keys are skipped."
					}
				}
			)
			.get(
				"/api/recipes/:itemIdOrName",
				async ({ params, set }) => {
					const items = await loadItems();
					const item = findItemByIdOrName(items, params.itemIdOrName);
					if (!item) return notFound(set);
					const map = await loadRecipes();
					const names = new Map<number, string>([[item.id, item.name]]);
					return collectRecipes(map, [item.id], names);
				},
				{
					detail: {
						tags: ["recipes"],
						summary: "Recipes for one item",
						description: "Resolve an item by id or name and return its recipes."
					}
				}
			)

			// ---- models ----
			.get(
				"/api/models/:name",
				async ({ params, set }) => {
					const name = sanitizeName(params.name);
					if (!name) return notFound(set);
					const all = await loadAllModels();
					const resolved = resolveModel(all, name);
					if (!resolved) return notFound(set);
					return resolved;
				},
				{
					detail: {
						tags: ["models"],
						summary: "Get a block model",
						description: "Returns the model with its `parent` chain already merged."
					}
				}
			)

			// ---- textures ----
			.get(
				"/api/textures/*",
				async ({ params, set }) => {
					const segments = params["*"];
					const name = Array.isArray(segments) ? segments.join("/") : (segments ?? "");
					const hit = await resolveTexture(name);
					if (!hit) return notFound(set);
					return new Response(hit.response.body, {
						status: 200,
						headers: {
							"content-type": hit.response.headers.get("content-type") ?? "image/webp",
							"cache-control": IMMUTABLE_CACHE
						}
					});
				},
				{
					detail: {
						tags: ["textures"],
						summary: "Get a texture",
						description:
							"Accepts an item name/id (uses the item's own fallback chain) or a texture path at any depth, e.g. `stone`, `bed/red`, `entity/bed/red`. Returns the bytes with immutable cache headers."
					}
				}
			)

			// Catch-all: consistent JSON 404 for unknown /api routes.
			.all("*", ({ set }) => {
				set.status = 404;
				return { error: "not_found" };
			})
	);
}

export type App = ReturnType<typeof createApp>;
