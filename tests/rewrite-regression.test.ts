import { test, expect } from "bun:test";
import { zipSync, unzipSync } from "fflate";
import { sanitizeZipPath } from "../src/shared/path";
import { stripJsonComments } from "../src/shared/json";
import { encodeUtf8 } from "../src/shared/encoding";
import { buildJavaCommand } from "../src/tools/give-creator/builder";
import type { GiveState } from "../src/tools/give-creator/types";
import { process, processFiles } from "../src/tools/pack-organizer/index";
import { decodeTga } from "../src/tools/recipe-creator/import";
import { isValidCoord } from "../src/tools/coordinates-converter/index";

const enc = (s: string) => encodeUtf8(s);

// ---- 1. sanitizeZipPath rechaza Zip-Slip (`../`, absolutas, drive letters) ----

test("sanitizeZipPath rechaza ../ y rutas absolutas", () => {
	expect(sanitizeZipPath("../evil.json")).toBeNull();
	expect(sanitizeZipPath("a/../../b.json")).toBeNull();
	expect(sanitizeZipPath("/abs/path.json")).toBeNull();
	expect(sanitizeZipPath("C:/win/evil.json")).toBeNull();
	expect(sanitizeZipPath("..\\win\\evil.json")).toBeNull();
	// Las rutas válidas (incluido `..` intermedio que no escapa) sobreviven.
	expect(sanitizeZipPath("textures/a.png")).toBe("textures/a.png");
	expect(sanitizeZipPath("a/../b/c.json")).toBe("b/c.json");
});

// ---- 2. stripJsonComments con terminadores `\r` ----

test("stripJsonComments corta comentarios de línea en \\r y \\r\\n", () => {
	expect(stripJsonComments('{"a":1// comment\r\n,"b":2}')).toBe('{"a":1\r\n,"b":2}');
	expect(stripJsonComments('{"a":1}// cola\r')).toBe('{"a":1}');
	// Los marcadores dentro de strings se siguen preservando.
	expect(stripJsonComments('{"url":"http://a"}// tail\r\n')).toBe('{"url":"http://a"}');
});

// ---- 3. cleanName unicode (pack-organizer preserva acentos/CJK/emoji) ----

function resourcePackZip(name: string): Uint8Array {
	const manifest = JSON.stringify({
		format_version: 2,
		header: { name, uuid: "00000000-0000-0000-0000-000000000000", version: [1, 0, 0] },
		modules: [{ type: "resources", uuid: "00000000-0000-0000-0000-000000000001", version: [1, 0, 0] }],
	});
	return zipSync({ "manifest.json": enc(manifest), "textures/a.txt": enc("hi") });
}

test("process preserva nombres unicode del pack (cleanName)", async () => {
	const out = unzipSync(await process(resourcePackZip("Mí パック 🎮 Test")));
	const keys = Object.keys(out);
	expect(keys.length).toBe(2);
	expect(keys[0]).toContain("Mí パック 🎮 Test");
});

// ---- 4. colisión merge renombra con sufijo `_1` ----

test("processFiles renombra colisiones en el merge (_1)", async () => {
	const merged = unzipSync(await processFiles([resourcePackZip("Pack"), resourcePackZip("Pack")], ["a.mcpack", "b.mcpack"]));
	const keys = Object.keys(merged);
	expect(keys.length).toBe(4);
	expect(keys.filter((k) => /_1\./.test(k)).length).toBe(2);
});

// ---- 5. builder rechaza damage inyectado (solo enteros estrictos) ----

function javaState(damage: string): GiveState {
	return {
		platform: "java",
		target: "@p",
		customTarget: "",
		itemId: "minecraft:diamond_sword",
		count: 1,
		dataValue: 0,
		dataOverridden: false,
		values: { damage },
	};
}

test("buildJavaCommand ignora damage no numérico (anti-inyección SNBT)", () => {
	expect(buildJavaCommand(javaState("5][minecraft:foo=1")).command).toBe("/give @p minecraft:diamond_sword 1");
	expect(buildJavaCommand(javaState("5,foo:1")).command).toBe("/give @p minecraft:diamond_sword 1");
	expect(buildJavaCommand(javaState("500")).command).toBe(
		"/give @p minecraft:diamond_sword[minecraft:damage=500] 1"
	);
});

// ---- 6. TGA gigante rechaza (límite 4096px) ----

function tgaBytes(width: number, height: number, pixelDepth = 32, imageType = 2, withPixels = true): Uint8Array {
	const head = new Uint8Array(18);
	const dv = new DataView(head.buffer);
	dv.setUint8(0, 0); // idLength
	dv.setUint8(1, 0); // colorMapType
	dv.setUint8(2, imageType);
	dv.setUint16(12, width, true);
	dv.setUint16(14, height, true);
	dv.setUint8(16, pixelDepth);
	dv.setUint8(17, 0x20); // origen arriba-izquierda (sin flip vertical)
	if (!withPixels) return head;
	const px = new Uint8Array(width * height * (pixelDepth / 8)).fill(255);
	const out = new Uint8Array(head.length + px.length);
	out.set(head);
	out.set(px, head.length);
	return out;
}

test("decodeTga rechaza dimensiones gigantes o nulas y acepta un TGA válido", () => {
	expect(decodeTga(tgaBytes(5000, 5000, 32, 2, false))).toBeNull();
	expect(decodeTga(tgaBytes(0, 16, 32, 2, false))).toBeNull();
	const ok = decodeTga(tgaBytes(2, 2));
	expect(ok).not.toBeNull();
	expect(ok!.width).toBe(2);
	expect(ok!.height).toBe(2);
	expect(ok!.pixels.length).toBe(2 * 2 * 4);
});

// ---- 7. coords Infinity inválido (isValidCoord del rewrite) ----

test("isValidCoord rechaza Infinity/NaN/fuera del world-border", () => {
	expect(isValidCoord(Infinity)).toBe(false);
	expect(isValidCoord(-Infinity)).toBe(false);
	expect(isValidCoord(NaN)).toBe(false);
	expect(isValidCoord(30_000_001)).toBe(false);
	expect(isValidCoord(100)).toBe(true);
	expect(isValidCoord(-30_000_000)).toBe(true);
});
