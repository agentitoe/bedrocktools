import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcToolsDir = join(root, "src", "tools");
const srcSharedDir = join(root, "src", "shared");
const outDir = join(root, "public", "tools");
const publicDir = join(root, "public");

const POOL_SIZE = 4;

const commonBuildOptions = {
	minify: true,
	format: "esm",
	target: "browser",
};

async function buildTool(toolName, toolDir) {
	const indexTs = join(toolDir, "index.ts");
	const toolOutDir = join(outDir, toolName);
	const bundleJs = join(toolOutDir, "bundle.js");
	if (isUpToDate(bundleJs, collectToolSources(toolDir))) {
		console.log("Skipping " + toolName + " (up to date)...");
		return;
	}
	mkdirSync(toolOutDir, { recursive: true });

	console.log("Building " + toolName + "...");
	const result = await Bun.build({
		entrypoints: [indexTs],
		outdir: toolOutDir,
		naming: { entry: "bundle.[ext]" },
		...commonBuildOptions,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`Build failed for ${toolName}`);
	}
}

async function buildSharedUi() {
	const uiTs = join(root, "src", "shared", "ui.ts");
	const assetsDir = join(publicDir, "assets");
	const bundleJs = join(assetsDir, "ui.js");
	if (isUpToDate(bundleJs, [uiTs])) {
		console.log("Skipping shared UI (up to date)...");
		return;
	}
	mkdirSync(assetsDir, { recursive: true });

	console.log("Building shared UI...");
	const result = await Bun.build({
		entrypoints: [uiTs],
		outdir: assetsDir,
		naming: { entry: "ui.[ext]" },
		...commonBuildOptions,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("Build failed for shared UI");
	}
}

function findToolDirs() {
	return readdirSync(srcToolsDir)
		.filter((name) => name !== "_template")
		.filter((name) => {
			const toolDir = join(srcToolsDir, name);
			return statSync(toolDir).isDirectory();
		})
		.filter((name) => {
			return existsSync(join(srcToolsDir, name, "index.ts"));
		});
}

async function gatherManifests() {
	const toolNames = findToolDirs();

	const results = await Promise.all(
		toolNames.map(async (name) => {
			const manifestTs = join(srcToolsDir, name, "manifest.ts");
			if (!existsSync(manifestTs)) return null;

			try {
				// Bun can import TypeScript files directly — no bundling needed for
				// manifests since they're pure data with no dependencies.
				const mod = await import(manifestTs);
				const manifest = mod.manifest;
				if (manifest) {
					return {
						name: manifest.name,
						description: manifest.description,
						icon: manifest.icon,
						path: manifest.path,
						color: manifest.color,
						platforms: manifest.platforms || ["bedrock"],
					};
				}
			} catch (err) {
				console.error("Failed to gather manifest for " + name + ":", err.message);
			}
			return null;
		}),
	);

	return results.filter(Boolean);
}

/** Run async task factories with at most `limit` concurrent workers. */
async function runPool(factories, limit) {
	const results = new Array(factories.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, factories.length) || 1 },
		async () => {
			while (next < factories.length) {
				const idx = next++;
				results[idx] = await factories[idx]();
			}
		},
	);
	await Promise.all(workers);
	return results;
}

/** All `.ts` sources that can affect a tool bundle (tool + shared). */
function collectToolSources(toolDir) {
	const sources = [];
	try {
		for (const entry of readdirSync(toolDir)) {
			if (entry.endsWith(".ts")) sources.push(join(toolDir, entry));
		}
	} catch {
		/* ignore unreadable dirs; build will surface the error */
	}
	try {
		for (const entry of readdirSync(srcSharedDir)) {
			if (entry.endsWith(".ts")) sources.push(join(srcSharedDir, entry));
		}
	} catch {
		/* shared dir missing: nothing extra to track */
	}
	return sources;
}

/**
 * Incremental skip: true when `outFile` exists and is newer than every
 * source file. Keeps outputs identical while skipping redundant rebuilds.
 */
function isUpToDate(outFile, srcFiles) {
	if (!existsSync(outFile)) return false;
	let outMtime;
	try {
		outMtime = statSync(outFile).mtimeMs;
	} catch {
		return false;
	}
	for (const src of srcFiles) {
		try {
			if (statSync(src).mtimeMs > outMtime) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** openapi.yaml (root) is the single source of truth: copy + JSON to public/. */
async function syncOpenApi() {
	const srcYaml = join(root, "openapi.yaml");
	if (!existsSync(srcYaml)) return;
	const yamlText = readFileSync(srcYaml, "utf8");
	mkdirSync(publicDir, { recursive: true });
	writeFileSync(join(publicDir, "openapi.yaml"), yamlText);
	try {
		const { load } = await import("js-yaml");
		const data = load(yamlText);
		writeFileSync(join(publicDir, "openapi.json"), JSON.stringify(data, null, 2) + "\n");
		console.log("Synced public/openapi.yaml + public/openapi.json from openapi.yaml");
	} catch (err) {
		console.error("Failed to sync OpenAPI JSON:", err?.message ?? err);
	}
}

async function main() {
	await buildSharedUi();

	const toolNames = findToolDirs();

	await runPool(
		toolNames.map((name) => () => buildTool(name, join(srcToolsDir, name))),
		POOL_SIZE,
	);

	const manifests = await gatherManifests();
	mkdirSync(publicDir, { recursive: true });
	writeFileSync(join(publicDir, "tools-manifest.json"), JSON.stringify(manifests, null, 2));
	await syncOpenApi();
	console.log("Build complete. Built " + toolNames.length + " tool(s).");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});