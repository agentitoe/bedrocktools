// Starter templates for creating a Behavior Pack, Resource Pack or full Addon
// from scratch. Each manifest gets fresh UUIDs and a valid `format_version`.
// The templates are intentionally minimal but loadable: they give the user a
// working skeleton to edit, not a finished pack.

import { encodeUtf8 } from "../../shared/encoding";
import type { FileMap } from "./pack";
import { sanitizeName } from "./pack";
import { uuid } from "../recipe-creator/util";

export type TemplateKind = "behavior" | "resource" | "addon";

function manifestJson(type: "data" | "resources", name: string, description: string): string {
	const m = {
		format_version: 2,
		header: {
			name,
			description,
			uuid: uuid(),
			version: [1, 0, 0],
			min_engine_version: [1, 20, 0],
		},
		modules: [
			{
				type,
				uuid: uuid(),
				version: [1, 0, 0],
			},
		],
	};
	return JSON.stringify(m, null, 2);
}

function exampleFunction(name: string): string {
	return "# Example function\n# Functions go in functions/ and run with: /function example\nsay Hello from " + name + "!\n";
}

function exampleLang(): string {
	return "## Custom texts\n## Format: item.<id>.name=Display name\ntile.example.name=Example Block\nitem.example.name=Example Item\n";
}

/**
 * Build the starter files for a pack. Returns a flat `path -> bytes` map where
 * the addon variant nests both packs under behavior_pack/ and resource_pack/.
 */
export function buildTemplate(kind: TemplateKind, rawName: string): FileMap {
	const name = sanitizeName(rawName) || "My Pack";
	const files: FileMap = {};

	if (kind === "behavior") {
		files["manifest.json"] = encodeUtf8(manifestJson("data", name, name + " — Behavior Pack"));
		files["functions/example.mcfunction"] = encodeUtf8(exampleFunction(name));
		files["texts/en_US.lang"] = encodeUtf8(exampleLang());
	} else if (kind === "resource") {
		files["manifest.json"] = encodeUtf8(manifestJson("resources", name, name + " — Resource Pack"));
		files["texts/en_US.lang"] = encodeUtf8(exampleLang());
	} else {
		files["behavior_pack/manifest.json"] = encodeUtf8(manifestJson("data", name + " BP", name + " — Behavior Pack"));
		files["behavior_pack/functions/example.mcfunction"] = encodeUtf8(exampleFunction(name));
		files["behavior_pack/texts/en_US.lang"] = encodeUtf8(exampleLang());
		files["resource_pack/manifest.json"] = encodeUtf8(manifestJson("resources", name + " RP", name + " — Resource Pack"));
		files["resource_pack/texts/en_US.lang"] = encodeUtf8(exampleLang());
	}

	return files;
}