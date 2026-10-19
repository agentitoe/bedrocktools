// Generates public/assets/og.png from public/assets/og.html by rendering the
// card in headless Chromium/Chrome at exactly 1200x630.
//
// The HTML source is committed next to the PNG so the card stays editable
// without touching this script.
//
// Chrome is resolved in this order:
//   1. CHROME_BIN environment variable
//   2. the browser agent-browser downloads under ~/.agent-browser/browsers
//   3. the system Chrome/Edge install
//
// Usage: bun scripts/build-og.mjs [outputPath]
//   (writes PNG bytes to the path given, or public/assets/og.png by default)
import { spawn } from "child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const source = join(root, "public", "assets", "og.html");
const out = process.argv[2] ? join(root, process.argv[2]) : join(root, "public", "assets", "og.png");

const WIDTH = 1200;
const HEIGHT = 630;

function findChrome() {
	const candidates = [];
	if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);

	// Browser downloaded by agent-browser (any version).
	const abDir = join(homedir(), ".agent-browser", "browsers");
	try {
		for (const dir of readdirSync(abDir)) {
			candidates.push(join(abDir, dir, process.platform === "win32" ? "chrome.exe" : "chrome"));
		}
	} catch {
		// no agent-browser browsers installed
	}

	if (process.platform === "win32") {
		const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
		const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const la = process.env.LOCALAPPDATA ?? "";
		for (const base of [pf, pf86, la]) {
			if (!base) continue;
			candidates.push(
				join(base, "Google", "Chrome", "Application", "chrome.exe"),
				join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
			);
		}
	} else {
		candidates.push(
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		);
	}

	for (const c of candidates) {
		try {
			readFileSync(c); // existence check
			return c;
		} catch {
			// try next
		}
	}
	throw new Error("No Chrome/Edge found. Set CHROME_BIN to a Chrome executable.");
}

function render(url) {
	return new Promise((resolve, reject) => {
		const chrome = findChrome();
		const proc = spawn(
			chrome,
			[
				"--headless=new",
				"--disable-gpu",
				"--hide-scrollbars",
				"--force-device-scale-factor=1",
				"--virtual-time-budget=8000",
				`--window-size=${WIDTH},${HEIGHT}`,
				`--screenshot=${out}`,
				url,
			],
			{ stdio: "ignore" },
		);
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) reject(new Error(chrome + " exited with " + code));
			else resolve();
		});
	});
}

async function main() {
	const url = "file:///" + source.replace(/\\/g, "/");
	await render(url);

	const bytes = readFileSync(out);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, bytes);
	console.log("Wrote " + out + " (" + bytes.length + " bytes)");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
