// Downloads the webfonts the site uses and writes them to public/fonts/.
//
// public/fonts/ is committed but generated — never edit those files by hand.
// Run this script (or `bun run build`, which calls it) to refresh them.
//
// Fonts come from Google Fonts, which serves different woff2 files per
// unicode-range. We only keep the `latin` and `latin-ext` subsets, since the
// site ships Spanish and English copy and nothing else.

import { mkdirSync, existsSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const fontsDir = join(root, "public", "fonts");

// A modern UA is what makes Google Fonts answer with woff2 instead of the
// legacy ttf/svg formats.
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FONTS = [
	{
		family: "Outfit",
		query: "Outfit:wght@400..800",
		prefix: "outfit",
	},
	{
		family: "JetBrains Mono",
		query: "JetBrains+Mono:wght@400..700",
		prefix: "jetbrains-mono",
	},
];

/** Pull every `/* subset *​/ @font-face { ... }` block out of a Google Fonts stylesheet. */
function parseFontFaces(css) {
	const blocks = [];
	const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
	let match;
	while ((match = re.exec(css)) !== null) {
		const subset = match[1];
		const body = match[2];
		const src = /src:\s*url\(([^)]+)\)/.exec(body);
		const range = /unicode-range:\s*([^;]+);/.exec(body);
		if (!src) continue;
		blocks.push({
			subset,
			url: src[1].trim(),
			unicodeRange: range ? range[1].trim() : null,
		});
	}
	return blocks;
}

async function download(url) {
	const res = await fetch(url, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	return Buffer.from(await res.arrayBuffer());
}

async function main() {
	mkdirSync(fontsDir, { recursive: true });

	for (const font of FONTS) {
		const cssUrl = `https://fonts.googleapis.com/css2?family=${font.query}&display=swap`;
		const css = await (await fetch(cssUrl, { headers: { "User-Agent": UA } })).text();
		const faces = parseFontFaces(css).filter((f) => f.subset === "latin" || f.subset === "latin-ext");

		if (!faces.length) {
			throw new Error(`No latin subsets found for ${font.family} (${cssUrl})`);
		}

		for (const face of faces) {
			const file = `${font.prefix}-${face.subset}.woff2`;
			const target = join(fontsDir, file);
			const bytes = await download(face.url);

			// Keep the download idempotent: skip when the file is already there
			// with the same size.
			if (existsSync(target) && statSync(target).size === bytes.length) {
				console.log(`= ${file} (up to date, ${bytes.length} bytes)`);
				continue;
			}

			writeFileSync(target, bytes);
			console.log(`+ ${file} (${bytes.length} bytes)`);
		}
	}

	console.log("Fonts ready.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
