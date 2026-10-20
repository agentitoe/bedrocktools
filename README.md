<p align="center">
  <img src="https://raw.githubusercontent.com/agentitoe/bedrocktools/main/public/assets/favicon.svg" alt="Bedrock Tools logo" width="128">
</p>

<h1 align="center">Bedrock Tools</h1>

<p align="center">
  Minecraft utilities for <b>Java</b> and <b>Bedrock</b> that run entirely in your browser.<br>
  No accounts, no backend, no tracking.
</p>

<p align="center">
  <a href="https://github.com/agentitoe/bedrocktools">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/agentitoe/bedrocktools?style=flat-square&logo=github">
  </a>
  <a href="https://www.codefactor.io/repository/github/agentitoe/bedrocktools/overview/main">
    <img alt="CodeFactor Score" src="https://www.codefactor.io/repository/github/agentitoe/bedrocktools/badge/main">
  </a>
  <a href="https://github.com/agentitoe/bedrocktools">
    <img alt="Last commit" src="https://img.shields.io/github/last-commit/agentitoe/bedrocktools?style=flat-square">
  </a>
  <a href="https://github.com/agentitoe/bedrocktools/blob/main/LICENSE">
    <img alt="License" src="https://img.shields.io/badge/License-GPL--3.0-2f9e44?style=flat-square">
  </a>
  <a href="https://bedrocktools.pages.dev">
    <img alt="Website" src="https://img.shields.io/badge/website-bedrocktools.pages.dev-F38020?style=flat-square&logo=cloudflare&logoColor=white">
  </a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-%23000000.svg?style=flat-square&logo=bun&logoColor=white">
  <img alt="HTML5" src="https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white">
  <img alt="CSS3" src="https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white">
</p>

---

## What's inside

| Icon | Tool                   | Path                           | Platform       | Description                                                                                 |
| ---- | ---------------------- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------------- |
| 🛠️   | Addon Converter        | `/tools/addon-converter`       | Bedrock        | Re-saves `.mcpack` / `.mcaddon` files so achievements stay active on Xbox.                  |
| 📦   | Pack Organizer         | `/tools/pack-organizer`        | Bedrock        | Rearranges `.mcpack` / `.mcaddon` / `.mcworld` into the `com.mojang` layout Xbox expects.   |
| 🧱   | Items & Blocks         | `/tools/minecraft-items`       | Java + Bedrock | Every item and block, with crafting recipes and rendered icons.                             |
| ⚒️   | Recipe Creator         | `/tools/recipe-creator`        | Java + Bedrock | Writes custom recipes — a `.mcpack` for Bedrock or a Data Pack for Java.                    |
| 🗺️   | Coordinates Calculator | `/tools/coordinates-converter` | Java + Bedrock | Overworld ↔ Nether coordinates, using the 1:8 rule.                                         |
| 🎁   | /give Generator        | `/tools/give-creator`          | Java + Bedrock | Builds custom `/give` commands: name, lore, enchantments, attributes, potions and more.     |
| 🧩   | Addon Editor           | `/tools/addon-editor`          | Bedrock        | Create and edit Behavior/Resource Packs with a file tree, code editor and a final download. |

It's a purely static site: each tool is just an HTML page plus a small ES module bundle, and all the actual work happens client-side.

## Run it locally

You'll need [Bun](https://bun.sh/).

```bash
bun install
bun run dev
```

Open [http://localhost:8788/](http://localhost:8788/) — or `PORT=3000 bun run dev` to pick another port.

`bun run dev` compiles the tools, then serves `public/` with the tiny built-in server in `scripts/serve.mjs`. It reads files straight from disk, so edits to already-built assets show up on refresh; it does **not** watch or auto-rebuild `.ts` sources, so re-run the build when you change those.

## Scripts

| Command          | Purpose                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `bun run build`  | Rebuilds the bundles **and** regenerates the Minecraft data (slow, needs network). |
| `bun run build:wasm` | Rebuilds the WebAssembly modules for the Seed Map tool (needs Emscripten).     |
| `bun run dev`    | Build, then serve locally.                                                         |
| `bun run deploy` | Push `public/` to Cloudflare Pages.                                                |

The full data pipeline is rarely needed day-to-day — the generated data and textures are committed:

```bash
bun scripts/build.mjs && bun scripts/serve.mjs
```

### What `bun run build` does

1. **`scripts/build.mjs`** — bundles each tool into `public/tools/<slug>/bundle.js`, compiles `src/shared/ui.ts` into `public/assets/ui.js`, and writes `public/tools-manifest.json`.
2. **`scripts/fetch-fonts.mjs`** — downloads the Outfit + JetBrains Mono subsets (latin + latin-ext) into `public/fonts/`.
3. **`scripts/extract-data.mjs`** — downloads Minecraft 26.1 models, textures and recipes from GitHub and writes `public/data/*.json` + `public/textures/*.webp`.
4. **`scripts/translate-items.mjs`** — stamps the Spanish `displayNameEs` onto `public/data/items.json`.
5. **`scripts/fetch-geyser-mappings.mjs`** — refreshes the Java↔Bedrock id map.

`public/data/`, `public/textures/` and `public/fonts/` live in git, so a clean clone runs out of the box. The bundles and the manifest are git-ignored and rebuilt on demand.

### WebAssembly (Seed Map)

The Seed Map tool computes biomes with [cubiomes](https://github.com/xpple/cubiomes), an actively maintained fork of Cubitect's cubiomes (MIT), vendored as the `third_party/cubiomes` submodule and compiled to WebAssembly into `public/wasm/`.

The compiled `.wasm` artifacts and their glue `.mjs` modules are committed, so building or running the site does **not** require `git clone --recursive` and does **not** require Emscripten. `third_party/cubiomes/` sits next to them for provenance only: pin it, update it, recompile and commit the new artifacts — you rarely need it locally.

`bun scripts/build-wasm.mjs` (or `bun run build:wasm`) recompiles both modules ([Emscripten](https://emscripten.org) required):

1. **`biomes-java-gen.wasm`** — the cubiomes engine plus the narrow `third_party/cubiomes-extensions` bindings.
2. **`bedrock-structures.wasm`** — a `br_find` placeholder until the real Bedrock RNG module lands.

It also rewrites `public/wasm/checksums.json` (SHA-256 per artifact) and, at startup, verifies existing artifacts against it: a corrupted `.wasm` fails the build. Delete the corrupted file or pass `--force` to regenerate.

The submodule pin is not part of the normal build pipeline — treat `public/wasm/` as the source of truth, like `public/data/`.

### Design system

All visual rules live in **`public/assets/styles.css`**: the palette, radii, shadows, type scale, the top bar, buttons, cards, drop zone, status states, the home hero/sections/bento and the footer. A tool stylesheet must only add what is unique to that tool — never redefine the shared components.

- **Type:** Outfit (UI + display), JetBrains Mono (code/ids), Press Start 2P (brand accents only — the hero wordmark and the footer mark).
- **Colour:** grass green is the single accent; gold is reserved for small "attention" states. Every grey shares one cool hue, and shadows are tinted with the background hue instead of pure black.
- **Icons:** `public/assets/icons.svg` holds the whole icon set as `<symbol>`s. Reference them with `<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-name"/></svg>` from markup and JS. Never use emoji for UI chrome.
- **New shared component?** Add it to the shared stylesheet, use the tokens, and keep the z-index scale (`--z-drawer` / `--z-overlay` / `--z-toast`) intact.

### 404 page

`public/404.html` is served by Cloudflare Pages for unknown paths. It is hand-written HTML (no script bundle), so its copy lives inline in the file.

### Social image

`public/assets/og.png` is the source for the `og:image` / `twitter:image` tags. It is rendered from `public/assets/og.html` with plain headless Chrome (no browser-automation session involved; set `CHROME_BIN` if Chrome is not on the default paths):

```bash
bun run build:og
```

## Layout

```
src/
  shared/              ui.ts (language + theme + dropdowns), plus encoding/json/path helpers
  tools/<slug>/        one folder per tool — index.ts, manifest.ts, translations.ts, ...
  tools/_template/     copy this to start a new tool
scripts/
  build.mjs            bundling + ui.js + tools-manifest.json
  extract-data.mjs     Minecraft data and textures
  translate-items.mjs  Spanish item names
  serve.mjs            local static server
public/
  index.html           home page
  assets/              shared styles, favicon, generated ui.js / app.js
  data/                generated JSON (committed)
  textures/            generated WebP (committed)
  wasm/                compiled WebAssembly artifacts (committed)
  tools/<slug>/        each tool's page and bundle.js
third_party/
  cubiomes/            git submodule pinned to xpple/cubiomes (MIT)
  cubiomes-extensions/ our C99 bindings layered on cubiomes (compiled into public/wasm/)
```

## Languages

`src/shared/ui.ts` owns the language switcher, theme toggle and dropdown (and is compiled to `public/assets/ui.js` for the pages that don't bundle it).

- `LANGUAGES` lists every supported language.
- `FALLBACK_LANG` is the last resort.
- `initUi(translations)` builds the menu, applies the active language/theme and wires the toggles. A page always lands on a language it actually has; untranslated ones show up disabled.

The site ships in Spanish and English; every user-facing string lives in each tool's `translations.ts` rather than in the markup.

## Contributing

Bugs, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions, the PR checklist, and how to add a new tool or language.

## License

[GPL-3.0](LICENSE) © 2026 agentitoe
