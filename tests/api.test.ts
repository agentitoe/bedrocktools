import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Fetcher } from "@cloudflare/workers-types";
import { createApp } from "../functions/api/app";
import { bindAssets } from "../functions/api/lib/assets";
import { sanitizeAssetPath, sanitizeName } from "../functions/api/lib/assets";
import { filterItems, findItemByIdOrName, projectItem, type ItemData } from "../functions/api/lib/items";
import { collectRecipes } from "../functions/api/lib/recipes";
import { resolveModel } from "../functions/api/lib/models";
import { buildItemCandidates, buildNameCandidates } from "../functions/api/lib/textures";

/**
 * Integration-style tests against the real `public/` data through a mock
 * ASSETS fetcher (the Pages binding resolves requests by pathname).
 */
const publicDir = join(import.meta.dir, "..", "public");

function mockAssets(publicRoot: string = publicDir): Fetcher {
	// Mirrors the real ASSETS binding: missing paths fall back to index.html
	// with 200 (SPA fallback), so handlers must not trust `ok` alone.
	const spaFallback = Bun.file(join(publicRoot, "index.html"));
	return {
		fetch: async (input: RequestInfo | URL) => {
			const raw = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			const { pathname } = new URL(raw);
			const file = Bun.file(join(publicRoot, pathname));
			if (await file.exists()) {
				// Set the content-type explicitly: Bun only materializes it lazily
				// when constructing a Response from a BunFile.
				return new Response(file, { headers: { "content-type": file.type ?? "application/octet-stream" } });
			}
			if (await spaFallback.exists()) return new Response(spaFallback, { headers: { "content-type": "text/html" } });
			return new Response("Not found", { status: 404 });
		},
		connect: () => Promise.reject(new Error("not implemented"))
	} as unknown as Fetcher;
}

function apiRequest(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, init);
}

async function getJson(app: { handle: (request: Request) => Promise<Response> }, path: string) {
	const res = await app.handle(apiRequest(path));
	return { status: res.status, body: await res.json(), headers: res.headers };
}

bindAssets(mockAssets());
const app = createApp();

describe("sanitizers", () => {
	test("accepts normal paths and names", () => {
		expect(sanitizeAssetPath("/data/items.json")).toBe("/data/items.json");
		expect(sanitizeAssetPath("data/items.json")).toBe("/data/items.json");
		expect(sanitizeAssetPath("textures/block/stone.webp")).toBe("/textures/block/stone.webp");
		expect(sanitizeName("acacia_fence_inventory")).toBe("acacia_fence_inventory");
	});

	test("rejects traversal and malformed input", () => {
		expect(sanitizeAssetPath("../etc/passwd")).toBeNull();
		expect(sanitizeAssetPath("/data/../../secret.json")).toBeNull();
		expect(sanitizeAssetPath("..\\windows\\system32")).toBeNull();
		expect(sanitizeAssetPath("")).toBeNull();
		expect(sanitizeAssetPath("data/ite ms.json")).toBeNull();
		expect(sanitizeAssetPath("data/items%2ejson")).toBeNull();
		expect(sanitizeName("bad name")).toBeNull();
		expect(sanitizeName("minecraft:block/stone")).toBeNull();
	});
});

describe("item helpers", () => {
	const items: ItemData[] = [
		{ id: 1, name: "stone", displayName: "Stone", displayNameEs: "Piedra", stackSize: 64, textureUrl: "/textures/block/stone.webp", renderAs: "block", modelName: "stone" },
		{ id: 2, name: "grass_block", displayName: "Grass Block", displayNameEs: "Bloque de hierba", stackSize: 64, textureUrl: "/textures/block/grass_block_side.webp", renderAs: "block" },
		{ id: 3, name: "stick", displayName: "Stick", stackSize: 64, textureUrl: "/textures/item/stick.webp", renderAs: "item" }
	];

	test("projectItem localizes to es and keeps displayNameEn", () => {
		const projected = projectItem(items[0], { lang: "es" });
		expect(projected.displayName).toBe("Piedra");
		expect(projected.displayNameEn).toBe("Stone");
	});

	test("projectItem keeps English when no translation exists", () => {
		const projected = projectItem(items[2], { lang: "es" });
		expect(projected.displayName).toBe("Stick");
		expect(projected.displayNameEn).toBeUndefined();
	});

	test("projectItem honours field allowlist", () => {
		const projected = projectItem(items[0], { lang: "en", fields: ["id", "name"] });
		expect(projected).toEqual({ id: 1, name: "stone" });
	});

	test("filterItems searches name and translations", () => {
		expect(filterItems(items, { search: "piedra", limit: 10 })[0]?.id).toBe(1);
		expect(filterItems(items, { search: "STICK", limit: 10 })[0]?.id).toBe(3);
	});

	test("filterItems filters by kind and applies limit", () => {
		expect(filterItems(items, { kind: "item", limit: 10 }).map((i) => i.id)).toEqual([3]);
		expect(filterItems(items, { limit: 2 })).toHaveLength(2);
	});

	test("findItemByIdOrName resolves ids and names case-insensitively", () => {
		expect(findItemByIdOrName(items, "1")?.name).toBe("stone");
		expect(findItemByIdOrName(items, "STONE")?.name).toBe("stone");
		expect(findItemByIdOrName(items, "999")).toBeUndefined();
		expect(findItemByIdOrName(items, "diamond")).toBeUndefined();
	});
});

describe("recipe helpers", () => {
	const map = { "1": [{ type: "crafting_shaped" }] };

	test("collectRecipes keeps order and skips unknown ids", () => {
		const names = new Map([[1, "stone"]]);
		const result = collectRecipes(map, [1, 999], names);
		expect(result).toEqual([
			{ id: 1, name: "stone", recipes: [{ type: "crafting_shaped" }] },
			{ id: 999, name: "999", recipes: [] }
		]);
	});
});

describe("model resolution", () => {
	test("model resolution merges the parent chain like the client", () => {
		const all = {
			cube_all: { parent: "minecraft:block/cube", textures: { all: "#texture" }, elements: [] },
			cube: { textures: { texture: "block/base", particle: "#texture" }, elements: [{ from: [0, 0, 0] }] },
			stone: { parent: "block/cube_all", textures: { texture: "block/stone" }, display: { gui: { rotation: [30, 225, 0] } } }
		};
		const resolved = resolveModel(all, "stone");
		expect(resolved).not.toBeNull();
		// A grandparent's literal texture wins over the child's #ref (client semantics).
		expect(resolved?.textures.texture).toBe("block/base");
		expect(resolved?.textures.all).toBe("block/stone");
		expect(resolved?.textures.particle).toBe("block/base");
		expect(resolved?.elements).toEqual([{ from: [0, 0, 0] }]);
		expect(resolved?.display).toEqual({ gui: { rotation: [30, 225, 0] } });
	});

	test("returns null for unknown models and survives parent cycles", () => {
		expect(resolveModel({}, "nope")).toBeNull();
		const cyclic = { a: { parent: "minecraft:block/b" }, b: { parent: "minecraft:block/a" } };
		expect(() => resolveModel(cyclic, "a")).not.toThrow();
	});
});

describe("texture candidates", () => {
	test("block items try _side/_top/_bottom variants", () => {
		const candidates = buildItemCandidates(
			{ id: 1, name: "stone", displayName: "Stone", stackSize: 64, textureUrl: "/textures/block/stone.webp", renderAs: "block" },
			true
		);
		expect(candidates).toEqual([
			"/textures/block/stone.webp",
			"/textures/block/stone_side.webp",
			"/textures/block/stone_top.webp",
			"/textures/block/stone_bottom.webp"
		]);
	});

	test("_side-primary blocks try _top/_bottom first (mirrors client)", () => {
		const candidates = buildItemCandidates(
			{ id: 2, name: "grass_block", displayName: "Grass", stackSize: 64, textureUrl: "/textures/block/grass_block_side.webp", renderAs: "block" },
			true
		);
		expect(candidates.slice(0, 4)).toEqual([
			"/textures/block/grass_block_side.webp",
			"/textures/block/grass_block_top.webp",
			"/textures/block/grass_block_bottom.webp",
			"/textures/block/grass_block.webp"
		]);
	});

	test("name guesses cover standard texture roots and extensions", () => {
		const candidates = buildNameCandidates("minecraft:block/stone");
		expect(candidates).toContain("/textures/block/stone.webp");
		expect(candidates).toContain("/textures/item/stone.png");
		expect(candidates).toContain("/textures/entity/bed/stone.webp");
	});
});

describe("API endpoints (real public/ data via mock ASSETS)", () => {
	test("GET /api/health", async () => {
		const { status, body } = await getJson(app, "/api/health");
		expect(status).toBe(200);
		expect(body).toEqual({ status: "ok", version: "1.0.0" });
	});

	test("GET /api/items?compact=1&lang=es", async () => {
		const { status, body } = await getJson(app, "/api/items?compact=1&lang=es&kind=block&limit=3");
		expect(status).toBe(200);
		const items = body as Array<Record<string, unknown>>;
		expect(items).toHaveLength(3);
		expect(items[0]).toEqual({
			id: 1,
			name: "stone",
			displayName: "Piedra",
			displayNameEn: "Stone",
			textureUrl: "/textures/block/stone.webp",
			renderAs: "block"
		});
	});

	test("GET /api/items?fields=", async () => {
		const { body } = await getJson(app, "/api/items?fields=id,name&limit=2");
		expect(body).toEqual([
			{ id: 1, name: "stone" },
			{ id: 2, name: "granite" }
		]);
	});

	test("GET /api/items/search", async () => {
		const { body } = await getJson(app, "/api/items?search=diamond&kind=item&limit=5");
		expect((body as Array<{ name: string }>).every((i) => i.name.includes("diamond"))).toBe(true);
	});

	test("GET /api/items/:idOrName by id and by name", async () => {
		const byId = await getJson(app, "/api/items/1");
		expect(byId.status).toBe(200);
		expect((byId.body as { name: string }).name).toBe("stone");

		const byName = await getJson(app, "/api/items/stone");
		expect(byName.status).toBe(200);
		expect((byName.body as { id: number }).id).toBe(1);

		const missing = await getJson(app, "/api/items/does_not_exist");
		expect(missing.status).toBe(404);
		expect(missing.body).toEqual({ error: "not_found" });
	});

	test("GET /api/recipes and /api/recipes/:idOrName resolve names to ids", async () => {
		const byName = await getJson(app, "/api/recipes/stone");
		expect(byName.status).toBe(200);
		expect((byName.body as Array<{ id: number; recipes: unknown[] }>)[0].id).toBe(1);
		expect((byName.body as Array<{ recipes: unknown[] }>)[0].recipes.length).toBeGreaterThan(0);

		const batch = await getJson(app, "/api/recipes?ids=stone,stick,totally_unknown");
		expect(batch.status).toBe(200);
		const list = batch.body as Array<{ id: number; recipes: unknown[] }>;
		expect(list.map((entry) => entry.id)).toEqual([1, 947]);

		const missing = await getJson(app, "/api/recipes/does_not_exist");
		expect(missing.status).toBe(404);
	});

	test("GET /api/models/:name resolves the parent chain", async () => {
		const res = await getJson(app, "/api/models/stone");
		expect(res.status).toBe(200);
		const model = res.body as { name: string; textures: Record<string, string>; elements: unknown[] };
		expect(model.name).toBe("stone");
		expect(model.elements.length).toBeGreaterThan(0);
		expect(Object.keys(model.textures).length).toBeGreaterThan(0);
		// Every face/particle texture resolves through the parent's #all reference.
		for (const value of Object.values(model.textures)) {
			expect(value).toBe("minecraft:block/stone");
		}
	});

	test("GET /api/textures/:name returns the bytes with immutable cache", async () => {
		const res = await app.handle(apiRequest("/api/textures/stone"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("image/webp");
		expect(res.headers.get("cache-control")).toContain("immutable");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.byteLength).toBeGreaterThan(0);
	});

	test("GET /api/textures resolves nested names at any depth", async () => {
		for (const path of ["/api/textures/bed/red", "/api/textures/entity/bed/red", "/api/textures/block/stone"]) {
			const res = await app.handle(apiRequest(path));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("image/webp");
		}
	});

	test("unknown textures 404 even when the SPA fallback answers 200", async () => {
		// Pages' ASSETS binding serves index.html with 200 for unknown paths;
		// the resolver must not mistake that payload for a texture.
		const res = await app.handle(apiRequest("/api/textures/nope_nope"));
		expect(res.status).toBe(404);
	});

	test("path traversal is rejected with 404", async () => {
		const res = await app.handle(apiRequest("/api/textures/..%2f..%2fetc%2fpasswd"));
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({ error: "not_found" });
	});

	test("unknown /api routes return JSON 404", async () => {
		const { status, body } = await getJson(app, "/api/nope");
		expect(status).toBe(404);
		expect(body).toEqual({ error: "not_found" });
	});

	test("CORS preflight is answered", async () => {
		const res = await app.handle(
			apiRequest("/api/items", { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "GET" } })
		);
		expect(res.status).toBeLessThan(400);
		expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
	});

	test("Swagger UI references the absolute spec URL (no double /api prefix)", async () => {
		const res = await app.handle(apiRequest("/api/docs"));
		expect(res.status).toBe(200);
		const html = await res.text();
		// Regression: the plugin strips the leading slash of specPath, which
		// Swagger resolves relative to /api/docs -> /api/api/openapi/json.
		expect(html).toContain('"url": "/api/openapi/json"');
		expect(html).not.toContain("api/api/openapi");
	});

	test("OpenAPI spec lists every route", async () => {
		const { status, body } = await getJson(app, "/api/openapi/json");
		expect(status).toBe(200);
		const paths = Object.keys((body as { paths: Record<string, unknown> }).paths);
		expect(paths).toContain("/api/health");
		expect(paths).toContain("/api/items");
		expect(paths).toContain("/api/items/{idOrName}");
		expect(paths).toContain("/api/recipes");
		expect(paths).toContain("/api/models/{name}");
		expect(paths).toContain("/api/textures/*");
	});
});
