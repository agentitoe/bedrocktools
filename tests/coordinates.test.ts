import { test, expect } from "bun:test";
import { convertCoordinates, formatCoord } from "../src/tools/coordinates-converter/convert";

test("Overworld -> Nether divides X and Z by 8", () => {
	expect(convertCoordinates(800, 64, -160, "toNether")).toEqual({ x: 100, y: 64, z: -20 });
});

test("Nether -> Overworld multiplies X and Z by 8", () => {
	expect(convertCoordinates(100, 64, -20, "toOverworld")).toEqual({ x: 800, y: 64, z: -160 });
});

test("Y (height) is unchanged in both directions", () => {
	expect(convertCoordinates(100, 70, 100, "toNether").y).toBe(70);
	expect(convertCoordinates(100, 70, 100, "toOverworld").y).toBe(70);
});

test("negative coordinates convert correctly", () => {
	expect(convertCoordinates(-800, 64, -160, "toNether")).toEqual({ x: -100, y: 64, z: -20 });
});

test("fractional results divide cleanly (powers of two)", () => {
	expect(convertCoordinates(1, 64, 100, "toNether")).toEqual({ x: 0.125, y: 64, z: 12.5 });
});

test("formatCoord keeps integers and rounds decimals to 3 places", () => {
	expect(formatCoord(125)).toBe(125);
	expect(formatCoord(0.5)).toBe(0.5);
	expect(formatCoord(10 / 3)).toBe(3.333);
});
