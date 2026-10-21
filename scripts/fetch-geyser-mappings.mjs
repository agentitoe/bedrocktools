// Fetch the official Java→Bedrock item mappings from Geyser and generate the
// compact map the /give tool consumes.
// Source: https://github.com/GeyserMC/mappings (items.json)
//
// Only the item *names* are taken from Geyser (bedrock_identifier). Geyser
// lists every Java item and falls back to the Java name when Bedrock uses the
// same identifier, so it cannot tell whether an item is missing in Bedrock;
// availability stays a separate concern in bedrock-ids.ts.

import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outPath = join(root, 'public', 'data', 'geyser-item-map.json');

const GEYSER_ITEMS_URL = 'https://raw.githubusercontent.com/GeyserMC/mappings/master/items.json';

/** Resolve the commit SHA the file was served from (provenance for the output). */
async function currentSha() {
	try {
		const res = await fetch('https://api.github.com/repos/GeyserMC/mappings/commits?per_page=1', {
			headers: { 'User-Agent': 'bedrocktools', Accept: 'application/vnd.github+json' }
		});
		if (!res.ok) return null;
		const [latest] = await res.json();
		return latest?.sha ?? null;
	} catch {
		return null;
	}
}

const strip = (name) => String(name).replace(/^minecraft:/, '');

async function main() {
	console.time('geyserMappings');

	const [res, sha] = await Promise.all([
		fetch(GEYSER_ITEMS_URL, { headers: { 'User-Agent': 'bedrocktools' } }),
		currentSha()
	]);
	if (!res.ok) throw new Error(`Geyser items.json: HTTP ${res.status}`);

	const items = await res.json();
	if (!items || typeof items !== 'object') throw new Error('Geyser items.json: unexpected payload');

	// name -> bedrock name, only where they differ.
	const renames = {};
	for (const [java, entry] of Object.entries(items)) {
		const bedrock = entry && typeof entry.bedrock_identifier === 'string' ? strip(entry.bedrock_identifier) : null;
		if (!bedrock) continue;
		const name = strip(java);
		if (bedrock !== name) renames[name] = bedrock;
	}

	const map = {
		source: 'GeyserMC/mappings',
		sourceUrl: GEYSER_ITEMS_URL,
		commit: sha,
		entries: Object.keys(items).length,
		generatedAt: new Date().toISOString(),
		renames
	};

	if (existsSync(outPath)) unlinkSync(outPath);
	writeFileSync(outPath, JSON.stringify(map));
	JSON.parse(readFileSync(outPath, 'utf8')); // fail loudly on a corrupt write

	console.log(
		`Generated geyser-item-map.json: ${Object.keys(items).length} items, ${Object.keys(renames).length} renames (commit ${sha?.slice(0, 7) ?? 'unknown'})`
	);
	console.timeEnd('geyserMappings');
}

main().catch((err) => {
	console.error('Failed to fetch Geyser mappings:', err.message);
	process.exit(1);
});
