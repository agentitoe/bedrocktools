# Contributing to Bedrock Tools

Thanks for taking an interest. This is a small static site — a set of Minecraft tools written in plain TypeScript, HTML and CSS — so it should be quick to get comfortable with.

## Getting started

1. Fork and clone the repo.
2. `npm install`
3. `npm run dev`, then open [http://localhost:8788/](http://localhost:8788/).

## Before opening a PR

There's no test suite, so the gate is a typecheck plus a quick manual check in the browser:

```bash
npx tsc --noEmit
node scripts/build.mjs
```

Then actually try the change in the browser — the dev server reads files from disk, so a refresh shows built changes.

## Conventions

- **TypeScript** for all tool logic. Markup lives in the HTML pages, styles in CSS.
- **Tabs** for indentation, matching the rest of the codebase.
- **Comments in English.**
- **Every user-facing string goes through the i18n system.** Add `en` but if you can, add `es` as well (see `src/shared/ui.ts` and any tool's `translations.ts`). Don't hardcode copy in markup or code.
- Tools are self-contained: one folder under `src/tools/<slug>/`, one page under `public/tools/<slug>/`.

## Adding a tool

Duplicate `src/tools/_template`, fill in `manifest.ts`, export `init()` for UI tools (or a byte-processing function for file tools), and add the page. The full walkthrough is in the README under "Adding a tool".

## Adding a language

Add the language to `LANGUAGES` in `src/shared/ui.ts`, then a translations object to each tool/page. The README has the details.

## Data and generated files

- `public/data/`, `public/textures/` and `public/fonts/` are committed but generated — don't edit them by hand.
- Regenerate them with `npm run build` (or the individual scripts). It downloads from the Minecraft assets repo, so it's slow and needs network.
- `public/tools/*/bundle.js`, `public/assets/ui.js` and `public/tools-manifest.json` are generated and git-ignored — don't commit them.

## Pull requests

- One logical change per PR, with a short note on what and why.
- If you change behaviour or add copy, check both languages.
- Keep the diff focused; unrelated formatting changes are best left out.

## Reporting issues

Bug reports and feature ideas are welcome. Include your browser and OS, steps to reproduce, and what you expected versus what happened.
