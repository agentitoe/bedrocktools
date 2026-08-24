import { readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcToolsDir = join(root, "src", "tools");
const outDir = join(root, "public", "tools");
const publicDir = join(root, "public");

const commonBuildOptions = {
	minify: true,
	format: "esm",
	target: "browser",
};

async function buildTool(toolName, toolDir) {
	const indexTs = join(toolDir, "index.ts");
	const toolOutDir = join(outDir, toolName);
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
	mkdirSync(assetsDir, { recursive: true });

	const result = await Bun.build({
		entrypoints: [uiTs],
		outdir: assetsDir,
		target: "browser",
		format: "esm",
		minify: false,
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
	const manifests = [];

	for (const name of toolNames) {
		const manifestTs = join(srcToolsDir, name, "manifest.ts");
		if (!existsSync(manifestTs)) continue;

		try {
			// Bun can import TypeScript files directly — no bundling needed for
			// manifests since they're pure data with no dependencies.
			const mod = await import(manifestTs);
			const manifest = mod.manifest;
			if (manifest) {
				manifests.push({
					name: manifest.name,
					description: manifest.description,
					icon: manifest.icon,
					path: manifest.path,
					color: manifest.color,
					platforms: manifest.platforms || ["bedrock"],
				});
			}
		} catch (err) {
			console.error("Failed to gather manifest for " + name + ":", err.message);
		}
	}

	return manifests;
}

async function main() {
	await buildSharedUi();

	const toolNames = findToolDirs();

	for (const name of toolNames) {
		const toolDir = join(srcToolsDir, name);
		await buildTool(name, toolDir);
	}

	const manifests = await gatherManifests();
	mkdirSync(publicDir, { recursive: true });
	writeFileSync(join(publicDir, "tools-manifest.json"), JSON.stringify(manifests, null, 2));
	console.log("Build complete. Built " + toolNames.length + " tool(s).");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});