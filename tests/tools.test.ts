import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { LANGUAGES } from "../src/shared/ui";

// The test runner (scripts/test.mjs) sets PROJECT_ROOT and pre-bundles each
// tool's manifest/translations into .test-dist/tools/<slug>/.
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

	// Import the pre-bundled modules by absolute file URL so esbuild leaves the
	// dynamic import alone (it would otherwise try to resolve the glob at build time).
	let manifest: any;
	if (hasManifest) {
		const mod = await import(pathToFileURL(join(root, ".test-dist", "tools", slug, "manifest.mjs")).href);
		manifest = mod.manifest;
	}

	let translations: any;
	if (hasTranslations) {
		const mod = await import(pathToFileURL(join(root, ".test-dist", "tools", slug, "translations.mjs")).href);
		translations = mod.translations;
	}

	const indexSource: string | null = hasIndex ? readFileSync(join(toolDir, "index.ts"), "utf8") : null;

	tools.push({ slug, manifest, translations, indexSource, hasManifest, hasTranslations, hasIndex });
}

for (const tool of tools) {
	test(`tool "${tool.slug}" has the required files`, () => {
		assert.ok(tool.hasManifest, "missing manifest.ts");
		assert.ok(tool.hasIndex, "missing index.ts");
	});

	test(`tool "${tool.slug}" has a valid manifest`, () => {
		const m = tool.manifest;
		assert.ok(m && typeof m === "object", "manifest.ts must export a `manifest` object");

		for (const lang of LANGUAGES) {
			assert.ok(
				typeof m.name?.[lang.code] === "string" && m.name[lang.code].length > 0,
				`manifest.name.${lang.code} must be a non-empty string`
			);
			assert.ok(
				typeof m.description?.[lang.code] === "string" && m.description[lang.code].length > 0,
				`manifest.description.${lang.code} must be a non-empty string`
			);
		}

		assert.ok(typeof m.icon === "string" && m.icon.length > 0, "manifest.icon must be a non-empty string");

		assert.equal(typeof m.path, "string", "manifest.path must be a string");
		assert.match(m.path, PATH_RE, `manifest.path "${m.path}" must look like /tools/<slug>`);

		assert.equal(typeof m.color, "string", "manifest.color must be a string");
		assert.match(m.color, COLOR_RE, `manifest.color "${m.color}" must be #RRGGBB`);

		if (m.platforms !== undefined) {
			assert.ok(Array.isArray(m.platforms) && m.platforms.length > 0, "manifest.platforms must be a non-empty array");
			for (const platform of m.platforms) {
				assert.ok(ALLOWED_PLATFORMS.has(platform), `unknown platform "${platform}"`);
			}
		}
	});

	test(`tool "${tool.slug}" has a page matching its manifest path`, () => {
		const page = join(root, "public", tool.manifest.path, "index.html");
		assert.ok(existsSync(page), `missing page at public${tool.manifest.path}/index.html`);
	});

	test(`tool "${tool.slug}" has consistent translations`, () => {
		if (!tool.hasTranslations) return; // optional: file tools may not have UI copy

		assert.ok(tool.translations && typeof tool.translations === "object", "translations.ts must export a `translations` object");

		for (const lang of LANGUAGES) {
			assert.ok(tool.translations[lang.code], `missing "${lang.code}" translations`);
		}

		const codes = Object.keys(tool.translations);
		const reference = new Set(Object.keys(tool.translations[codes[0]]));
		for (const code of codes) {
			const keys = new Set(Object.keys(tool.translations[code]));
			const missing = [...reference].filter((k) => !keys.has(k));
			const extra = [...keys].filter((k) => !reference.has(k));
			assert.deepEqual(
				{ missing, extra },
				{ missing: [], extra: [] },
				`language "${code}" keys differ from "${codes[0]}"`
			);
		}
	});

	test(`tool "${tool.slug}" index.ts exports an entry point`, () => {
		const source = tool.indexSource;
		if (source === null) {
			assert.fail("missing index.ts");
			return;
		}
		assert.match(source, /export\s+(async\s+)?function\s+\w+/, "index.ts must export at least one function");
	});
}

test("every page directory has a matching tool manifest", () => {
	const pageDirs = readdirSync(publicToolsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(publicToolsDir, d.name, "index.html")))
		.map((d) => d.name);

	const manifestPaths = new Set(tools.map((t) => t.manifest?.path));

	for (const dir of pageDirs) {
		assert.ok(manifestPaths.has(`/tools/${dir}`), `public/tools/${dir} has no manifest with path "/tools/${dir}"`);
	}
});
