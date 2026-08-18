import { test } from "node:test";
import assert from "node:assert/strict";
import { stripJsonComments } from "../src/shared/json";
import { decodeUtf8Sig } from "../src/shared/encoding";
import { normalizePath } from "../src/shared/path";

test("stripJsonComments removes line comments", () => {
	assert.equal(stripJsonComments('{"a":1// comment\n}'), '{"a":1\n}');
});

test("stripJsonComments removes block comments", () => {
	assert.equal(stripJsonComments('{"a"/* x */:1}'), '{"a":1}');
});

test("stripJsonComments preserves comment markers inside strings", () => {
	assert.equal(stripJsonComments('{"url":"http://a/*b*///c"}'), '{"url":"http://a/*b*///c"}');
});

test("stripJsonComments trims surrounding whitespace", () => {
	assert.equal(stripJsonComments('  {}\n\t'), '{}');
});

test("decodeUtf8Sig strips a UTF-8 BOM", () => {
	const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
	assert.equal(decodeUtf8Sig(withBom), "hi");
});

test("decodeUtf8Sig leaves BOM-less input intact", () => {
	assert.equal(decodeUtf8Sig(new Uint8Array([0x68, 0x69])), "hi");
});

test("normalizePath converts backslashes to forward slashes", () => {
	assert.equal(normalizePath("a\\b\\c"), "a/b/c");
	assert.equal(normalizePath("a/b/c"), "a/b/c");
});
