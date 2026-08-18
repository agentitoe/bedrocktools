import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeName, titleCase, escapeHtml, isValidIdentifier, parseJsonText } from "../src/tools/recipe-creator/util";

test("sanitizeName lowercases and replaces invalid characters", () => {
	assert.equal(sanitizeName("My Cool Pack!"), "my_cool_pack_");
	assert.equal(sanitizeName("Already_Valid-1.0"), "already_valid-1.0");
});

test("titleCase capitalizes words separated by spaces and underscores", () => {
	assert.equal(titleCase("hello world"), "Hello World");
	assert.equal(titleCase("hello_world"), "Hello_World");
	assert.equal(titleCase("hello-world"), "Hello-World");
});

test("escapeHtml escapes the four dangerous characters", () => {
	assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test("isValidIdentifier accepts namespaced identifiers", () => {
	assert.equal(isValidIdentifier("minecraft:stick"), true);
	assert.equal(isValidIdentifier("my-pack:foo.bar-baz"), true);
	assert.equal(isValidIdentifier("no-namespace"), false);
	assert.equal(isValidIdentifier("UPPER:case"), false);
});

test("parseJsonText parses JSON that contains comments", () => {
	assert.deepEqual(parseJsonText('{ // comment\n "a": 1 }'), { a: 1 });
});

test("parseJsonText returns null for invalid JSON", () => {
	assert.equal(parseJsonText("{ not json"), null);
});
