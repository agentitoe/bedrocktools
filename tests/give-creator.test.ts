import { test, expect } from "bun:test";
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
	expect(snbtStr("hello")).toBe('"hello"');
	expect(snbtStr('say "hi"')).toBe('"say \\"hi\\""');
});

test("snbtJson wraps JSON in single quotes and escapes them", () => {
	expect(snbtJson('{"text":"hi"}')).toBe("'{\"text\":\"hi\"}'");
	expect(snbtJson("it's")).toBe("'it\\'s'");
});

test("textComponent builds a JSON text component", () => {
	expect(textComponent("Hi")).toBe('{"text":"Hi"}');
	expect(textComponent("Hi", "gold")).toBe('{"text":"Hi","color":"gold"}');
	expect(textComponent("Hi", "white", false)).toBe('{"text":"Hi","italic":false}');
	expect(textComponent("Hi", "red", false, true)).toBe('{"text":"Hi","color":"red","italic":false,"bold":true}');
});

test("parseBlockList splits on commas and whitespace", () => {
	expect(parseBlockList("minecraft:stone, #mineable/pickaxe  dirt")).toEqual([
		"minecraft:stone",
		"#mineable/pickaxe",
		"dirt",
	]);
	expect(parseBlockList("  ")).toEqual([]);
});

test("parseColor accepts hex and decimal", () => {
	expect(parseColor("#ff0000")).toBe(16711680);
	expect(parseColor("65280")).toBe(65280);
	expect(parseColor("nope")).toBeNull();
});

test("parseColorList parses mixed hex and decimal", () => {
	expect(parseColorList("#ff0000, 65280, #0000ff")).toEqual([16711680, 65280, 255]);
});

// ---- Java ----

test("java: minimal command", () => {
	const s = makeState();
	expect(buildJavaCommand(s).command).toBe("/give @p minecraft:diamond_sword 1");
});

test("java: custom name with color", () => {
	const s = makeState({ values: { customName: "Espada", customNameColor: "gold" } });
	expect(
		buildJavaCommand(s).command
	).toBe("/give @p minecraft:diamond_sword[minecraft:custom_name='{\"text\":\"Espada\",\"color\":\"gold\"}'] 1");
});

test("java: lore becomes a list of JSON components", () => {
	const s = makeState({ values: { lore: "Line one\nLine two" } });
	expect(
		buildJavaCommand(s).command
	).toBe("/give @p minecraft:diamond_sword[minecraft:lore=['{\"text\":\"Line one\"}','{\"text\":\"Line two\"}']] 1");
});

test("java: enchantments are a direct enchantment->level map", () => {
	const s = makeState({
		values: { enchantments: [{ enchantment: "sharpness", level: 5 }, { enchantment: "fire_aspect", level: "2" }] },
	});
	expect(
		buildJavaCommand(s).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:enchantments={"minecraft:sharpness":5,"minecraft:fire_aspect":2}] 1');
});

test("java: stored enchantments for enchanted books", () => {
	const s = makeState({
		values: { storedEnchantments: true, enchantments: [{ enchantment: "mending", level: 1 }] },
	});
	expect(
		buildJavaCommand(s).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:stored_enchantments={"minecraft:mending":1}] 1');
});

test("java: durability options", () => {
	const s = makeState({ values: { damage: "500", maxDamage: "1000", unbreakable: true } });
	expect(
		buildJavaCommand(s).command
	).toBe("/give @p minecraft:diamond_sword[minecraft:damage=500,minecraft:max_damage=1000,minecraft:unbreakable={}] 1");
});

test("java: can_break single block vs list", () => {
	const single = makeState({ values: { canBreak: "minecraft:stone" } });
	expect(
		buildJavaCommand(single).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:can_break={blocks:"minecraft:stone"}] 1');
	const multi = makeState({ values: { canBreak: "minecraft:stone, #mineable/pickaxe" } });
	expect(
		buildJavaCommand(multi).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:can_break={blocks:["minecraft:stone","#mineable/pickaxe"]}] 1');
});

test("java: dyed color converts hex to decimal", () => {
	const s = makeState({ values: { dyedColor: "#ff0000" } });
	expect(
		buildJavaCommand(s).command
	).toBe("/give @p minecraft:diamond_sword[minecraft:dyed_color=16711680] 1");
});

test("java: armor trim", () => {
	const s = makeState({ values: { trimMaterial: "quartz", trimPattern: "sentry" } });
	expect(
		buildJavaCommand(s).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:trim={material:"minecraft:quartz",pattern:"minecraft:sentry"}] 1');
});

test("java: potion preset vs custom effects (seconds to ticks)", () => {
	const preset = makeState({ values: { potion: "night_vision" } });
	expect(
		buildJavaCommand(preset).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:potion_contents={potion:"minecraft:night_vision"}] 1');
	const custom = makeState({
		values: { potion: "custom", potionEffects: [{ effect: "strength", duration: 60, amplifier: 1 }] },
	});
	expect(
		buildJavaCommand(custom).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:potion_contents={custom_effects:[{id:"minecraft:strength",amplifier:1,duration:1200}]}] 1');
});

test("java: fireworks", () => {
	const s = makeState({
		values: {
			fireworkFlight: "2",
			fireworkExplosions: [{ shape: "star", colors: "#ff0000, 65280", fade: "#ffffff", trail: true, twinkle: false }],
		},
	});
	expect(
		buildJavaCommand(s).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:fireworks={flight_duration:2,explosions:[{shape:"star",colors:[16711680,65280],fade_colors:[16777215],has_trail:true,has_twinkle:false}]}] 1');
});

test("java: attribute modifiers", () => {
	const s = makeState({
		values: {
			attributes: [{ attribute: "minecraft:attack_damage", slot: "mainhand", operation: "add_value", amount: 5, name: "" }],
		},
	});
	expect(
		buildJavaCommand(s).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:attribute_modifiers=[{type:"minecraft:attack_damage",slot:"mainhand",id:"give:modifier_1",amount:5,operation:"add_value"}]] 1');
});

test("java: custom target falls back to @p when empty", () => {
	const s = makeState({ target: "custom", customTarget: "Steve" });
	expect(buildJavaCommand(s).command).toBe("/give Steve minecraft:diamond_sword 1");
	const empty = makeState({ target: "custom", customTarget: "  " });
	expect(buildJavaCommand(empty).command).toBe("/give @p minecraft:diamond_sword 1");
});

test("java: missing item reports an error", () => {
	const s = makeState({ itemId: "  " });
	const result = buildJavaCommand(s);
	expect(result.command).toBe("");
	expect(result.error).toBe("errorNoItem");
});

// ---- Bedrock ----

test("bedrock: minimal command", () => {
	const s = makeState({ platform: "bedrock" });
	expect(buildBedrockCommand(s).command).toBe("/give @p minecraft:diamond_sword 1");
});

test("bedrock: data value included when non-zero (user-edited)", () => {
	const s = makeState({ platform: "bedrock", dataValue: 5, dataOverridden: true });
	expect(buildBedrockCommand(s).command).toBe("/give @p minecraft:diamond_sword 1 5");
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
	expect(
		buildBedrockCommand(s).command
	).toBe('/give @p minecraft:diamond_sword 1 0 {"minecraft:can_destroy":{"blocks":["stone","dirt"]},"minecraft:item_lock":{"mode":"lock_in_inventory"},"minecraft:keep_on_death":{}}');
});

test("bedrock: raw JSON is merged", () => {
	const s = makeState({
		platform: "bedrock",
		values: { bedrockRawComponents: '{"minecraft:item_lock":{"mode":"lock_in_slot"}}' },
	});
	expect(
		buildBedrockCommand(s).command
	).toBe('/give @p minecraft:diamond_sword 1 0 {"minecraft:item_lock":{"mode":"lock_in_slot"}}');
});

test("bedrock: invalid raw JSON reports an error", () => {
	const s = makeState({
		platform: "bedrock",
		values: { bedrockRawComponents: "{not json" },
	});
	const result = buildBedrockCommand(s);
	expect(result.command).toBe("");
	expect(result.error).toBe("errorRawJson");
});

test("bedrock: raw JSON must be an object", () => {
	const s = makeState({
		platform: "bedrock",
		values: { bedrockRawComponents: "[1,2,3]" },
	});
	const result = buildBedrockCommand(s);
	expect(result.error).toBe("errorRawJsonObject");
});

test("java: fire resistant emits damage_resistant", () => {
	const s = makeState({ values: { fireResistant: true } });
	expect(
		buildJavaCommand(s).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:damage_resistant={types:"#minecraft:is_fire"}] 1');
});

test("java: player head profile by name and by UUID int array", () => {
	const byName = makeState({ values: { profileType: "name", profileName: "Notch" } });
	expect(
		buildJavaCommand(byName).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:profile={name:"Notch"}] 1');
	const byUuid = makeState({ values: { profileType: "uuid", profileName: "069a79f4-44e9-4726-a5be-fca90e38aaf5" } });
	expect(
		buildJavaCommand(byUuid).command
	).toBe('/give @p minecraft:diamond_sword[minecraft:profile={id:[I;110787060,1156138790,-1514210135,238594805]}] 1');
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
	expect(
		buildJavaCommand(s).command
	).toBe("/give @p minecraft:diamond_sword[minecraft:block_entity_data={id:\"minecraft:sign\",front_text:{messages:['{\"text\":\"Hello\"}','{\"text\":\"Line 2\"}','{\"text\":\"\"}','{\"text\":\"\"}'],color:\"black\",has_glowing_text:0b}}] 1");
});

test("java: raw block entity data is skipped when sign text is set", () => {
	const s = makeState({
		values: { signText1: "Hi", signText2: "", signText3: "", signText4: "", blockEntityData: '{id:"chest"}' },
	});
	const cmd = buildJavaCommand(s).command;
	expect(cmd.includes('minecraft:block_entity_data={id:"minecraft:sign"')).toBe(true);
	expect(cmd.includes('{id:"chest"}')).toBe(false);
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
	expect(cmd.startsWith("/give @p minecraft:diamond_sword[")).toBe(true);
	expect(cmd.includes("minecraft:custom_name='{\"text\":\"Sword of Power\",\"color\":\"light_purple\"}'")).toBe(true);
	expect(cmd.includes("minecraft:lore=['{\"text\":\"Line 1\"}','{\"text\":\"Line 2\"}']")).toBe(true);
	expect(cmd.includes('minecraft:enchantments={"minecraft:sharpness":5,"minecraft:mending":1}')).toBe(true);
	expect(cmd.includes("minecraft:unbreakable={}")).toBe(true);
	expect(cmd.includes('minecraft:rarity="epic"')).toBe(true);
	expect(cmd.includes("minecraft:enchantment_glint_override=false")).toBe(true);
	expect(cmd.includes('minecraft:can_break={blocks:"#mineable/pickaxe"}')).toBe(true);
	expect(cmd.includes('minecraft:can_place_on={blocks:"minecraft:stone"}')).toBe(true);
	expect(cmd.includes('minecraft:damage_resistant={types:"#minecraft:is_fire"}')).toBe(true);
	expect(cmd.endsWith(" 1")).toBe(true);
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
	expect(
		cmd
	).toBe('/give @p minecraft:diamond_sword 16 3 {"minecraft:can_destroy":{"blocks":["stone","dirt"]},"minecraft:can_place_on":{"blocks":["grass_block"]},"minecraft:item_lock":{"mode":"lock_in_slot"},"minecraft:keep_on_death":{}}');
});

// ---- dispatch ----

test("buildCommand dispatches by platform", () => {
	expect(buildCommand(makeState()).command).toBe("/give @p minecraft:diamond_sword 1");
	expect(
		buildCommand(makeState({ platform: "bedrock" })).command
	).toBe("/give @p minecraft:diamond_sword 1");
});

// ---- Bedrock ID resolution (Java catalogue → Bedrock name/data) ----

test("bedrock: renamed block IDs are translated", () => {
	expect(resolveBedrockItem("minecraft:item_frame").id).toBe("frame");
	expect(resolveBedrockItem("minecraft:glow_item_frame").id).toBe("glow_frame");
	expect(resolveBedrockItem("minecraft:snow").id).toBe("snow_layer");
	expect(resolveBedrockItem("minecraft:snow_block").id).toBe("snow");
	expect(resolveBedrockItem("minecraft:map").id).toBe("empty_map");
	expect(resolveBedrockItem("minecraft:scute").id).toBe("turtle_scute");
	expect(resolveBedrockItem("minecraft:note_block").id).toBe("noteblock");
	expect(resolveBedrockItem("minecraft:monster_spawner").id).toBe("mob_spawner");
	expect(resolveBedrockItem("minecraft:end_stone_bricks").id).toBe("end_bricks");
	expect(resolveBedrockItem("minecraft:magma_block").id).toBe("magma");
	expect(resolveBedrockItem("minecraft:nether_bricks").id).toBe("nether_brick");
	expect(resolveBedrockItem("minecraft:red_nether_bricks").id).toBe("red_nether_brick");
	expect(resolveBedrockItem("minecraft:terracotta").id).toBe("hardened_clay");
	expect(resolveBedrockItem("minecraft:item_frame").renamed).toBe(true);
});

test("bedrock: unchanged IDs pass through", () => {
	const r = resolveBedrockItem("minecraft:diamond_sword");
	expect(r.id).toBe("diamond_sword");
	expect(r.available).toBe(true);
	expect(r.renamed).toBeUndefined();
});

test("bedrock: beds map to bed + color data", () => {
	expect(resolveBedrockItem("minecraft:white_bed")).toEqual({ id: "bed", data: 0, available: true, renamed: true });
	expect(resolveBedrockItem("minecraft:red_bed")).toEqual({ id: "bed", data: 14, available: true, renamed: true });
	expect(resolveBedrockItem("minecraft:black_bed")).toEqual({ id: "bed", data: 15, available: true, renamed: true });
});

test("bedrock: banners map to banner + color data", () => {
	expect(resolveBedrockItem("minecraft:black_banner")).toEqual({ id: "banner", data: 15, available: true, renamed: true });
	expect(resolveBedrockItem("minecraft:light_blue_banner")).toEqual({ id: "banner", data: 3, available: true, renamed: true });
});

test("bedrock: cauldron variants use data values", () => {
	expect(resolveBedrockItem("minecraft:cauldron").data).toBe(0);
	expect(resolveBedrockItem("minecraft:water_cauldron")).toEqual({ id: "cauldron", data: 1, available: true, renamed: true });
	expect(resolveBedrockItem("minecraft:powder_snow_cauldron").data).toBe(3);
});

test("bedrock: potions resolve to data values (splash +64, lingering +128)", () => {
	expect(resolveBedrockItem("minecraft:potion_of_swiftness")).toEqual({ id: "potion", data: 14, available: true, renamed: true });
	expect(resolveBedrockItem("minecraft:potion_of_swiftness_II").data).toBe(16);
	expect(resolveBedrockItem("minecraft:potion_of_swiftness_extended").data).toBe(15);
	expect(resolveBedrockItem("minecraft:splash_potion_of_swiftness").id).toBe("splash_potion");
	expect(resolveBedrockItem("minecraft:splash_potion_of_swiftness").data).toBe(78);
	expect(resolveBedrockItem("minecraft:lingering_potion_of_healing").data).toBe(149);
	expect(resolveBedrockItem("minecraft:water_bottle").data).toBe(0);
	expect(resolveBedrockItem("minecraft:awkward_potion").data).toBe(4);
});

test("bedrock: tipped arrow maps to arrow with a data value", () => {
	expect(resolveBedrockItem("minecraft:tipped_arrow")).toEqual({ id: "arrow", data: 6, available: true, renamed: true });
});

test("bedrock: unavailable items are flagged", () => {
	expect(resolveBedrockItem("minecraft:bundle").available).toBe(false);
	expect(resolveBedrockItem("minecraft:spectral_arrow").available).toBe(false);
	expect(resolveBedrockItem("minecraft:glow_berries").available).toBe(false);
	expect(resolveBedrockItem("minecraft:furnace_minecart").available).toBe(false);
});

test("bedrock: unavailable item blocks the command with an error", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:bundle" });
	const result = buildBedrockCommand(s);
	expect(result.command).toBe("");
	expect(result.error).toBe("errorBedrockUnavailable");
});

test("bedrock: mapped data value is applied automatically", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:red_bed" });
	expect(buildBedrockCommand(s).command).toBe("/give @p minecraft:bed 1 14");
});

test("bedrock: user-edited data value overrides the mapped one", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:red_bed", dataValue: 0, dataOverridden: true });
	expect(buildBedrockCommand(s).command).toBe("/give @p minecraft:bed 1");
});

test("bedrock: renamed item is emitted with its Bedrock ID", () => {
	const s = makeState({ platform: "bedrock", itemId: "minecraft:item_frame" });
	expect(buildBedrockCommand(s).command).toBe("/give @p minecraft:frame 1");
	const mapState = makeState({ platform: "bedrock", itemId: "minecraft:map" });
	expect(buildBedrockCommand(mapState).command).toBe("/give @p minecraft:empty_map 1");
});

// ---- Bedrock potion / arrow data dropdown ----

test("bedrock: potion data list covers all effects in ascending order", () => {
	const list = bedrockPotionDataList("potion");
	const byData = new Map(list.map((e) => [e.data, e]));
	expect(byData.get(0)!.base).toBe("water");
	expect(byData.get(2)!.base).toBe("long_mundane");
	expect(byData.get(4)!.base).toBe("awkward");
	expect(byData.get(5)!.effect).toBe("night_vision");
	expect(byData.get(14)!.effect).toBe("swiftness");
	expect(byData.get(15)!.effect).toBe("swiftness");
	expect(byData.get(15)!.variant).toBe("extended");
	expect(byData.get(16)!.effect).toBe("swiftness");
	expect(byData.get(16)!.variant).toBe("II");
	expect(byData.get(36)!.effect).toBe("decay");
	expect(byData.get(42)!.effect).toBe("slowness");
	expect(byData.get(42)!.variant).toBe("II");
	expect(byData.get(46)!.effect).toBe("infested");
	const datas = list.map((e) => e.data);
	expect(datas).toEqual([...datas].sort((a, b) => a - b));
});

test("bedrock: arrow data list is potion data + 1", () => {
	const list = bedrockPotionDataList("arrow");
	const byData = new Map(list.map((e) => [e.data, e]));
	expect(byData.get(0)!.base).toBe("arrow");
	expect(byData.get(1)!.base).toBe("splashing");
	expect(byData.get(2)!.base).toBe("mundane");
	expect(byData.get(5)!.base).toBe("awkward");
	expect(byData.get(6)!.effect).toBe("night_vision");
	expect(byData.get(15)!.effect).toBe("swiftness");
	expect(byData.get(43)!.effect).toBe("slowness");
	expect(byData.get(43)!.variant).toBe("II");
	expect(byData.get(47)!.effect).toBe("infested");
});
