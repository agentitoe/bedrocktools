import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";

/*
 * WebAssembly build for the Seed Map tool (plan E1, tareas 1.3/1.4).
 *
 * Produces two ES modules in public/wasm/:
 *   - biomes-java-gen.wasm (+ .mjs glue) — cubiomes submodule + our narrow
 *     ext_bindings wrapper (third_party/cubiomes-extensions). Loot tables and
 *     test runners are excluded from the build to keep the binary lean.
 *   - bedrock-structures.wasm (+ .mjs glue) — placeholder br_find stub until
 *     plan E5 replaces it with the real Bedrock RNG module.
 *
 * Also writes public/wasm/checksums.json (SHA-256 per artifact). The committed
 * artifacts are the SSOT; this script is only run when the submodule or the
 * extensions change, then the new artifacts + checksums are committed.
 *
 * Integrity gate: when checksums.json already exists, the script verifies the
 * current on-disk artifacts before doing anything else. A corrupted .wasm
 * aborts the build (delete the corrupted file to force a clean rebuild, or
 * pass --force if you know the regeneration is intended).
 *
 * Requires Emscripten. Resolve order for the compiler driver:
 *   1. --emcc <path> CLI option
 *   2. EMCC environment variable
 *   3. <EMSDK>/upstream/emscripten/emcc.exe (Windows) or emcc (POSIX)
 *   4. <home>/emsdk/upstream/emscripten/emcc.exe (Windows fallback, no env needed)
 *   5. `where emcc` / `which emcc` on PATH
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "public", "wasm");
const cubiomesDir = join(root, "third_party", "cubiomes");
const extensionsDir = join(root, "third_party", "cubiomes-extensions");

const checksumFile = join(outDir, "checksums.json");
const artifacts = ["biomes-java-gen.mjs", "biomes-java-gen.wasm", "bedrock-structures.mjs", "bedrock-structures.wasm"];

// Settings that are identical for both modules. WASM_ASYNC_COMPILATION=0 keeps
// instantiation synchronous so a Worker can flatten reset(seed) barriers.
const moduleFlagGroups = {
	biomes: [
		"-O3",
		"-msimd128",
		"-fwrapv",
		"-DNDEBUG",
		// cubiomes uses anonymous struct/union members (C11), so the compiler
		// default (gnu17) is kept — no -std override.
		"-I" + join("third_party", "cubiomes"),
		"-I" + join("third_party", "cubiomes-extensions"),
		"-sMODULARIZE",
		"-sEXPORT_ES6",
		"-sENVIRONMENT=worker",
		"-sALLOW_MEMORY_GROWTH=1",
		"-sWASM_ASYNC_COMPILATION=0",
		"-sSTACK_SIZE=2097152", // cubiomes recurses through the layer stack / noise octaves
		"--no-entry",
		"-sEXPORTED_FUNCTIONS=[_ext_set_seed,_ext_gen_biome_tile,_ext_find_structures,_ext_find_strongholds,_ext_get_structure_config,_ext_get_spawn,_ext_ensure_cache,_malloc,_free]",
		// Heap views are exposed for zero-copy buffers; the JS bridge allocates
		// once per worker and reuses the views (HEAP32 = Int32Array over the
		// heap, HEAPU8 = Uint8Array).
		"-sEXPORTED_RUNTIME_METHODS=[HEAPU8,HEAP32]",
	],
	bedrock: [
		"-O2",
		"-DNDEBUG",
		"-I" + join("third_party", "cubiomes-extensions"),
		"-sMODULARIZE",
		"-sEXPORT_ES6",
		"-sENVIRONMENT=worker",
		"-sWASM_ASYNC_COMPILATION=0",
		"--no-entry",
		"-sEXPORTED_FUNCTIONS=[_br_find]",
	],
};

function parseArgs(argv) {
	const opts = { emcc: null, force: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--emcc" && i + 1 < argv.length) {
			opts.emcc = argv[++i];
		} else if (argv[i] === "--force") {
			opts.force = true;
		} else {
			console.error("Unknown option: " + argv[i]);
			console.error("Usage: bun scripts/build-wasm.mjs [--emcc <path>] [--force]");
			process.exit(1);
		}
	}
	return opts;
}

function isWindows() {
	return platform() === "win32";
}

function findUpstreamEmcc() {
	const fileName = isWindows() ? "emcc.exe" : "emcc";
	if (process.env.EMSDK) {
		return join(process.env.EMSDK, "upstream", "emscripten", fileName);
	}
	// Windows fallback: the emsdk default location does not require any
	// environment variables to invoke emcc.exe directly.
	if (isWindows()) {
		return join(homedir(), "emsdk", "upstream", "emscripten", "emcc.exe");
	}
	return null;
}

function findOnPathEmcc() {
	const command = isWindows() ? "where" : "which";
	const probe = Bun.spawnSync([command, "emcc"], { cwd: root });
	if (probe.exitCode !== 0) return null;
	const lines = probe.stdout.toString().trim().split(/\r?\n/);
	const existing = lines.map((l) => l.trim()).filter((l) => l.length > 0 && existsSync(l));
	return existing.length > 0 ? existing[0] : null;
}

function resolveEmcc(opts) {
	const candidates = [
		opts.emcc,
		process.env.EMCC || null,
		findUpstreamEmcc(),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	const onPath = findOnPathEmcc();
	if (onPath) return onPath;

	// Nothing found: explain how to fix it and stop.
	console.error("Emscripten not found — the WebAssembly artifacts could not be built.");
	console.error("");
	console.error("Install the emsdk (one-time setup):");
	console.error("  git clone https://github.com/emscripten-core/emsdk.git C:\\Users\\<you>\\emsdk");
	console.error("  cd C:\\Users\\<you>\\emsdk");
	console.error("  emsdk install latest");
	console.error("  (no emsdk_env needed: build-wasm.mjs finds upstream\\emscripten\\emcc.exe directly)");
	console.error("");
	console.error("Then re-run: bun run build:wasm");
	console.error("Or point at a custom emcc with: bun scripts/build-wasm.mjs --emcc <path>");
	process.exit(1);
}

/*
 * Spawn helper. emcc.exe runs directly; if someone points --emcc at a classic
 * .bat launcher, route it through cmd to keep it executable.
 */
function runEmcc(emccPath, args) {
	const win = isWindows();
	const ext = emccPath.slice(-4).toLowerCase();
	let cmd, argv;
	if (win && (ext === ".bat" || ext === ".cmd")) {
		cmd = "cmd";
		argv = ["/c", emccPath, ...args];
	} else {
		cmd = emccPath;
		argv = args;
	}
	const probe = Bun.spawnSync([cmd, ...argv], { cwd: root });
	if (probe.exitCode !== 0) {
		console.error("emcc failed (exit " + probe.exitCode + "):");
		if (probe.stdout.length > 0) console.error(probe.stdout.toString());
		if (probe.stderr.length > 0) console.error(probe.stderr.toString());
		process.exit(probe.exitCode || 1);
	}
}

function sha256File(path) {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(readFileSync(path));
	return hasher.digest("hex");
}

/*
 * Integrity gate for the criterion "a corrupted .wasm makes the build fail".
 * Missing files are fine (they get rebuilt); corrupted ones are not, because
 * that means the committed artifacts diverged from checksums.json somewhere
 * other than through this script.
 */
function verifyExistingArtifacts(force) {
	if (force || !existsSync(checksumFile)) return;
	const checksums = JSON.parse(readFileSync(checksumFile, "utf8"));
	const problems = [];
	for (const name of artifacts) {
		const path = join(outDir, name);
		if (!existsSync(path)) continue; // will be rebuilt
		const expected = checksums[name];
		if (!expected) continue; // new artifact, checksum will be written below
		if (sha256File(path) !== expected) problems.push(name);
	}
	if (problems.length > 0) {
		console.error("Integrity check FAILED — these artifacts do not match the committed checksums:");
		for (const p of problems) console.error("  - " + p);
		console.error("");
		console.error("Delete the corrupted files (they will be rebuilt) or run with --force to overwrite:");
		console.error("  git checkout -- public/wasm/   (restore from the last commit)");
		console.error("  bun run build:wasm --force     (regenerate artifacts + checksums)");
		process.exit(1);
	}
}

/*
 * The biomes module compiles the cubiomes engine (root .c files + features/)
 * plus our narrow wrapper. Deliberately excluded: tests.c (standalone test
 * runner, not part of the library per CMakeLists) and the whole loot/ tree
 * (cJSON-dependent loot tables; nothing outside loot/ references it, verified
 * by grep — piece loot relies only on string names + RNG seeds).
 */
function collectExtensionSources() {
	const skip = new Set(["tests.c"]);
	const sources = [];
	for (const name of readdirSync(cubiomesDir).sort()) {
		if (!name.endsWith(".c") || skip.has(name)) continue;
		if (!statSync(join(cubiomesDir, name)).isFile()) continue;
		sources.push(join("third_party", "cubiomes", name));
	}
	const featuresDir = join(cubiomesDir, "features");
	for (const name of readdirSync(featuresDir).sort()) {
		if (!name.endsWith(".c")) continue;
		sources.push(join("third_party", "cubiomes", "features", name));
	}
	sources.push(join("third_party", "cubiomes-extensions", "ext_bindings.c"));
	return sources;
}

function buildModule(name, sources, flags, outputMjs) {
	console.log("Building " + name + "...");
	mkdirSync(outDir, { recursive: true });
	const args = [...sources, ...flags, "-o", join("public", "wasm", outputMjs)];
	runEmcc(emccPath, args);
	const wasmPath = join(outDir, outputMjs.replace(/\.mjs$/, ".wasm"));
	if (!existsSync(wasmPath)) {
		console.error("emcc did not produce " + wasmPath);
		process.exit(1);
	}
}

async function main() {
	const opts = parseArgs(Bun.argv.slice(2));
	emccPath = resolveEmcc(opts);
	console.log("emcc: " + emccPath);

	verifyExistingArtifacts(opts.force);

	buildModule(
		"biomes-java-gen",
		collectExtensionSources(),
		moduleFlagGroups.biomes,
		"biomes-java-gen.mjs",
	);
	buildModule(
		"bedrock-structures",
		[join("third_party", "cubiomes-extensions", "br_stub.c")],
		moduleFlagGroups.bedrock,
		"bedrock-structures.mjs",
	);

	for (const name of artifacts) {
		const path = join(outDir, name);
		if (!existsSync(path)) {
			console.error("Missing artifact after build: " + name);
			process.exit(1);
		}
	}

	const checksums = {};
	for (const name of artifacts) {
		checksums[name] = sha256File(join(outDir, name));
	}
	writeFileSync(checksumFile, JSON.stringify(checksums, null, 2) + "\n");

	for (const name of artifacts) {
		const size = statSync(join(outDir, name)).size;
		console.log("  " + name + ": " + (size / 1024).toFixed(1) + " KB");
	}
	console.log("checksums.json written. WASM build complete.");
}

let emccPath = null;

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
