// Local static file server for development.
//
// Serves the `public/` directory over HTTP so the site works exactly as in
// production (the pages use absolute paths like /data/items.json, which break
// if you open index.html with file://). No dependencies, no auth, no build.
//
// Usage:
//   npm run dev               # builds the bundles + ui.js, then serves
//   node scripts/serve.mjs    # serve only (assets must already be built)
//
// The port defaults to 8788; override with PORT=3000 npm run dev.

import { createServer } from "http";
import { readFile, stat } from "fs/promises";
import { join, extname, normalize, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = normalize(join(__dirname, "..", "public"));
const port = Number(process.env.PORT) || 8788;

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
};

/** Resolve a request path to a file inside `root`, or null if it escapes. */
function resolvePath(urlPath) {
	let pathname;
	try {
		pathname = decodeURIComponent(urlPath.split("?")[0]);
	} catch {
		return null;
	}
	const resolved = normalize(join(root, pathname));
	const rel = relative(root, resolved);
	if (rel === ".." || rel.startsWith("..") || isAbsolute(rel)) return null;
	return resolved;
}

const server = createServer(async (req, res) => {
	const requested = resolvePath(req.url || "/");
	if (requested === null) {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
		return res.end("Bad request");
	}

	let filePath = requested;
	try {
		const info = await stat(filePath);
		if (info.isDirectory()) {
			// Redirect "/foo" -> "/foo/" so relative URLs in the page
			// (./bundle.js, styles.css, ...) resolve against the right base.
			// Without this, "import './bundle.js'" from /tools/x would request
			// /tools/bundle.js and 404.
			let pathname = decodeURIComponent((req.url || "/").split("?")[0]);
			if (!pathname.endsWith("/")) {
				res.writeHead(301, { Location: pathname + "/", "Cache-Control": "no-store" });
				return res.end();
			}
			filePath = join(filePath, "index.html");
		}
		const data = await readFile(filePath);
		const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		res.end(data);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
	}
});

server.listen(port, () => {
	console.log(`Serving ${root}`);
	console.log(`Open http://localhost:${port}/`);
});
