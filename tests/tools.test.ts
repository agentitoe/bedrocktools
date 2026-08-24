import { test, expect } from "bun:test";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { LANGUAGES } from "../src/shared/ui";

// Bun can import TypeScript files directly, no pre-bundling needed.
const root = process.env.PROJECT_ROOT ?? process.cwd();
const srcToolsDir = join(root, "src", "tools");
const publicToolsDir = join(root, "public", "tools");

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PATH_RE = /^\/tools\/[a-z0-9-]+$/;
const ALLOWED_PLATFORMS = new Set(["java", "bedrock"]);

const slugs = readdirSync(srcToolsDir, { withFileTypes: true })
	.filter((d) => d.isDirectory() && d.name !== "_template")
	.map((d) => d.name);

interface ToolInfo {
	slug: string;
	// The manifest/translations come from dynamically imported bundles, so their
	// shape is untyped at compile time.
	manifest: any;
	translations: any;
	indexSource: string | null;
	hasManifest: boolean;
	hasTranslations: boolean;
	hasIndex: boolean;
}

// Collect everything up front so the assertions below stay synchronous.
const tools: ToolInfo[] = [];
for (const slug of slugs) {
	const toolDir = join(srcToolsDir, slug);
	const hasManifest = existsSync(join(toolDir, "manifest.ts"));
	const hasTranslations = existsSync(join(toolDir, "translations.ts"));
	const hasIndex = existsSync(join(toolDir, "index.ts"));

	// Bun can import TypeScript source files directly.
	let manifest: any;
	if (hasManifest) {
		const mod = await import(`../src/tools/${slug}/manifest.ts`);
		manifest = mod.manifest;
	}

	let translations: any;
	if (hasTranslations) {
		const mod = await import(`../src/tools/${slug}/translations.ts`);
		translations = mod.translations;
	}

	const indexSource: string | null = hasIndex ? readFileSync(join(toolDir, "index.ts"), "utf8") : null;

	tools.push({ slug, manifest, translations, indexSource, hasManifest, hasTranslations, hasIndex });
}

for (const tool of tools) {
	test(`tool "${tool.slug}" has the required files`, () => {
		expect(tool.hasManifest).toBe(true);
		expect(tool.hasIndex).toBe(true);
	});

	test(`tool "${tool.slug}" has a valid manifest`, () => {
		const m = tool.manifest;
		expect(m && typeof m === "object").toBe(true);

		for (const lang of LANGUAGES) {
			expect(typeof m.name?.[lang.code] === "string" && m.name[lang.code].length > 0).toBe(true);
			expect(typeof m.description?.[lang.code] === "string" && m.description[lang.code].length > 0).toBe(true);
		}

		expect(typeof m.icon === "string" && m.icon.length > 0).toBe(true);

		expect(typeof m.path).toBe("string");
		expect(m.path).toMatch(PATH_RE);

		expect(typeof m.color).toBe("string");
		expect(m.color).toMatch(COLOR_RE);

		if (m.platforms !== undefined) {
			expect(Array.isArray(m.platforms) && m.platforms.length > 0).toBe(true);
			for (const platform of m.platforms) {
				expect(ALLOWED_PLATFORMS.has(platform)).toBe(true);
			}
		}
	});

	test(`tool "${tool.slug}" has a page matching its manifest path`, () => {
		const page = join(root, "public", tool.manifest.path, "index.html");
		expect(existsSync(page)).toBe(true);
	});

	test(`tool "${tool.slug}" has consistent translations`, () => {
		if (!tool.hasTranslations) return; // optional: file tools may not have UI copy

		expect(tool.translations && typeof tool.translations === "object").toBe(true);

		for (const lang of LANGUAGES) {
			expect(tool.translations[lang.code]).toBeTruthy();
		}

		const codes = Object.keys(tool.translations);
		const reference = new Set(Object.keys(tool.translations[codes[0]]));
		for (const code of codes) {
			const keys = new Set(Object.keys(tool.translations[code]));
			const missing = [...reference].filter((k) => !keys.has(k));
			const extra = [...keys].filter((k) => !reference.has(k));
			expect({ missing, extra }).toEqual({ missing: [], extra: [] });
		}
	});

	test(`tool "${tool.slug}" index.ts exports an entry point`, () => {
		const source = tool.indexSource;
		expect(source).not.toBeNull();
		if (source === null) return;
		expect(source).toMatch(/export\s+(async\s+)?function\s+\w+/);
	});
}

test("every page directory has a matching tool manifest", () => {
	const pageDirs = readdirSync(publicToolsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(publicToolsDir, d.name, "index.html")))
		.map((d) => d.name);

	const manifestPaths = new Set(tools.map((t) => t.manifest?.path));

	for (const dir of pageDirs) {
		expect(manifestPaths.has(`/tools/${dir}`)).toBe(true);
	}
});
