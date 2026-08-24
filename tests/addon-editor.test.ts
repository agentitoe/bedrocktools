import { test } from "node:test";
import assert from "node:assert/strict";
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
	assert.deepEqual(Object.keys(out).sort(), ["manifest.json", "textures/a.png"]);
	assert.equal(decodeUtf8Sig(out["manifest.json"]), "{}");
});

test("unzipPack skips directory entries", () => {
	// A zip containing a directory entry (key ends with "/") and a file.
	const withDir: FileMap = { "textures/": new Uint8Array(0), "manifest.json": enc("{}") };
	const zip = zipPack(withDir);
	const out = unzipPack(zip);
	assert.deepEqual(Object.keys(out), ["manifest.json"]);
});

// ---- pack.ts: path helpers ----

test("joinPath joins a directory and a name", () => {
	assert.equal(joinPath("", "manifest.json"), "manifest.json");
	assert.equal(joinPath("textures/", "a.png"), "textures/a.png");
});

test("dirOf returns the parent directory with a trailing slash", () => {
	assert.equal(dirOf("manifest.json"), "");
	assert.equal(dirOf("textures/a.png"), "textures/");
	assert.equal(dirOf("a/b/c.json"), "a/b/");
});

test("baseName returns the last segment and strips trailing slashes", () => {
	assert.equal(baseName("textures/a.png"), "a.png");
	assert.equal(baseName("textures/"), "textures");
	assert.equal(baseName("manifest.json"), "manifest.json");
});

test("sanitizeName strips unsafe characters", () => {
	assert.equal(sanitizeName("My Pack!"), "My Pack");
	assert.equal(sanitizeName("   "), "my_pack");
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
	assert.deepEqual(listDir(files, explicit, ""), {
		folders: ["functions", "sounds", "textures"],
		files: ["manifest.json"],
	});
	assert.deepEqual(listDir(files, explicit, "textures/"), {
		folders: ["blocks"],
		files: ["a.png"],
	});
});

// ---- pack.ts: detection ----

function manifestWith(type: string): string {
	return JSON.stringify({ format_version: 2, modules: [{ type }] });
}

test("detectKind classifies behavior, resource and addon packs", () => {
	assert.equal(detectKind({ "manifest.json": enc(manifestWith("data")) }), "behavior");
	assert.equal(detectKind({ "manifest.json": enc(manifestWith("resources")) }), "resource");
	assert.equal(
		detectKind({
			"BP/manifest.json": enc(manifestWith("data")),
			"RP/manifest.json": enc(manifestWith("resources")),
		}),
		"addon"
	);
	assert.equal(detectKind({ "README.txt": enc("hi") }), "other");
});

test("manifestName reads header.name", () => {
	const m = JSON.stringify({ header: { name: "Cool Pack" }, modules: [] });
	assert.equal(manifestName({ "manifest.json": enc(m) }), "Cool Pack");
	assert.equal(manifestName({}), null);
});

test("downloadName picks the right extension", () => {
	assert.equal(downloadName({ "manifest.json": enc(manifestWith("data")) }), "my_pack.mcpack");
	const addon: FileMap = {
		"BP/manifest.json": enc(JSON.stringify({ header: { name: "Cool" }, modules: [{ type: "data" }] })),
		"RP/manifest.json": enc(JSON.stringify({ header: { name: "Cool" }, modules: [{ type: "resources" }] })),
	};
	assert.equal(downloadName(addon), "Cool.mcaddon");
});

// ---- templates.ts ----

test("behavior template has a data manifest and starter files", () => {
	const files = buildTemplate("behavior", "My Pack");
	assert.ok(files["manifest.json"]);
	assert.ok(files["functions/example.mcfunction"]);
	assert.ok(files["texts/en_US.lang"]);
	const manifest = JSON.parse(decodeUtf8Sig(files["manifest.json"]));
	assert.equal(manifest.modules[0].type, "data");
	assert.equal(manifest.header.name, "My Pack");
});

test("resource template has a resources manifest", () => {
	const files = buildTemplate("resource", "RP");
	const manifest = JSON.parse(decodeUtf8Sig(files["manifest.json"]));
	assert.equal(manifest.modules[0].type, "resources");
});

test("addon template nests both packs", () => {
	const files = buildTemplate("addon", "My Addon");
	const bp = JSON.parse(decodeUtf8Sig(files["behavior_pack/manifest.json"]));
	const rp = JSON.parse(decodeUtf8Sig(files["resource_pack/manifest.json"]));
	assert.equal(bp.modules[0].type, "data");
	assert.equal(rp.modules[0].type, "resources");
});

test("template uuids are unique", () => {
	const files = buildTemplate("behavior", "P");
	const manifest = JSON.parse(decodeUtf8Sig(files["manifest.json"]));
	const uuids = [manifest.header.uuid, manifest.modules[0].uuid];
	assert.equal(new Set(uuids).size, 2);
	for (const u of uuids) assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ---- monaco.ts ----

test("languageForPath maps file extensions to Monaco languages", () => {
	assert.equal(languageForPath("manifest.json"), "json");
	assert.equal(languageForPath("scripts/main.js"), "javascript");
	assert.equal(languageForPath("functions/tick.mcfunction"), "mcfunction");
	assert.equal(languageForPath("animations/walk.molang"), "molang");
	assert.equal(languageForPath("texts/en_US.lang"), "ini");
	assert.equal(languageForPath("texture.png"), "plaintext");
});

test("isBinary classifies known binary and text files", () => {
	assert.equal(isBinary("textures/icon.png", new Uint8Array([0, 1])), true);
	assert.equal(isBinary("sounds/a.ogg", new Uint8Array([0, 1])), true);
	assert.equal(isBinary("manifest.json", enc("{}")), false);
	assert.equal(isBinary("functions/tick.mcfunction", enc("say hi")), false);
});

test("isBinary falls back to a NUL-byte heuristic for unknown extensions", () => {
	assert.equal(isBinary("unknown.bin", new Uint8Array([0, 1, 2])), true);
	assert.equal(isBinary("unknown.thing", enc("hello")), false);
});
