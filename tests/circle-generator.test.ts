import { describe, expect, test } from "bun:test";
import {
	BEDROCK_FILL_VOLUME_LIMIT,
	COMMAND_PREVIEW_LIMIT,
	MAX_DIAMETER,
	MAX_HEIGHT,
	MAX_THICKNESS,
	MAX_TOTAL_BLOCKS,
	buildCommands,
	generateCircle,
	gridToWorldOrigin,
	isVolumeSafe,
	limitCommandsForPreview,
	sanitizeBlockName,
	type CircleShape,
} from "../src/tools/circle-generator/circle";

const ANCHOR = { x: 0, y: 64, z: 0 };

describe("generateCircle", () => {
	test("known cell counts for classic diameters", () => {
		const d5 = generateCircle({ diameter: 5, mode: "filled" });
		const d9 = generateCircle({ diameter: 9, mode: "filled" });
		const ring5 = generateCircle({ diameter: 5, mode: "hollow", thickness: 1 });
		const ring9 = generateCircle({ diameter: 9, mode: "hollow", thickness: 1 });

		expect(d5.cells.length).toBe(21);
		expect(d9.cells.length).toBe(69);
		expect(ring5.cells.length).toBe(12);
		expect(ring9.cells.length).toBe(32);
	});

	test("is symmetric on both axes for odd and even diameters", () => {
		const isMirrored = (shape: CircleShape, flip: (cell: { x: number; z: number }) => { x: number; z: number }) => {
			const keys = new Set(shape.cells.map((c) => `${c.x},${c.z}`));
			return shape.cells.every((cell) => {
				const mirrored = flip(cell);
				return keys.has(`${mirrored.x},${mirrored.z}`);
			});
		};
		const flipX = (shape: CircleShape) => (cell: { x: number; z: number }) => ({ x: shape.diameter - 1 - cell.x, z: cell.z });
		const flipZ = (shape: CircleShape) => (cell: { x: number; z: number }) => ({ x: cell.x, z: shape.diameter - 1 - cell.z });

		for (const diameter of [2, 3, 4, 5, 6, 8, 16, 17, 32]) {
			for (const mode of ["hollow", "filled"] as const) {
				const shape = generateCircle({ diameter, mode, thickness: 2 });
				expect(isMirrored(shape, flipX(shape))).toBe(true);
				expect(isMirrored(shape, flipZ(shape))).toBe(true);
			}
		}
	});

	test("hollow shapes are a subset of filled shapes", () => {
		const filled = generateCircle({ diameter: 7, mode: "filled" });
		const hollow = generateCircle({ diameter: 7, mode: "hollow", thickness: 1 });
		const filledKeys = new Set(filled.cells.map((c) => `${c.x},${c.z}`));
		expect(hollow.cells.length).toBeLessThan(filled.cells.length);
		for (const cell of hollow.cells) {
			expect(filledKeys.has(`${cell.x},${cell.z}`)).toBe(true);
		}
	});

	test("larger thickness adds cells until the ring becomes a disc", () => {
		const t1 = generateCircle({ diameter: 10, mode: "hollow", thickness: 1 });
		const t3 = generateCircle({ diameter: 10, mode: "hollow", thickness: 3 });
		const filled = generateCircle({ diameter: 10, mode: "filled" });
		expect(t1.cells.length).toBeLessThan(t3.cells.length);
		// A thickness covering the whole radius reproduces the filled disc.
		const full = generateCircle({ diameter: 10, mode: "hollow", thickness: 5 });
		expect(full.cells.length).toBe(filled.cells.length);
	});

	test("out-of-range inputs are clamped", () => {
		const huge = generateCircle({ diameter: 9999, mode: "filled" });
		expect(huge.diameter).toBe(MAX_DIAMETER);

		const thick = generateCircle({ diameter: 8, mode: "hollow", thickness: 100 });
		expect(thick.diameter).toBe(8);

		// Zero/negative clamps to the minimums.
		const tiny = generateCircle({ diameter: 0, mode: "hollow", thickness: -5 });
		expect(tiny.diameter).toBe(2);
		expect(tiny.cells.length).toBe(4);
	});

	test("bounds stay within the grid", () => {
		const shape = generateCircle({ diameter: 13, mode: "filled" });
		for (const cell of shape.cells) {
			expect(cell.x).toBeGreaterThanOrEqual(0);
			expect(cell.x).toBeLessThan(13);
			expect(cell.z).toBeGreaterThanOrEqual(0);
			expect(cell.z).toBeLessThan(13);
		}
	});
});

describe("config limits", () => {
	test("fill volume constant matches both editions", () => {
		expect(BEDROCK_FILL_VOLUME_LIMIT).toBe(32768);
	});

	test("maximum circle stays renderable", () => {
		const worst = generateCircle({ diameter: MAX_DIAMETER, mode: "filled" });
		expect(isVolumeSafe(worst.cells.length * MAX_HEIGHT)).toBe(false);
		expect(worst.cells.length * MAX_HEIGHT).toBeGreaterThanOrEqual(MAX_TOTAL_BLOCKS);
	});

	test("slider bounds are mutually consistent", () => {
		expect(MAX_HEIGHT).toBeGreaterThan(1);
		expect(MAX_THICKNESS).toBeGreaterThan(1);
		expect(COMMAND_PREVIEW_LIMIT).toBeGreaterThan(0);
	});
});

describe("sanitizeBlockName", () => {
	test("accepts plain and namespaced names", () => {
		expect(sanitizeBlockName("stone")).toBe("stone");
		expect(sanitizeBlockName(" minecraft:oak_planks ")).toBe("minecraft:oak_planks");
		expect(sanitizeBlockName("White_Concrete")).toBe("white_concrete");
	});

	test("rejects malformed input", () => {
		expect(() => sanitizeBlockName("bad name!")).toThrow();
		expect(() => sanitizeBlockName("")).toThrow();
		expect(() => sanitizeBlockName(";drop")).toThrow();
		expect(() => sanitizeBlockName("minecraft:")).toThrow();
	});
});

describe("gridToWorldOrigin", () => {
	test("odd diameters place the anchor on the center cell", () => {
		// d=5: the origin should be anchor - 2, so the middle cell is at the anchor.
		const origin = gridToWorldOrigin(5, ANCHOR);
		expect(origin.x).toBe(-2);
		expect(origin.y).toBe(64);
	});

	test("even diameters keep the anchor between the two center cells", () => {
		const origin = gridToWorldOrigin(6, ANCHOR);
		expect(origin.x).toBe(-3);
	});
});

describe("buildCommands", () => {
	test("flat filled circle uses horizontal /fill runs", () => {
		const shape = generateCircle({ diameter: 5, mode: "filled" });
		const result = buildCommands(shape, {
			block: "stone",
			anchorWorld: ANCHOR,
			height: 1,
		});

		// d=5 filled: rows go from z=-2 to z=2, merging contiguous x runs.
		expect(result.commands).toEqual([
			"/fill -1 64 -2 1 64 -2 stone",
			"/fill -2 64 -1 2 64 -1 stone",
			"/fill -2 64 0 2 64 0 stone",
			"/fill -2 64 1 2 64 1 stone",
			"/fill -1 64 2 1 64 2 stone",
		]);
		expect(result.blockCount).toBe(21);
		expect(result.commands.every((c) => c.startsWith("/fill"))).toBe(true);
	});

	test("single cells become /setblock commands", () => {
		const shape = generateCircle({ diameter: 2, mode: "hollow", thickness: 1 });
		const result = buildCommands(shape, {
			block: "glass",
			anchorWorld: ANCHOR,
			height: 1,
		});

		// origin is (-1, 64, -1): the 2x2 ring merges into two 2-cell runs.
		expect(result.commands).toEqual([
			"/fill -1 64 -1 0 64 -1 glass",
			"/fill -1 64 0 0 64 0 glass",
		]);
	});

	test("tall shapes use vertical runs so the height stays free", () => {
		const shape = generateCircle({ diameter: 5, mode: "hollow", thickness: 1 });
		const flat = buildCommands(shape, { block: "oak_planks", anchorWorld: ANCHOR, height: 1 });
		const cylinder = buildCommands(shape, { block: "oak_planks", anchorWorld: ANCHOR, height: 8 });

		expect(cylinder.commands.length).toBe(flat.blockCount);
		expect(cylinder.blockCount).toBe(flat.blockCount * 8);
		// First column (grid 1,0 → world -1,-2) spans the whole height.
		expect(cylinder.commands[0]).toBe("/fill -1 64 -2 -1 71 -2 oak_planks");
		// Column count matches cell count: one vertical run per column.
		expect(cylinder.commands.length).toBe(shape.cells.length);
	});

	test("block names are sanitized and namespaced names pass through", () => {
		const shape = generateCircle({ diameter: 3, mode: "filled" });
		const plain = buildCommands(shape, { block: "stone", anchorWorld: ANCHOR, height: 1 });
		const namespaced = buildCommands(shape, { block: "minecraft:stone", anchorWorld: ANCHOR, height: 1 });
		expect(plain.commands[0]).toContain(" stone");
		expect(namespaced.commands[0]).toContain(" minecraft:stone");
		expect(() =>
			buildCommands(shape, { block: "not a block!", anchorWorld: ANCHOR, height: 1 }),
		).toThrow();
	});

	test("every emitted command is valid syntax for Java and Bedrock", () => {
		const shape = generateCircle({ diameter: 32, mode: "filled" });
		const result = buildCommands(shape, {
			block: "white_concrete",
			anchorWorld: { x: -5000, y: 100, z: 7000 },
			height: 3,
		});
		// Commands either target a single position ("/setblock x y z block")
		// or a full box ("/fill x1 y1 z1 x2 y2 z2 block").
		const fillRe = /^\/fill -?\d+ \d+ -?\d+ -?\d+ \d+ -?\d+ [a-z0-9_]+$/;
		const setRe = /^\/setblock -?\d+ \d+ -?\d+ [a-z0-9_]+$/;
		for (const command of result.commands) {
			expect(fillRe.test(command) || setRe.test(command)).toBe(true);
		}
		// Worst-case run volume never breaks the 32768 per-command cap.
		for (const command of result.commands) {
			const parts = command.split(" ");
			if (parts[0] === "/fill") {
				const dx = Math.abs(Number(parts[4]) - Number(parts[1]));
				const dy = Math.abs(Number(parts[5]) - Number(parts[2]));
				const dz = Math.abs(Number(parts[6]) - Number(parts[3]));
				expect((dx + 1) * (dy + 1) * (dz + 1)).toBeLessThanOrEqual(BEDROCK_FILL_VOLUME_LIMIT);
			}
		}
	});
});

describe("limitCommandsForPreview", () => {
	test("short lists pass through untouched", () => {
		const commands = ["/setblock 0 64 0 stone"];
		const preview = limitCommandsForPreview(commands);
		expect(preview.lines).toEqual(commands);
		expect(preview.hidden).toBe(0);
	});

	test("long lists are truncated and downloads stay complete", () => {
		const commands = Array.from({ length: COMMAND_PREVIEW_LIMIT + 10 }, (_, i) => `/setblock 0 64 ${i} stone`);
		const preview = limitCommandsForPreview(commands);
		expect(preview.lines.length).toBe(COMMAND_PREVIEW_LIMIT);
		expect(preview.hidden).toBe(10);
		expect(commands.length).toBe(COMMAND_PREVIEW_LIMIT + 10);
	});

	test(".mcfunction downloads remain unaffected by the preview cut", () => {
		// Vertical runs (height > 1) produce one command per column, which for
		// a big circle exceeds the preview limit while the download stays full.
		const shape = generateCircle({ diameter: 128, mode: "filled" });
		const result = buildCommands(shape, { block: "stone", anchorWorld: ANCHOR, height: 8 });
		const preview = limitCommandsForPreview(result.commands);
		expect(result.commands.length).toBeGreaterThan(COMMAND_PREVIEW_LIMIT);
		expect(result.blockCount).toBe(shape.cells.length * 8);
	});
});
