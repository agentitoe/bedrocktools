// Offline repair pass for the generated "special" block models. Rebuilds the
// chest / head / bed / banner / shield / golem-statue / decorated-pot models in
// the shipped public/data artifacts using the (corrected) builders from
// special-blocks.mjs, without touching the network. Run after changing any of
// those builders to sync already-generated data; a full extract-data run would
// produce the same models.
//
// Also fixes stale items.json entries: bed items still pointed at the vanilla
// white_bed_head model (thin slab) instead of the generated full bed model, and
// the decorated pot item had no model at all.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
	buildBannerModel,
	buildBedModel,
	buildChestModel,
	buildDecoratedPotModel,
	buildGolemStatueModel,
	buildHeadModel,
	buildShieldModel,
	DRAGON_HEAD_REGIONS,
	HEAD_REGIONS
} from './special-blocks.mjs';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dataDir = join(root, 'public', 'data');
const headsDir = join(dataDir, 'models', 'block');

const DYE_COLOR_NAMES = [
	'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
	'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
];

const allModelsPath = join(dataDir, 'models', 'all.json');
const allModels = JSON.parse(readFileSync(allModelsPath, 'utf8'));

const HEAD_KINDS = new Set(['skeleton', 'wither_skeleton', 'zombie', 'creeper', 'piglin', 'dragon', 'player']);
const CHEST_TEXTURES = ['normal', 'ender', 'trapped', 'copper', 'copper_exposed', 'copper_oxidized', 'copper_Weathered'.toLowerCase()];

function writeJsonFile(path, data) {
	const json = JSON.stringify(data);
	if (existsSync(path)) unlinkSync(path);
	writeFileSync(path, json);
	JSON.parse(readFileSync(path, 'utf8')); // Corruption guard, same as extract-data.
}

let rebuilt = 0;
for (const [key, model] of Object.entries(allModels)) {
	const headKind = key.startsWith('head_') ? key.slice('head_'.length) : null;
	const chestTexture = key.startsWith('chest_') ? key.slice('chest_'.length) : null;
	const golemFile = key.startsWith('golem_') ? key.slice('golem_'.length) : null;

	if (key === 'shield') {
		allModels[key] = buildShieldModel('shield_base');
	} else if (headKind && HEAD_KINDS.has(headKind)) {
		const skinName = `head_skin_${headKind}`;
		const dims = headKind === 'dragon' ? { width: 256, height: 256 } : { width: 64, height: 64 };
		const regions = headKind === 'dragon' ? DRAGON_HEAD_REGIONS : HEAD_REGIONS;
		allModels[key] = buildHeadModel(skinName, dims, regions);
	} else if (chestTexture && CHEST_TEXTURES.includes(chestTexture)) {
		allModels[key] = buildChestModel(key);
	} else if (model && model.textures && model.textures.bed) {
		allModels[key] = buildBedModel(model.textures.bed);
	} else if (model && model.textures && model.textures.cloth && model.textures.pole) {
		allModels[key] = buildBannerModel(model.textures.cloth, model.textures.pole);
	} else if (golemFile && golemFile.startsWith('copper_golem')) {
		allModels[key] = buildGolemStatueModel(key);
	} else if (key === 'decorated_pot') {
		allModels[key] = buildDecoratedPotModel();
	} else {
		continue;
	}
	rebuilt++;
	// Keep the per-model files in sync so the next full extract bundles the
	// same content instead of regressing when all.json is rebuilt.
	writeFileSync(join(headsDir, `${key}.json`), JSON.stringify(allModels[key]));
}

if (!allModels.decorated_pot) {
	allModels.decorated_pot = buildDecoratedPotModel();
	rebuilt++;
	writeFileSync(join(headsDir, 'decorated_pot.json'), JSON.stringify(allModels.decorated_pot));
}

writeJsonFile(allModelsPath, allModels);
console.log(`Rebuilt ${rebuilt} special models in all.json (+per-model files)`);

// The banner cloth slice previously kept a brown stand strip (bottom rows) and
// trailing transparent columns from banner_base.png, which rendered as dark
// bands across the flag face. Crop every tinted cloth to the clean flag area.
let clothsCleaned = 0;
for (const color of DYE_COLOR_NAMES) {
	const clothPath = join(root, 'public', 'textures', 'block', `banner_cloth_${color}.webp`);
	if (!existsSync(clothPath)) continue;
	const img = sharp(clothPath);
	const { width, height } = await img.metadata();
	if (!width || width <= 40 || !height || height <= 42) continue;
	const out = await img
		.extract({ left: 0, top: 0, width: 40, height: 42 })
		.webp({ lossless: true, effort: 4 })
		.toBuffer();
	writeFileSync(clothPath, out);
	clothsCleaned++;
}
console.log(`Cleaned ${clothsCleaned} banner cloth textures`);

// ---- items.json patches -----------------------------------------------------

const itemsPath = join(dataDir, 'items.json');
const items = JSON.parse(readFileSync(itemsPath, 'utf8'));
const BED_COLORS = new Set(DYE_COLOR_NAMES);

let patched = 0;
for (const item of items) {
	if (!item || typeof item.name !== 'string') continue;
	const bedColor = item.name.match(/^(.*)_bed$/)?.[1];
	if (bedColor && BED_COLORS.has(bedColor) && item.renderAs === 'block') {
		item.modelName = `bed_${bedColor}`;
		item.textureUrl = `/textures/block/bed_${bedColor}.webp`;
		item.textureVariants = [];
		patched++;
		continue;
	}
	if (item.name === 'decorated_pot') {
		item.renderAs = 'block';
		item.modelName = 'decorated_pot';
		item.textureUrl = '/textures/block/terracotta.webp';
		item.textureVariants = [];
		patched++;
	}
}
writeJsonFile(itemsPath, items);
console.log(`Patched ${patched} items.json entries`);
