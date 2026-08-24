import { test, expect } from "bun:test";
import { stripJsonComments } from "../src/shared/json";
import { decodeUtf8Sig } from "../src/shared/encoding";
import { normalizePath } from "../src/shared/path";

test("stripJsonComments removes line comments", () => {
	expect(stripJsonComments('{"a":1// comment\n}')).toBe('{"a":1\n}');
});

test("stripJsonComments removes block comments", () => {
	expect(stripJsonComments('{"a"/* x */:1}')).toBe('{"a":1}');
});

test("stripJsonComments preserves comment markers inside strings", () => {
	expect(stripJsonComments('{"url":"http://a/*b*///c"}')).toBe('{"url":"http://a/*b*///c"}');
});

test("stripJsonComments trims surrounding whitespace", () => {
	expect(stripJsonComments('  {}\n\t')).toBe('{}');
});

test("decodeUtf8Sig strips a UTF-8 BOM", () => {
	const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
	expect(decodeUtf8Sig(withBom)).toBe("hi");
});

test("decodeUtf8Sig leaves BOM-less input intact", () => {
	expect(decodeUtf8Sig(new Uint8Array([0x68, 0x69]))).toBe("hi");
});

test("normalizePath converts backslashes to forward slashes", () => {
	expect(normalizePath("a\\b\\c")).toBe("a/b/c");
	expect(normalizePath("a/b/c")).toBe("a/b/c");
});
