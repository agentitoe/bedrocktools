// Pure coordinate conversion for the Minecraft coordinates calculator.
// Kept separate from index.ts (which wires up the DOM) so it can be unit-tested.

export type Direction = "toNether" | "toOverworld";

export interface Coordinates {
	x: number;
	y: number;
	z: number;
}

/**
 * Convert coordinates between the Overworld and the Nether using the 1:8
 * ratio. Only X and Z change; Y (height) is left untouched.
 */
export function convertCoordinates(x: number, y: number, z: number, direction: Direction): Coordinates {
	if (direction === "toNether") {
		return { x: x / 8, y, z: z / 8 };
	}
	return { x: x * 8, y, z: z * 8 };
}

/** Round to at most 3 decimals, keeping whole numbers as-is for display. */
export function formatCoord(num: number): number {
	if (Number.isInteger(num)) return num;
	return parseFloat(num.toFixed(3));
}
