import { test, expect } from "bun:test";
import {
	projectToIsometric,
	projectFaces,
	sortFacesByDepth,
	fitToCanvas,
	calculateBounds
} from "../src/tools/minecraft-items/isometric-projector";

test("projectToIsometric keeps x and flips y for canvas space", () => {
	expect(projectToIsometric({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: -2 });
});

test("projectFaces culls faces whose normal points away from the camera", () => {
	const faces = [
		{
			vertices: [
				{ x: 0, y: 0, z: 0 },
				{ x: 1, y: 0, z: 0 },
				{ x: 1, y: 1, z: 0 },
				{ x: 0, y: 1, z: 0 }
			],
			uv: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }],
			textureRef: "front",
			normal: { x: 0, y: 0, z: 1 }
		},
		{
			// Reversed winding -> normal points toward -Z and gets culled.
			vertices: [
				{ x: 0, y: 0, z: 0 },
				{ x: 0, y: 1, z: 0 },
				{ x: 1, y: 1, z: 0 },
				{ x: 1, y: 0, z: 0 }
			],
			uv: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }],
			textureRef: "back",
			normal: { x: 0, y: 0, z: -1 }
		}
	];

	const projected = projectFaces(faces);
	expect(projected.length).toBe(1);
	expect(projected[0].textureRef).toBe("front");
});

test("sortFacesByDepth sorts back to front without mutating the input", () => {
	const a = { vertices: [], uv: [], textureRef: "a", avgDepth: 1, normal: { x: 0, y: 0, z: 1 } };
	const b = { vertices: [], uv: [], textureRef: "b", avgDepth: 5, normal: { x: 0, y: 0, z: 1 } };
	const c = { vertices: [], uv: [], textureRef: "c", avgDepth: 3, normal: { x: 0, y: 0, z: 1 } };

	const sorted = sortFacesByDepth([a, b, c]);
	expect(sorted.map((f) => f.textureRef)).toEqual(["a", "c", "b"]);
	expect([a, b, c].map((f) => f.textureRef)).toEqual(["a", "b", "c"]);
});

test("fitToCanvas scales and centers the geometry", () => {
	const face = {
		vertices: [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }],
		uv: [],
		textureRef: "t",
		avgDepth: 0,
		normal: { x: 0, y: 0, z: 1 }
	};

	const [fitted] = fitToCanvas([face], 100, 0);
	expect(fitted.vertices[0]).toEqual({ x: 0, y: 0 });
	expect(fitted.vertices[2]).toEqual({ x: 100, y: 100 });
});

test("fitToCanvas returns an empty array for empty input", () => {
	expect(fitToCanvas([], 100)).toEqual([]);
});

test("calculateBounds reports the min/max extents", () => {
	const face = {
		vertices: [{ x: -5, y: 3 }, { x: 7, y: -2 }],
		uv: [],
		textureRef: "t",
		avgDepth: 0,
		normal: { x: 0, y: 0, z: 1 }
	};

	expect(calculateBounds([face])).toEqual({ minX: -5, maxX: 7, minY: -2, maxY: 3 });
});
