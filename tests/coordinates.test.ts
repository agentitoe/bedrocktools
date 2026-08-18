import { test } from "node:test";
import assert from "node:assert/strict";
import { convertCoordinates, formatCoord } from "../src/tools/coordinates-converter/convert";

test("Overworld -> Nether divides X and Z by 8", () => {
	assert.deepEqual(convertCoordinates(800, 64, -160, "toNether"), { x: 100, y: 64, z: -20 });
});

test("Nether -> Overworld multiplies X and Z by 8", () => {
	assert.deepEqual(convertCoordinates(100, 64, -20, "toOverworld"), { x: 800, y: 64, z: -160 });
});

test("Y (height) is unchanged in both directions", () => {
	assert.equal(convertCoordinates(100, 70, 100, "toNether").y, 70);
	assert.equal(convertCoordinates(100, 70, 100, "toOverworld").y, 70);
});

test("negative coordinates convert correctly", () => {
	assert.deepEqual(convertCoordinates(-800, 64, -160, "toNether"), { x: -100, y: 64, z: -20 });
});

test("fractional results divide cleanly (powers of two)", () => {
	assert.deepEqual(convertCoordinates(1, 64, 100, "toNether"), { x: 0.125, y: 64, z: 12.5 });
});

test("formatCoord keeps integers and rounds decimals to 3 places", () => {
	assert.equal(formatCoord(125), 125);
	assert.equal(formatCoord(0.5), 0.5);
	assert.equal(formatCoord(10 / 3), 3.333);
});
