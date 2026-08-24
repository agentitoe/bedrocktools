import { test, expect } from "bun:test";
import { sanitizeName, titleCase, escapeHtml, isValidIdentifier, parseJsonText } from "../src/tools/recipe-creator/util";

test("sanitizeName lowercases and replaces invalid characters", () => {
	expect(sanitizeName("My Cool Pack!")).toBe("my_cool_pack_");
	expect(sanitizeName("Already_Valid-1.0")).toBe("already_valid-1.0");
});

test("titleCase capitalizes words separated by spaces and underscores", () => {
	expect(titleCase("hello world")).toBe("Hello World");
	expect(titleCase("hello_world")).toBe("Hello_World");
	expect(titleCase("hello-world")).toBe("Hello-World");
});

test("escapeHtml escapes the four dangerous characters", () => {
	expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test("isValidIdentifier accepts namespaced identifiers", () => {
	expect(isValidIdentifier("minecraft:stick")).toBe(true);
	expect(isValidIdentifier("my-pack:foo.bar-baz")).toBe(true);
	expect(isValidIdentifier("no-namespace")).toBe(false);
	expect(isValidIdentifier("UPPER:case")).toBe(false);
});

test("parseJsonText parses JSON that contains comments", () => {
	expect(parseJsonText('{ // comment\n "a": 1 }')).toEqual({ a: 1 });
});

test("parseJsonText returns null for invalid JSON", () => {
	expect(parseJsonText("{ not json")).toBeNull();
});
