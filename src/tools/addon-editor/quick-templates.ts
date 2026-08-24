// Quick-add templates for common Minecraft Bedrock files.
// Each template is a function that generates file content (JSON or text).
// The user picks a template from a dropdown and it creates the file in the
// current directory with placeholder values they can customize.

import { encodeUtf8 } from "../../shared/encoding";
import type { FileMap } from "./pack";

export interface QuickTemplate {
	/** Display name shown in the picker. */
	label: string;
	/** Human-readable description. */
	description: string;
	/** Category for grouping. */
	category: "behavior" | "resource" | "other";
	/** Default file name (may include subdirectory). */
	filename: string;
	/** File content generator (receives a suggested identifier name). */
	generate: (name: string) => string;
}

/**
 * Map of documentation URLs keyed by path pattern.
 * Patterns are checked with startsWith. All URLs point to the
 * stable Minecraft Bedrock Creator documentation on Microsoft Learn.
 */
export const DOCS_LINKS: Record<string, string> = {
	"manifest.json": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/manifestreference/packmanifestdocument",
	"entities/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/cliententitydocumentation/cliententitydocumentationintroduction",
	"items/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/itemreference/examples/itemcomponents/description_component",
	"blocks/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/blockreference/examples/blockcomponents/blockcomponentslist",
	"recipes/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/recipereference/examples/recipedefinitions/minecraftrecipe_shaped",
	"loot_tables/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/loottablereference/examples/loottablecomponents/loot_table",
	"trading/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/tradetablereference/examples/tradetablecomponents/trade",
	"spawn_rules/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/spawnrulesreference/examples/spawnrulescomponents/spawn_rules_document",
	"animation_controllers/": "https://learn.microsoft.com/en-us/minecraft/creator/documents/animations/animationcontroller",
	"animations/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/animationsreference/examples/animationlist",
	"render_controllers/": "https://learn.microsoft.com/en-us/minecraft/creator/documents/animations/animationrendercontroller",
	"attachables/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/attachablereference/examples/attachabledefinitions/attachable",
	"models/entity/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/schemasreference/schemas/minecraftschema_geometry_1.12.0",
	"models/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/schemasreference/schemas/minecraftschema_geometry_1.12.0",
	"particles/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/particlesreference/particlesintroduction",
	"sounds/": "https://learn.microsoft.com/en-us/minecraft/creator/documents/addcustomsounds",
	"textures/": "https://learn.microsoft.com/en-us/minecraft/creator/documents/resourcepack",
	"texts/": "https://learn.microsoft.com/en-us/minecraft/creator/documents/resourcepack",
	"functions/": "https://learn.microsoft.com/en-us/minecraft/creator/commands/commands",
	"dialogue/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/dialoguereference/examples/dialoguedefinitions/dialogue_document",
	"molang": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions",
	"feature_rules/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/featuresreference/examples/featuresintroduction",
	"features/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/featuresreference/examples/featuresintroduction",
	"biomes/": "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/biomesreference/examples/biome",
};

/**
 * Find a documentation URL for the given file path.
 * Checks exact matches first, then prefix matches (longest prefix first).
 */
export function docsUrlForPath(path: string): string | null {
	// Exact match first
	if (DOCS_LINKS[path]) return DOCS_LINKS[path];

	// Check if path is a molang file
	if (path.endsWith(".molang")) return DOCS_LINKS["molang"];

	// Prefix match (longest first)
	const prefixes = Object.keys(DOCS_LINKS)
		.filter((k) => k.endsWith("/"))
		.sort((a, b) => b.length - a.length);
	for (const prefix of prefixes) {
		if (path.startsWith(prefix)) return DOCS_LINKS[prefix];
	}

	// Generic wiki fallback for known pack directories
	if (
		path.match(
			/^(behavior_pack|resource_pack|BP|RP)\//
		)
	) {
		return "https://learn.microsoft.com/en-us/minecraft/creator/";
	}

	return null;
}

// ---- Template generators ----

/** Sanitize a user-provided name into a valid Minecraft identifier. */
function sanitizeId(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "") || "custom"
	);
}

function jsonStr(obj: unknown, inline = false): string {
	if (inline) return JSON.stringify(obj);
	return JSON.stringify(obj, null, 2);
}

// ═══ Behavior Pack templates ═══

function entityBehavior(name: string): string {
	const id = sanitizeId(name);
	const desc = name || "My Entity";
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:entity": {
			description: {
				identifier: id,
				is_spawnable: true,
				is_summonable: true,
				is_experimental: false,
			},
			components: {
				"minecraft:type_family": { family: [id] },
				"minecraft:health": { value: 20, max: 20 },
				"minecraft:movement": { value: 0.25 },
				"minecraft:collision_box": { width: 0.6, height: 1.8 },
				"minecraft:physics": {},
				"minecraft:nameable": { allow_name_tag_renaming: true, always_show: true },
			},
			events: {},
		},
	});
}

function itemBehavior(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:item": {
			description: {
				identifier: id,
				menu_category: { category: "items", group: "itemGroup.name.misc" },
			},
			components: {
				"minecraft:max_stack_size": 64,
				"minecraft:icon": { texture: id },
				"minecraft:display_name": { value: name || "Custom Item" },
			},
		},
	});
}

function blockBehavior(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:block": {
			description: {
				identifier: id,
				menu_category: { category: "construction", group: "itemGroup.name.blocks" },
			},
			components: {
				"minecraft:destructible_by_mining": { seconds_to_destroy: 1.5 },
				"minecraft:destructible_by_explosion": { explosion_resistance: 6 },
				"minecraft:friction": 0.6,
				"minecraft:light_dampening": 15,
				"minecraft:map_color": "#888888",
			},
		},
	});
}

function recipeShaped(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:recipe_shaped": {
			description: { identifier: id },
			tags: ["crafting_table"],
			pattern: ["XXX", "XYX", "XXX"],
			key: {
				X: { item: "minecraft:stick" },
				Y: { item: "minecraft:diamond" },
			},
			result: { item: id, count: 1 },
		},
	});
}

function recipeShapeless(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:recipe_shapeless": {
			description: { identifier: id },
			tags: ["crafting_table"],
			ingredients: [
				{ item: "minecraft:stick", count: 2 },
				{ item: "minecraft:diamond", count: 1 },
			],
			result: { item: id, count: 1 },
		},
	});
}

function recipeFurnace(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:recipe_furnace": {
			description: { identifier: id },
			input: { item: "minecraft:iron_ore" },
			output: { item: id, count: 1 },
		},
	});
}

function lootTable(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		pools: [
			{
				rolls: 1,
				entries: [
					{
						type: "item",
						name: id,
						weight: 1,
						functions: [
							{
								function: "set_count",
								count: { min: 1, max: 3 },
							},
						],
					},
				],
			},
		],
	});
}

function trading(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		tiers: [
			{
				groups: [
					{
						num_to_select: 1,
						trades: [
							{
								wants: [{ item: "minecraft:emerald", quantity: 1 }],
								gives: [{ item: id, quantity: 1 }],
								max_uses: 12,
								reward_exp: true,
							},
						],
					},
				],
			},
		],
	});
}

function spawnRules(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:spawn_rules": {
			description: {
				identifier: id,
				population_control: "monster",
			},
			conditions: [
				{
					"minecraft:spawns_on_surface": {},
					"minecraft:brightness_filter": {
						min: 0,
						max: 7,
						adjust_for_weather: false,
					},
					"minecraft:weight": { default: 100 },
				},
			],
		},
	});
}

function animationController(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		animation_controllers: {
			[`controller.animation.${id}`]: {
				initial_state: "default",
				states: {
					default: {
						animations: ["idle"],
						transitions: [{ walking: "query.is_moving" }],
					},
					walking: {
						animations: ["walk"],
						transitions: [{ default: "!query.is_moving" }],
					},
				},
			},
		},
	});
}

function dialogue(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:npc_dialogue": {
			scenes: [
				{
					scene_tag: id,
					npc_name: name || "NPC",
					text: "Hello, adventurer!",
					buttons: [
						{
							name: "Continue",
							commands: ["/say Hello!"],
						},
					],
				},
			],
		},
	});
}

// ═══ Resource Pack templates ═══

function clientEntity(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:client_entity": {
			description: {
				identifier: id,
				materials: { default: "entity_alphatest" },
				textures: { default: `textures/entity/${id}` },
				geometry: { default: `geometry.${id}` },
				render_controllers: ["controller.render.default"],
				spawn_egg: {
					base_color: "#888888",
					overlay_color: "#FFFFFF",
				},
			},
		},
	});
}

function animation(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		animations: {
			[`animation.${id}.idle`]: {
				loop: true,
				animation_length: 1,
				bones: {
					body: {
						rotation: [0, 0, 0],
						position: [0, 0, 0],
					},
				},
			},
		},
	});
}

function renderController(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		render_controllers: {
			[`controller.render.${id}`]: {
				geometry: `Geometry.default`,
				materials: [{ "*": "Material.default" }],
				textures: ["Texture.default"],
			},
		},
	});
}

function attachable(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		"minecraft:attachable": {
			description: {
				identifier: id,
				materials: { default: "entity_alphatest" },
				textures: { default: `textures/entity/${id}` },
				geometry: { default: `geometry.${id}` },
				render_controllers: ["controller.render.default"],
			},
		},
	});
}

function geometry(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		[`geometry.${id}`]: {
			description: {
				identifier: `geometry.${id}`,
				texture_width: 64,
				texture_height: 64,
				visible_bounds_width: 2,
				visible_bounds_height: 3,
				visible_bounds_offset: [0, 1.5, 0],
			},
			bones: [
				{
					name: "body",
					pivot: [0, 12, 0],
					cubes: [
						{
							origin: [-4, 0, -4],
							size: [8, 12, 8],
							uv: [0, 0],
						},
					],
				},
			],
		},
	});
}

function particle(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		particle_effect: {
			description: {
				identifier: id,
				basic_render_parameters: {
					material: "particles_alpha",
					texture: "textures/particle/particles",
				},
			},
			curves: {},
			events: {},
		},
	});
}

function soundDefinitions(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: "1.21.0",
		sound_definitions: {
			[id]: {
				category: "neutral",
				sounds: [{ name: `sounds/${id}`, stream: false, volume: 1 }],
			},
		},
	});
}

function terrainTexture(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		resource_pack_name: "vanilla",
		texture_name: `atlas.terrain`,
		texture_data: {
			[id]: { textures: `textures/blocks/${id}` },
		},
	});
}

function itemTexture(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		resource_pack_name: "vanilla",
		texture_name: `atlas.items`,
		texture_data: {
			[id]: { textures: `textures/items/${id}` },
		},
	});
}

function flipbookTextures(_name: string): string {
	return jsonStr([
		{
			flipbook_texture: "textures/blocks/custom_animated",
			atlas_tile: "custom_animated",
			ticks_per_frame: 3,
			frames: [0, 1, 2, 3],
		},
	]);
}

// ═══ Other templates ═══

function mcfunction(_name: string): string {
	return (
		"# Custom function\n" +
		"# Use /function <name> to run this\n" +
		"say Hello, world!\n"
	);
}

function langFile(_name: string): string {
	return (
		"## Custom texts\n" +
		"## Format: item.<id>.name=Display Name\n" +
		"## Format: tile.<id>.name=Block Name\n" +
		"## Format: entity.<id>.name=Entity Name\n"
	);
}

function manifestBP(name: string): string {
	const id = sanitizeId(name);
	return jsonStr({
		format_version: 2,
		header: {
			name: name || "My Behavior Pack",
			description: name ? `${name} — Custom behavior pack` : "Custom behavior pack",
			uuid: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
			version: [1, 0, 0],
			min_engine_version: [1, 20, 0],
		},
		modules: [
			{
				type: "data",
				uuid: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
				version: [1, 0, 0],
			},
		],
		dependencies: [],
	});
}

// ═══ Registry ═══

export const QUICK_TEMPLATES: QuickTemplate[] = [
	// Behavior Pack
	{
		label: "Entity (behavior)",
		description: "Entity definition with health, movement, collision box and type family",
		category: "behavior",
		filename: "entities/PLACEHOLDER.json",
		generate: entityBehavior,
	},
	{
		label: "Item (behavior)",
		description: "Item definition with icon, stack size and display name",
		category: "behavior",
		filename: "items/PLACEHOLDER.json",
		generate: itemBehavior,
	},
	{
		label: "Block (behavior)",
		description: "Block definition with mining, explosion resistance and friction",
		category: "behavior",
		filename: "blocks/PLACEHOLDER.json",
		generate: blockBehavior,
	},
	{
		label: "Recipe — Shaped",
		description: "Shaped crafting table recipe with pattern and key",
		category: "behavior",
		filename: "recipes/PLACEHOLDER.json",
		generate: recipeShaped,
	},
	{
		label: "Recipe — Shapeless",
		description: "Shapeless crafting table recipe with ingredient list",
		category: "behavior",
		filename: "recipes/PLACEHOLDER.json",
		generate: recipeShapeless,
	},
	{
		label: "Recipe — Furnace",
		description: "Furnace smelting recipe with input and output",
		category: "behavior",
		filename: "recipes/PLACEHOLDER.json",
		generate: recipeFurnace,
	},
	{
		label: "Loot Table",
		description: "Loot table with a pool, entry, weight and count function",
		category: "behavior",
		filename: "loot_tables/PLACEHOLDER.json",
		generate: lootTable,
	},
	{
		label: "Trading (Villager)",
		description: "Villager trading table with tiers, groups and trades",
		category: "behavior",
		filename: "trading/PLACEHOLDER.json",
		generate: trading,
	},
	{
		label: "Spawn Rules",
		description: "Spawn rules with surface spawning, brightness filter and weight",
		category: "behavior",
		filename: "spawn_rules/PLACEHOLDER.json",
		generate: spawnRules,
	},
	{
		label: "Animation Controller",
		description: "Animation controller with default and walking states and transitions",
		category: "behavior",
		filename: "animation_controllers/PLACEHOLDER.json",
		generate: animationController,
	},
	{
		label: "NPC Dialogue",
		description: "NPC dialogue scene with text and a command button",
		category: "behavior",
		filename: "dialogue/PLACEHOLDER.json",
		generate: dialogue,
	},

	// Resource Pack
	{
		label: "Client Entity",
		description: "Client entity definition with materials, textures, geometry and spawn egg",
		category: "resource",
		filename: "entity/PLACEHOLDER.json",
		generate: clientEntity,
	},
	{
		label: "Animation",
		description: "Animation with a looping idle animation for a body bone",
		category: "resource",
		filename: "animations/PLACEHOLDER.json",
		generate: animation,
	},
	{
		label: "Render Controller",
		description: "Render controller with geometry, material and texture bindings",
		category: "resource",
		filename: "render_controllers/PLACEHOLDER.json",
		generate: renderController,
	},
	{
		label: "Attachable",
		description: "Attachable definition for wearable/holdable items with textures and geometry",
		category: "resource",
		filename: "attachables/PLACEHOLDER.json",
		generate: attachable,
	},
	{
		label: "Geometry Model",
		description: "Geometry model with a body bone and cube definition",
		category: "resource",
		filename: "models/entity/PLACEHOLDER.geo.json",
		generate: geometry,
	},
	{
		label: "Particle",
		description: "Particle effect with basic render parameters, curves and events",
		category: "resource",
		filename: "particles/PLACEHOLDER.json",
		generate: particle,
	},
	{
		label: "Sound Definitions",
		description: "Sound definitions file referencing a single sound",
		category: "resource",
		filename: "sounds/sound_definitions.json",
		generate: soundDefinitions,
	},
	{
		label: "Terrain Texture",
		description: "Terrain texture atlas mapping for block textures",
		category: "resource",
		filename: "textures/terrain_texture.json",
		generate: terrainTexture,
	},
	{
		label: "Item Texture",
		description: "Item texture atlas mapping for item textures",
		category: "resource",
		filename: "textures/item_texture.json",
		generate: itemTexture,
	},
	{
		label: "Flipbook Textures",
		description: "Flipbook texture definition for animated block textures",
		category: "resource",
		filename: "textures/flipbook_textures.json",
		generate: flipbookTextures,
	},

	// Other
	{
		label: ".mcfunction",
		description: "Minecraft function file with a sample say command",
		category: "other",
		filename: "functions/PLACEHOLDER.mcfunction",
		generate: mcfunction,
	},
	{
		label: ".lang (Texts)",
		description: "Language/translation file with format comments",
		category: "other",
		filename: "texts/en_US.lang",
		generate: langFile,
	},
	{
		label: "Manifest (behavior)",
		description: "Behavior pack manifest with header and data module",
		category: "other",
		filename: "manifest.json",
		generate: manifestBP,
	},
];

/**
 * Build the final file map for a quick template.
 * Replaces PLACEHOLDER in the filename with the sanitized name.
 * Returns a single-entry FileMap.
 */
export function buildQuickTemplate(
	tmpl: QuickTemplate,
	name: string
): FileMap {
	const id = sanitizeId(name);
	const filename = tmpl.filename.replace(/PLACEHOLDER/g, id);
	const content = encodeUtf8(tmpl.generate(name));
	return { [filename]: content };
}