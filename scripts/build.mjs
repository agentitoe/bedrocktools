import * as esbuild from "esbuild";
import { readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcToolsDir = join(root, "src", "tools");
const outDir = join(root, "public", "tools");
const publicDir = join(root, "public");

const commonBuildOptions = {
	bundle: true,
	minify: true,
	format: "esm",
	platform: "browser",
	target: ["es2021"],
};

async function buildTool(toolName, toolDir) {
	const indexTs = join(toolDir, "index.ts");
	const toolOutDir = join(outDir, toolName);
	mkdirSync(toolOutDir, { recursive: true });
	const outfile = join(toolOutDir, "bundle.js");

	console.log("Building " + toolName + "...");
	await esbuild.build({
		entryPoints: [indexTs],
		outfile: outfile,
		...commonBuildOptions,
	});
}

async function buildSharedUi() {
	const uiTs = join(root, "src", "shared", "ui.ts");
	const assetsDir = join(publicDir, "assets");
	mkdirSync(assetsDir, { recursive: true });
	await esbuild.build({
		entryPoints: [uiTs],
		outfile: join(assetsDir, "ui.js"),
		bundle: true,
		minify: false,
		format: "esm",
		platform: "browser",
		target: ["es2021"],
	});
}

function findToolDirs() {
	const entries = readdirSync(srcToolsDir);
	return entries
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
			const result = await esbuild.build({
				entryPoints: [manifestTs],
				write: false,
				format: "cjs",
				platform: "node",
			});
			const code = result.outputFiles[0].text;
			const fn = new Function("exports", "require", "module", code);
			const mod = { exports: {} };
			fn(mod.exports, () => {
				throw new Error("require not available in manifest");
			}, mod);
			const manifest = mod.exports.manifest || mod.exports.default;
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