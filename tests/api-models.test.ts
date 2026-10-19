import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Fetcher } from "@cloudflare/workers-types";
import { bindAssets } from "../functions/api/lib/assets";
import { loadAllModels, resolveModel } from "../functions/api/lib/models";

/**
 * Unit tests for the server-side model resolver: the vanilla inheritance rules
 * (elements replace, textures leaf-wins, display merges by slot) against the
 * real `public/data/models/all.json` bundle the endpoint serves.
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
				return new Response(file, { headers: { "content-type": file.type ?? "application/octet-stream" } });
			}
			if (await spaFallback.exists()) return new Response(spaFallback, { headers: { "content-type": "text/html" } });
			return new Response("Not found", { status: 404 });
		},
		connect: () => Promise.reject(new Error("not implemented"))
	} as unknown as Fetcher;
}

bindAssets(mockAssets());

type Element = { from: number[]; to: number[]; faces: Record<string, { texture: string }> };

/** Child elements must survive alone: the parent's cuboids are never appended. */
describe("model resolution on the public fixture", () => {
	test("a child that declares elements replaces the parent's instead of concatenating", async () => {
		const all = await loadAllModels();
		const resolved = resolveModel(all, "white_glazed_terracotta");
		expect(resolved).not.toBeNull();

		// white_glazed_terracotta -> template_glazed_terracotta -> cube: the
		// template and the grandparent each declare a cuboid, and only the
		// closest declaration is kept.
		expect(resolved!.elements).toHaveLength(1);
		const [element] = resolved!.elements as Element[];
		expect(element.from).toEqual([0, 0, 0]);
		expect(element.to).toEqual([16, 16, 16]);
		expect(Object.keys(element.faces)).toEqual(["down", "up", "north", "south", "west", "east"]);
		// Every face points at the pattern texture; none of the grandparent's
		// `#down`/`#up`/`#north` placeholders (absent from the texture map)
		// leaks into the resolved model.
		for (const face of Object.values(element.faces)) {
			expect(face.texture).toBe("#pattern");
		}
	});

	test("textures declared by the leaf win and parent #refs resolve against it", async () => {
		const all = await loadAllModels();
		const resolved = resolveModel(all, "white_glazed_terracotta");
		// Only the leaf defines `pattern`; the parent's `particle: "#pattern"`
		// must resolve against the accumulated root→leaf map.
		expect(resolved!.textures).toEqual({
			pattern: "minecraft:block/white_glazed_terracotta",
			particle: "minecraft:block/white_glazed_terracotta"
		});
	});

	test("a grandparent #ref resolves against a key only the leaf defines", async () => {
		const all = await loadAllModels();
		const resolved = resolveModel(all, "stone");
		// cube_all declares down/up/north/... as "#all" and `stone` is the only
		// model of the chain defining `all`.
		expect(resolved!.textures).toEqual({
			all: "minecraft:block/stone",
			particle: "minecraft:block/stone",
			down: "minecraft:block/stone",
			up: "minecraft:block/stone",
			north: "minecraft:block/stone",
			east: "minecraft:block/stone",
			south: "minecraft:block/stone",
			west: "minecraft:block/stone"
		});
	});

	test("a partial display merges slot by slot with the inherited transforms", async () => {
		const all = await loadAllModels();
		const resolved = resolveModel(all, "white_glazed_terracotta");
		const display = resolved!.display as Record<string, { rotation: number[]; scale: number[] }>;
		// block/block defines all seven slots; template_glazed_terracotta only
		// overrides `firstperson_righthand`, the rest must still be inherited.
		expect(Object.keys(display).sort()).toEqual([
			"firstperson_lefthand",
			"firstperson_righthand",
			"fixed",
			"ground",
			"gui",
			"on_shelf",
			"thirdperson_righthand"
		]);
		expect(display.firstperson_righthand.rotation).toEqual([0, 135, 0]);
		expect(display.gui.scale).toEqual([0.625, 0.625, 0.625]);
	});
});

/** Synthetic chains for the rules the bundle does not exercise directly. */
describe("model resolution on synthetic chains", () => {
	const chain = {
		root: {
			textures: { texture: "block/parent_tex", pattern: "block/oak", particle: "#texture" },
			elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: "#texture" } } }],
			display: {
				gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] },
				ground: { rotation: [0, 0, 0], scale: [0.25, 0.25, 0.25] }
			}
		},
		// Overrides only `texture`; `pattern` and `display` are untouched.
		leaf: { parent: "block/root", textures: { texture: "block/leaf_tex" } },
		// Redeclares the cuboids with a single element.
		shaped: { parent: "block/root", elements: [{ from: [0, 0, 0], to: [16, 16, 16] }, { from: [1, 1, 1] }] },
		// Overrides only the `gui` slot.
		partialDisplay: { parent: "block/root", display: { gui: { rotation: [10, 20, 30], scale: [1, 1, 1] } } }
	};

	test("a child texture overrides the parent's and #refs follow the override", () => {
		const resolved = resolveModel(chain, "leaf");
		// The leaf wins, so the parent's `particle: "#texture"` resolves to it.
		expect(resolved!.textures.texture).toBe("block/leaf_tex");
		expect(resolved!.textures.particle).toBe("block/leaf_tex");
		// Keys the child does not mention stay inherited.
		expect(resolved!.textures.pattern).toBe("block/oak");
	});

	test("elements are replaced by the closest declaration, never concatenated", () => {
		// A child without its own `elements` inherits the parent's cuboids.
		expect(resolveModel(chain, "leaf")!.elements).toHaveLength(1);
		// A child that declares them uses only its own, in order.
		const shaped = resolveModel(chain, "shaped")!.elements as Element[];
		expect(shaped).toHaveLength(2);
		expect(shaped[0]!.to).toEqual([16, 16, 16]);
		expect(shaped[0]!.faces).toBeUndefined();
		expect(shaped[1]!.from).toEqual([1, 1, 1]);
	});

	test("a partial display keeps the parent's other slots", () => {
		const resolved = resolveModel(chain, "partialDisplay");
		expect(resolved!.display).toEqual({
			gui: { rotation: [10, 20, 30], scale: [1, 1, 1] },
			ground: { rotation: [0, 0, 0], scale: [0.25, 0.25, 0.25] }
		});
	});

	test("unknown models return null and parent cycles terminate", () => {
		expect(resolveModel({}, "nope")).toBeNull();
		const cyclic = { a: { parent: "minecraft:block/b" }, b: { parent: "minecraft:block/a" } };
		expect(() => resolveModel(cyclic, "a")).not.toThrow();
		expect(resolveModel(cyclic, "a")).toEqual({ name: "a", elements: [], textures: {}, display: null });
	});
});
