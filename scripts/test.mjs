import * as esbuild from "esbuild";
import { readdirSync, rmSync, existsSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const testsDir = join(root, "tests");
const srcToolsDir = join(root, "src", "tools");
const outDir = join(root, ".test-dist");

const nodeBuildOptions = {
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	logLevel: "warning",
};

/** Every tool folder under src/tools, excluding the reference template. */
function findToolSlugs() {
	return readdirSync(srcToolsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name !== "_template")
		.map((d) => d.name);
}

async function main() {
	const testEntryPoints = readdirSync(testsDir)
		.filter((f) => f.endsWith(".test.ts"))
		.map((f) => join(testsDir, f));

	if (testEntryPoints.length === 0) {
		console.error("No *.test.ts files found in tests/");
		process.exit(1);
	}

	rmSync(outDir, { recursive: true, force: true });

	// Build the unit tests themselves.
	await esbuild.build({
		entryPoints: testEntryPoints,
		outdir: outDir,
		outExtension: { ".js": ".mjs" },
		...nodeBuildOptions,
	});

	// Build each tool's manifest + translations so the general test
	// (tests/tools.test.ts) can inspect them without executing browser code.
	for (const slug of findToolSlugs()) {
		const toolDir = join(srcToolsDir, slug);
		const toolOutDir = join(outDir, "tools", slug);
		mkdirSync(toolOutDir, { recursive: true });

		const manifestTs = join(toolDir, "manifest.ts");
		if (existsSync(manifestTs)) {
			await esbuild.build({
				entryPoints: [manifestTs],
				outfile: join(toolOutDir, "manifest.mjs"),
				...nodeBuildOptions,
			});
		}

		const translationsTs = join(toolDir, "translations.ts");
		if (existsSync(translationsTs)) {
			await esbuild.build({
				entryPoints: [translationsTs],
				outfile: join(toolOutDir, "translations.mjs"),
				...nodeBuildOptions,
			});
		}
	}

	const testFiles = testEntryPoints.map((f) => join(outDir, basename(f).replace(/\.ts$/, ".mjs")));

	const result = spawnSync(process.execPath, ["--test", ...testFiles], {
		stdio: "inherit",
		env: { ...process.env, PROJECT_ROOT: root },
	});
	process.exit(result.status ?? 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
