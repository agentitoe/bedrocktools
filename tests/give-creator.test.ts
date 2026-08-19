import { test } from "node:test";
import assert from "node:assert/strict";
import type { GiveState } from "../src/tools/give-creator/types";
import {
	buildCommand,
	buildJavaCommand,
	buildBedrockCommand,
	snbtStr,
	snbtJson,
	textComponent,
	parseBlockList,
	parseColorList,
	parseColor,
} from "../src/tools/give-creator/builder";
import { bedrockPotionDataList, resolveBedrockItem } from "../src/tools/give-creator/bedrock-ids";

function makeState(overrides: Partial<GiveState> = {}): GiveState {
	return {
		platform: "java",
		target: "@p",
		customTarget: "",
		itemId: "minecraft:diamond_sword",
		count: 1,
		dataValue: 0,
		dataOverridden: false,
		values: {},
		...overrides,
	};
}

// ---- SNBT / text helpers ----

test("snbtStr wraps and escapes double quotes", () => {
	assert.equal(snbtStr("hello"), '"hello"');
	assert.equal(snbtStr('say "hi"'), '"say \\"hi\\""');
});

test("snbtJson wraps JSON in single quotes and escapes them", () => {
	assert.equal(snbtJson('{"text":"hi"}'), "'{\"text\":\"hi\"}'");
	assert.equal(snbtJson("it's"), "'it\\'s'");
});

test("textComponent builds a JSON text component", () => {
	assert.equal(textComponent("Hi"), '{"text":"Hi"}');
	assert.equal(textComponent("Hi", "gold"), '{"text":"Hi","color":"gold"}');
	assert.equal(textComponent("Hi", "white", false), '{"text":"Hi","italic":false}');
	assert.equal(textComponent("Hi", "red", false, true), '{"text":"Hi","color":"red","italic":false,"bold":true}');
});

test("parseBlockList splits on commas and whitespace", () => {
	assert.deepEqual(parseBlockList("minecraft:stone, #mineable/pickaxe  dirt"), [
		"minecraft:stone",
		"#mineable/pickaxe",
		"dirt",
	]);
	assert.deepEqual(parseBlockList("  "), []);
});

test("parseColor accepts hex and decimal", () => {
	assert.equal(parseColor("#ff0000"), 16711680);
	assert.equal(parseColor("65280"), 65280);
	assert.equal(parseColor("nope"), null);
});

test("parseColorList parses mixed hex and decimal", () => {
	assert.deepEqual(parseColorList("#ff0000, 65280, #0000ff"), [16711680, 65280, 255]);
});

// ---- Java ----

test("java: minimal command", () => {
	const s = makeState();
	assert.equal(buildJavaCommand(s).command, "/give @p minecraft:diamond_sword 1");
});

test("java: custom name with color", () => {
	const s = makeState({ values: { customName: "Espada", customNameColor: "gold" } });
	assert.equal(
		buildJavaCommand(s).command,
		"/give @p minecraft:diamond_sword[minecraft:custom_name='{\"text\":\"Espada\",\"color\":\"gold\"}'] 1"
	);
});

test("java: lore becomes a list of JSON components", () => {
	const s = makeState({ values: { lore: "Line one\nLine two" } });
	assert.equal(
		buildJavaCommand(s).command,
		"/give @p minecraft:diamond_sword[minecraft:lore=['{\"text\":\"Line one\"}','{\"text\":\"Line two\"}']] 1"
	);
});

test("java: enchantments are a direct enchantment->level map", () => {
	const s = makeState({
		values: { enchantments: [{ enchantment: "sharpness", level: 5 }, { enchantment: "fire_aspect", level: "2" }] },
	});
	assert.equal(
		buildJavaCommand(s).command,
		'/give @p minecraft:diamond_sword[minecraft:enchantments={"minecraft:sharpness":5,"minecraft:fire_aspect":2}] 1'
	);
});

test("java: stored enchantments for enchanted books", () => {
	const s = makeState({
		values: { storedEnchantments: true, enchantments: [{ enchantment: "mending", level: 1 }] },
	});
	assert.equal(
		buildJavaCommand(s).command,
		'/give @p minecraft:diamond_sword[minecraft:stored_enchantments={"minecraft:mending":1}] 1'
	);
});

test("java: durability options", () => {
	const s = makeState({ values: { damage: "500", maxDamage: "1000", unbreakable: true } });
	assert.equal(
		buildJavaCommand(s).command,
		"/give @p minecraft:diamond_sword[minecraft:damage=500,minecraft:max_damage=1000,minecraft:unbreakable={}] 1"
	);
});

test("java: can_break single block vs list", () => {
	const single = makeState({ values: { canBreak: "minecraft:stone" } });
	assert.equal(
		buildJavaCommand(single).command,
		'/give @p minecraft:diamond_sword[minecraft:can_break={blocks:"minecraft:stone"}] 1'
	);
	const multi = makeState({ values: { canBreak: "minecraft:stone, #mineable/pickaxe" } });
	assert.equal(
		buildJavaCommand(multi).command,
		'/give @p minecraft:diamond_sword[minecraft:can_break={blocks:["minecraft:stone","#mineable/pickaxe"]}] 1'
	);
});

test("java: dyed color converts hex to decimal", () => {
	const s = makeState({ values: { dyedColor: "#ff0000" } });
	assert.equal(
		buildJavaCommand(s).command,
		"/give @p minecraft:diamond_sword[minecraft:dyed_color=16711680] 1"
	);
});

test("java: armor trim", () => {
	const s = makeState({ values: { trimMaterial: "quartz", trimPattern: "sentry" } });
	assert.equal(
		buildJavaCommand(s).command,
		'/give @p minecraft:diamond_sword[minecraft:trim={material:"minecraft:quartz",pattern:"minecraft:sentry"}] 1'
	);
});

test("java: potion preset vs custom effects (seconds to ticks)", () => {
	const preset = makeState({ values: { potion: "night_vision" } });
	assert.equal(
		buildJavaCommand(preset).command,
		'/give @p minecraft:diamond_sword[minecraft:potion_contents={potion:"minecraft:night_vision"}] 1'
	);
	const custom = makeState({
		values: { potion: "custom", potionEffects: [{ effect: "strength", duration: 60, amplifier: 1 }] },
	});
	assert.equal(
		buildJavaCommand(custom).command,
		'/give @p minecraft:diamond_sword[minecraft:potion_contents={custom_effects:[{id:"minecraft:strength",amplifier:1,duration:1200}]}] 1'
	);
});

test("java: fireworks", () => {
	const s = makeState({
		values: {
			fireworkFlight: "2",
			fireworkExplosions: [{ shape: "star", colors: "#ff0000, 65280", fade: "#ffffff", trail: true, twinkle: false }],
		},
	});
	assert.equal(
		buildJavaCommand(s).command,
		'/give @p minecraft:diamond_sword[minecraft:fireworks={flight_duration:2,explosions:[{shape:"star",colors:[16711680,65280],fade_colors:[16777215],has_trail:true,has_twinkle:false}]}] 1'
	);
});

test("java: attribute modifiers", () => {
	const s = makeState({
		values: {
			attributes: [{ attribute: "minecraft:attack_damage", slot: "mainhand", operation: "add_value", amount: 5, name: "" }],
		},
	});
	assert.equal(
		buildJavaCommand(s).command,
		'/give @p minecraft:diamond_sword[minecraft:attribute_modifiers=[{type:"minecraft:attack_damage",slot:"mainhand",id:"give:modifier_1",amount:5,operation:"add_value"}]] 1'
	);
});

test("java: custom target falls back to @p when empty", () => {
	const s = makeState({ target: "custom", customTarget: "Steve" });
	assert.equal(buildJavaCommand(s).command, "/give Steve minecraft:diamond_sword 1");
	const empty = makeState({ target: "custom", customTarget: "  " });
	assert.equal(buildJavaCommand(empty).command, "/give @p minecraft:diamond_sword 1");
});

test("java: missing item reports an error", () => {
	const s = makeState({ itemId: "  " });
	const result = buildJavaCommand(s);
	assert.equal(result.command, "");
	assert.equal(result.error, "errorNoItem");
});

// ---- Bedrock ----

test("bedrock: minimal command", () => {
	const s = makeState({ platform: "bedrock" });
	assert.equal(buildBedrockCommand(s).command, "/give @p minecraft:diamond_sword 1");
});

test("bedrock: data value included when non-zero (user-edited)", () => {
	const s = makeState({ platform: "bedrock", dataValue: 5, dataOverridden: true });
	assert.equal(buildBedrockCommand(s).command, "/give @p minecraft:diamond_sword 1 5");
});

test("bedrock: item lock, keep on death and blocks", () => {
	const s = makeState({
		platform: "bedrock",
		values: {
			bedrockItemLock: "lock_in_inventory",
			bedrockKeepOnDeath: true,
			bedrockCanDestroy: [{ block: "stone" }, { block: "dirt" }],
		},
	});
	assert.equal(
		buildBedrockCommand(s).command,
		'/give @p minecraft:diamond_sword 1 0 {"minecraft:can_destroy":{"blocks":["stone","dirt"]},"minecraft:item_lock":{"mode":"lock_in_inventory"},"minecraft:keep_on_death":{}}'
	);
});

test("bedrock: raw JSON is merged", () => {
	const s = makeState({
		platform: "bedrock",
		values: { bedrockRawComponents: '{"minecraft:item_lock":{"mode":"lock_in_slot"}}' },
	});
	assert.equal(
		buildBedrockCommand(s).command,
		'/give @p minecraft:diamond_sword 1 0 {"minecraft:item_lock":{"mode":"lock_in_slot"}}'
	);
});

test("bedrock: invalid raw JSON reports an error", () => {
	const s = makeState({
		platform: "bedrock",
		values: { bedrockRawComponents: "{not json" },
	});
	const result = buildBedrockCommand(s);
	assert.equal(result.command, "");
	assert.equal(result.error, "errorRawJson");
});

test("bedrock: raw JSON must be an object", () => {
	const s = makeState({
		platform: "bedrock",
		values: { bedrockRawComponents: "[1,2,3]" },
	});
	const result = buildBedrockCommand(s);
	assert.equal(result.error, "errorRawJsonObject");
});

test("java: fire resistant emits damage_resistant", () => {
	const s = makeState({ values: { fireResistant: true } });
	assert.equal(
		buildJavaCommand(s).command,
		'/give @p minecraft:diamond_sword[minecraft:damage_resistant={types:"#minecraft:is_fire"}] 1'
	);
});

test("java: player head profile by name and by UUID int array", () => {
	const byName = makeState({ values: { profileType: "name", profileName: "Notch" } });
	assert.equal(
		buildJavaCommand(byName).command,
		'/give @p minecraft:diamond_sword[minecraft:profile={name:"Notch"}] 1'
	);
	const byUuid = makeState({ values: { profileType: "uuid", profileName: "069a79f4-44e9-4726-a5be-fca90e38aaf5" } });
	assert.equal(
		buildJavaCommand(byUuid).command,
		'/give @p minecraft:diamond_sword[minecraft:profile={id:[I;110787060,1156138790,-1514210135,238594805]}] 1'
	);
});

test("java: sign text is stored in the sign block entity", () => {
	const s = makeState({
		values: {
			signText1: "Hello",
			signText2: "Line 2",
			signText3: "",
			signText4: "",
			signTextColor: "black",
			signTextGlow: false,
		},
	});
	assert.equal(
		buildJavaCommand(s).command,
		"/give @p minecraft:diamond_sword[minecraft:block_entity_data={id:\"minecraft:sign\",front_text:{messages:['{\"text\":\"Hello\"}','{\"text\":\"Line 2\"}','{\"text\":\"\"}','{\"text\":\"\"}'],color:\"black\",has_glowing_text:0b}}] 1"
	);
});

test("java: raw block entity data is skipped when sign text is set", () => {
	const s = makeState({
		values: { signText1: "Hi", signText2: "", signText3: "", signText4: "", blockEntityData: '{id:"chest"}' },
	});
	const cmd = buildJavaCommand(s).command;
	assert.ok(cmd.includes('minecraft:block_entity_data={id:"minecraft:sign"'));
	assert.ok(!cmd.includes('{id:"chest"}'));
});

// ---- kitchen sink (realistic combined commands) ----

test("java: many options combine in a valid order", () => {
	const s = makeState({
		values: {
			customName: "Sword of Power",
			customNameColor: "light_purple",
			lore: "Line 1\nLine 2",
			enchantments: [{ enchantment: "sharpness", level: 5 }, { enchantment: "mending", level: 1 }],
			unbreakable: true,
			rarity: "epic",
			glint: "false",
			canBreak: "#mineable/pickaxe",
			canPlaceOn: "minecraft:stone",
			fireResistant: true,
		},
	});
	const cmd = buildJavaCommand(s).command;
	assert.ok(cmd.startsWith("/give @p minecraft:diamond_sword["));
	assert.ok(cmd.includes("minecraft:custom_name='{\"text\":\"Sword of Power\",\"color\":\"light_purple\"}'"));
	assert.ok(cmd.includes("minecraft:lore=['{\"text\":\"Line 1\"}','{\"text\":\"Line 2\"}']"));
	assert.ok(cmd.includes('minecraft:enchantments={"minecraft:sharpness":5,"minecraft:mending":1}'));
	assert.ok(cmd.includes("minecraft:unbreakable={}"));
	assert.ok(cmd.includes('minecraft:rarity="epic"'));
	assert.ok(cmd.includes("minecraft:enchantment_glint_override=false"));
	assert.ok(cmd.includes('minecraft:can_break={blocks:"#mineable/pickaxe"}'));
	assert.ok(cmd.includes('minecraft:can_place_on={blocks:"minecraft:stone"}'));
	assert.ok(cmd.includes('minecraft:damage_resistant={types:"#minecraft:is_fire"}'));
	assert.ok(cmd.endsWith(" 1"));
});

test("bedrock: many options combine into one JSON object", () => {
	const s = makeState({
		platform: "bedrock",
		count: 16,
		dataValue: 3,
		dataOverridden: true,
		values: {
			bedrockCanDestroy: [{ block: "stone" }, { block: "dirt" }],
			bedrockCanPlaceOn: [{ block: "grass_block" }],
			bedrockItemLock: "lock_in_slot",
			bedrockKeepOnDeath: true,
		},
	});
	const cmd = buildBedrockCommand(s).command;
	assert.equal(
		cmd,
		'/give @p minecraft:diamond_sword 16 3 {"minecraft:can_destroy":{"blocks":["stone","dirt"]},"minecraft:can_place_on":{"blocks":["grass_block"]},"minecraft:item_lock":{"mode":"lock_in_slot"},"minecraft:keep_on_death":{}}'
	);
});

// ---- dispatch ----

test("buildCommand dispatches by platform", () => {
	assert.equal(buildCommand(makeState()).command, "/give @p minecraft:diamond_sword 1");
	assert.equal(
		buildCommand(makeState({ platform: "bedrock" })).command,
		"/give @p minecraft:diamond_sword 1"
	);
});

// ---- Bedrock ID resolution (Java catalogue → Bedrock name/data) ----

test("bedrock: renamed block IDs are translated", () => {
	assert.equal(resolveBedrockItem("minecraft:item_frame").id, "frame");
	assert.equal(resolveBedrockItem("minecraft:glow_item_frame").id, "glow_frame");
	assert.equal(resolveBedrockItem("minecraft:snow").id, "snow_layer");
	assert.equal(resolveBedrockItem("minecraft:snow_block").id, "snow");
	assert.equal(resolveBedrockItem("minecraft:map").id, "empty_map");
	assert.equal(resolveBedrockItem("minecraft:scute").id, "turtle_scute");
	assert.equal(resolveBedrockItem("minecraft:note_block").id, "noteblock");
	assert.equal(resolveBedrockItem("minecraft:monster_spawner").id, "mob_spawner");
	assert.equal(resolveBedrockItem("minecraft:end_stone_bricks").id, "end_bricks");
	assert.equal(resolveBedrockItem("minecraft:magma_block").id, "magma");
	assert.equal(resolveBedrockItem("minecraft:nether_bricks").id, "nether_brick");
	assert.equal(resolveBedrockItem("minecraft:red_nether_bricks").id, "red_nether_brick");
	assert.equal(resolveBedrockItem("minecraft:terracotta").id, "hardened_clay");
	assert.equal(resolveBedrockItem("minecraft:item_frame").renamed, true);
});

test("bedrock: unchanged IDs pass through", () => {
	const r = resolveBedrockItem("minecraft:diamond_sword");
	assert.equal(r.id, "diamond_sword");
	assert.equal(r.available, true);
	assert.equal(r.renamed, undefined);
});

test("bedrock: beds map to bed + color data", () => {
	assert.deepEqual(resolveBedrockItem("minecraft:white_bed"), { id: "bed", data: 0, available: true, renamed: true });
	assert.deepEqual(resolveBedrockItem("minecraft:red_bed"), { id: "bed", data: 14, available: true, renamed: true });
	assert.deepEqual(resolveBedrockItem("minecraft:black_bed"), { id: "bed", data: 15, available: true, renamed: true });
});

test("bedrock: banners map to banner + color data", () => {
	assert.deepEqual(resolveBedrockItem("minecraft:black_banner"), { id: "banner", data: 15, available: true, renamed: true });
	assert.deepEqual(resolveBedrockItem("minecraft:light_blue_banner"), { id: "banner", data: 3, available: true, renamed: true });
});

test("bedrock: cauldron variants use data values", () => {
	assert.deepEqual(resolveBedrockItem("minecraft:cauldron").data, 0);
	assert.deepEqual(resolveBedrockItem("minecraft:water_cauldron"), { id: "cauldron", data: 1, available: true, renamed: true });
	assert.deepEqual(resolveBedrockItem("minecraft:powder_snow_cauldron").data, 3);
});

test("bedrock: potions resolve to data values (splash +64, lingering +128)", () => {
	assert.deepEqual(resolveBedrockItem("minecraft:potion_of_swiftness"), { id: "potion", data: 14, available: true, renamed: true });
	assert.deepEqual(resolveBedrockItem("minecraft:potion_of_swiftness_II").data, 16);
	assert.deepEqual(resolveBedrockItem("minecraft:potion_of_swiftness_extended").data, 15);
	assert.deepEqual(resolveBedrockItem("minecraft:splash_potion_of_swiftness").id, "splash_potion");
	assert.deepEqual(resolveBedrockItem("minecraft:splash_potion_of_swiftness").data, 78);
	assert.deepEqual(resolveBedrockItem("minecraft:lingering_potion_of_healing").data, 149);
	assert.deepEqual(resolveBedrockItem("minecraft:water_bottle").data, 0);
	assert.deepEqual(resolveBedrockItem("minecraft:awkward_potion").data, 4);
});

test("bedrock: tipped arrow maps to arrow with a data value", () => {
	assert.deepEqual(resolveBedrockItem("minecraft:tipped_arrow"), { id: "arrow", data: 6, available: true, renamed: true });
});

test("bedrock: unavailable items are flagged", () => {
	assert.equal(resolveBedrockItem("minecraft:bundle").available, false);
	assert.equal(resolveBedrockItem("minecraft:spectral_arrow").available, false);
	assert.equal(resolveBedrockItem("minecraft:glow_berries").available, false);
	assert.equal(resolveBedrockItem("minecraft:furnace_minecart").available, false);
});

test("bedrock: unavailable item blocks the command with an error", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:bundle" });
	const result = buildBedrockCommand(s);
	assert.equal(result.command, "");
	assert.equal(result.error, "errorBedrockUnavailable");
});

test("bedrock: mapped data value is applied automatically", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:red_bed" });
	assert.equal(buildBedrockCommand(s).command, "/give @p minecraft:bed 1 14");
});

test("bedrock: user-edited data value overrides the mapped one", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:red_bed", dataValue: 0, dataOverridden: true });
	assert.equal(buildBedrockCommand(s).command, "/give @p minecraft:bed 1");
});

test("bedrock: renamed item is emitted with its Bedrock ID", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:item_frame" });
	assert.equal(buildBedrockCommand(s).command, "/give @p minecraft:frame 1");
	const mapState = makeState({ platform: "bedrock", itemId: "minecraft:map" });
	assert.equal(buildBedrockCommand(mapState).command, "/give @p minecraft:empty_map 1");
});

// ---- Bedrock potion / arrow data dropdown ----

test("bedrock: potion data list covers all effects in ascending order", () => {
	const list = bedrockPotionDataList("potion");
	const byData = new Map(list.map((e) => [e.data, e]));
	assert.equal(byData.get(0).base, "water");
	assert.equal(byData.get(2).base, "long_mundane");
	assert.equal(byData.get(4).base, "awkward");
	assert.equal(byData.get(5).effect, "night_vision");
	assert.equal(byData.get(14).effect, "swiftness");
	assert.equal(byData.get(15).effect, "swiftness");
	assert.equal(byData.get(15).variant, "extended");
	assert.equal(byData.get(16).effect, "swiftness");
	assert.equal(byData.get(16).variant, "II");
	assert.equal(byData.get(36).effect, "decay");
	assert.equal(byData.get(42).effect, "slowness");
	assert.equal(byData.get(42).variant, "II");
	assert.equal(byData.get(46).effect, "infested");
	const datas = list.map((e) => e.data);
	assert.deepEqual(datas, [...datas].sort((a, b) => a - b));
});

test("bedrock: arrow data list is potion data + 1", () => {
	const list = bedrockPotionDataList("arrow");
	const byData = new Map(list.map((e) => [e.data, e]));
	assert.equal(byData.get(0).base, "arrow");
	assert.equal(byData.get(1).base, "splashing");
	assert.equal(byData.get(2).base, "mundane");
	assert.equal(byData.get(5).base, "awkward");
	assert.equal(byData.get(6).effect, "night_vision");
	assert.equal(byData.get(15).effect, "swiftness");
	assert.equal(byData.get(43).effect, "slowness");
	assert.equal(byData.get(43).variant, "II");
	assert.equal(byData.get(47).effect, "infested");
});
