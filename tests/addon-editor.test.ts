import { test, expect } from "bun:test";
import {
	unzipPack,
	zipPack,
	joinPath,
	dirOf,
	baseName,
	sanitizeName,
	listDir,
	detectKind,
	manifestName,
	downloadName,
	type FileMap,
} from "../src/tools/addon-editor/pack";
import { buildTemplate } from "../src/tools/addon-editor/templates";
import { languageForPath, isBinary } from "../src/tools/addon-editor/monaco";
import { encodeUtf8, decodeUtf8Sig } from "../src/shared/encoding";

const enc = (s: string) => encodeUtf8(s);

// ---- pack.ts: zip roundtrip ----

test("zipPack(unzipPack(x)) roundtrips the file map", () => {
	const files: FileMap = { "manifest.json": enc("{}"), "textures/a.png": new Uint8Array([1, 2, 3]) };
	const zip = zipPack(files);
	const out = unzipPack(zip);
	expect(Object.keys(out).sort()).toEqual(["manifest.json", "textures/a.png"]);
	expect(decodeUtf8Sig(out["manifest.json"])).toBe("{}");
});

test("unzipPack skips directory entries", () => {
	// A zip containing a directory entry (key ends with "/") and a file.
	const withDir: FileMap = { "textures/": new Uint8Array(0), "manifest.json": enc("{}") };
	const zip = zipPack(withDir);
	const out = unzipPack(zip);
	expect(Object.keys(out)).toEqual(["manifest.json"]);
});

// ---- pack.ts: path helpers ----

test("joinPath joins a directory and a name", () => {
	expect(joinPath("", "manifest.json")).toBe("manifest.json");
	expect(joinPath("textures/", "a.png")).toBe("textures/a.png");
});

test("dirOf returns the parent directory with a trailing slash", () => {
	expect(dirOf("manifest.json")).toBe("");
	expect(dirOf("textures/a.png")).toBe("textures/");
	expect(dirOf("a/b/c.json")).toBe("a/b/");
});

test("baseName returns the last segment and strips trailing slashes", () => {
	expect(baseName("textures/a.png")).toBe("a.png");
	expect(baseName("textures/")).toBe("textures");
	expect(baseName("manifest.json")).toBe("manifest.json");
});

test("sanitizeName strips unsafe characters", () => {
	expect(sanitizeName("My Pack!")).toBe("My Pack");
	expect(sanitizeName("   ")).toBe("my_pack");
});

// ---- pack.ts: listDir ----

test("listDir lists immediate folders and files", () => {
	const files: FileMap = {
		"manifest.json": enc("{}"),
		"textures/a.png": new Uint8Array([1]),
		"textures/blocks/b.png": new Uint8Array([2]),
		"functions/tick.mcfunction": enc("say hi"),
	};
	const explicit = new Set<string>(["sounds/"]);
	expect(listDir(files, explicit, "")).toEqual({
		folders: ["functions", "sounds", "textures"],
		files: ["manifest.json"],
	});
	expect(listDir(files, explicit, "textures/")).toEqual({
		folders: ["blocks"],
		files: ["a.png"],
	});
});

// ---- pack.ts: detection ----

function manifestWith(type: string): string {
	return JSON.stringify({ format_version: 2, modules: [{ type }] });
}

test("detectKind classifies behavior, resource and addon packs", () => {
	expect(detectKind({ "manifest.json": enc(manifestWith("data")) })).toBe("behavior");
	expect(detectKind({ "manifest.json": enc(manifestWith("resources")) })).toBe("resource");
	expect(
		detectKind({
			"BP/manifest.json": enc(manifestWith("data")),
			"RP/manifest.json": enc(manifestWith("resources")),
		})
	).toBe("addon");
	expect(detectKind({ "README.txt": enc("hi") })).toBe("other");
});

test("manifestName reads header.name", () => {
	const m = JSON.stringify({ header: { name: "Cool Pack" }, modules: [] });
	expect(manifestName({ "manifest.json": enc(m) })).toBe("Cool Pack");
	expect(manifestName({})).toBeNull();
});

test("downloadName picks the right extension", () => {
	expect(downloadName({ "manifest.json": enc(manifestWith("data")) })).toBe("my_pack.mcpack");
	const addon: FileMap = {
		"BP/manifest.json": enc(JSON.stringify({ header: { name: "Cool" }, modules: [{ type: "data" }] })),
		"RP/manifest.json": enc(JSON.stringify({ header: { name: "Cool" }, modules: [{ type: "resources" }] })),
	};
	expect(downloadName(addon)).toBe("Cool.mcaddon");
});

// ---- templates.ts ----

test("behavior template has a data manifest and starter files", () => {
	const files = buildTemplate("behavior", "My Pack");
	expect(files["manifest.json"]).toBeTruthy();
	expect(files["functions/example.mcfunction"]).toBeTruthy();
	expect(files["texts/en_US.lang"]).toBeTruthy();
	const manifest = JSON.parse(decodeUtf8Sig(files["manifest.json"]));
	expect(manifest.modules[0].type).toBe("data");
	expect(manifest.header.name).toBe("My Pack");
});

test("resource template has a resources manifest", () => {
	const files = buildTemplate("resource", "RP");
	const manifest = JSON.parse(decodeUtf8Sig(files["manifest.json"]));
	expect(manifest.modules[0].type).toBe("resources");
});

test("addon template nests both packs", () => {
	const files = buildTemplate("addon", "My Addon");
	const bp = JSON.parse(decodeUtf8Sig(files["behavior_pack/manifest.json"]));
	const rp = JSON.parse(decodeUtf8Sig(files["resource_pack/manifest.json"]));
	expect(bp.modules[0].type).toBe("data");
	expect(rp.modules[0].type).toBe("resources");
});

test("template uuids are unique", () => {
	const files = buildTemplate("behavior", "P");
	const manifest = JSON.parse(decodeUtf8Sig(files["manifest.json"]));
	const uuids = [manifest.header.uuid, manifest.modules[0].uuid];
	expect(new Set(uuids).size).toBe(2);
	for (const u of uuids) expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ---- monaco.ts ----

test("languageForPath maps file extensions to Monaco languages", () => {
	expect(languageForPath("manifest.json")).toBe("json");
	expect(languageForPath("scripts/main.js")).toBe("javascript");
	expect(languageForPath("functions/tick.mcfunction")).toBe("mcfunction");
	expect(languageForPath("animations/walk.molang")).toBe("molang");
	expect(languageForPath("texts/en_US.lang")).toBe("ini");
	expect(languageForPath("texture.png")).toBe("plaintext");
});

test("isBinary classifies known binary and text files", () => {
	expect(isBinary("textures/icon.png", new Uint8Array([0, 1]))).toBe(true);
	expect(isBinary("sounds/a.ogg", new Uint8Array([0, 1]))).toBe(true);
	expect(isBinary("manifest.json", enc("{}"))).toBe(false);
	expect(isBinary("functions/tick.mcfunction", enc("say hi"))).toBe(false);
});

test("isBinary falls back to a NUL-byte heuristic for unknown extensions", () => {
	expect(isBinary("unknown.bin", new Uint8Array([0, 1, 2]))).toBe(true);
	expect(isBinary("unknown.thing", enc("hello"))).toBe(false);
});
