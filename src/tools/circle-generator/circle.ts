// Circle generator core: voxelizes a Minecraft circle into grid cells
// and turns those cells into /fill and /setblock commands.
//
// Pure logic only (no DOM), so it is unit-testable. Works identically for
// Minecraft Java and Bedrock: both editions support the same /fill, /setblock
// and .mcfunction command syntax used here.

export type CircleMode = 'hollow' | 'filled';

export interface GridCell {
	/** Column index within the [0, diameter) grid. */
	x: number;
	/** Row index within the [0, diameter) grid. */
	z: number;
}

export interface CircleShape {
	/** Bounding box width/height in blocks. */
	diameter: number;
	mode: CircleMode;
	/** Cells inside the grid. The center point sits at (center, center) where center = (diameter - 1) / 2 (may be half-integer for even diameters). */
	cells: GridCell[];
}

export interface WorldAnchor {
	x: number;
	y: number;
	z: number;
}

export interface CommandBuildOptions {
	/** Block name/type for the commands, e.g. `stone` or `minecraft:stone`. */
	block: string;
	/** World coordinate of the circle's anchor cell. */
	anchorWorld: WorldAnchor;
	/** Height of the extrusion (cylinder). 1 = flat circle. */
	height: number;
}

export interface CommandBuildResult {
	commands: string[];
	/** Total number of blocks written across all commands. */
	blockCount: number;
}

export const MIN_DIAMETER = 2;
export const MAX_DIAMETER = 256;
export const MIN_THICKNESS = 1;
export const MAX_THICKNESS = 16;
export const MIN_HEIGHT = 1;
export const MAX_HEIGHT = 64;
/** Bedrock and Java /fill cap the volume per command; every command we emit
 * stays far below this (worst case is a run of 256 or a column of 64). */
export const BEDROCK_FILL_VOLUME_LIMIT = 32768;

/** Upper bound on the total block volume generated in one pass. Beyond this
 * the UI refuses to render (and asks for a smaller circle) because the command
 * list would be unusable in chat. */
export const MAX_TOTAL_BLOCKS = 250000;

/** Number of lines shown in the on-page textarea; downloads always include
 * the full list. */
export const COMMAND_PREVIEW_LIMIT = 3000;

const EPSILON = 1e-9;

export function clampInt(value: number, min: number, max: number): number {
	const n = Math.round(Number.isFinite(value) ? value : min);
	return Math.min(max, Math.max(min, n));
}

/**
 * Voxelizes a circle into grid cells.
 *
 * Cells are sampled at their centers: a cell at grid index (x, z) has its
 * center at (dx, dz) = (x - (d - 1) / 2, z - (d - 1) / 2). It is inside the
 * circle when dist(dx, dz) <= diameter / 2. Hollow circles keep only the ring
 * of cells whose distance is greater than (diameter / 2 - thickness).
 */
export function generateCircle(options: {
	diameter: number;
	mode: CircleMode;
	thickness?: number;
}): CircleShape {
	const diameter = clampInt(options.diameter, MIN_DIAMETER, MAX_DIAMETER);
	const thickness = clampInt(options.thickness ?? 1, MIN_THICKNESS, MAX_THICKNESS);
	const radius = diameter / 2;
	const center = (diameter - 1) / 2;
	const isFilled = options.mode === 'filled';

	const cells: GridCell[] = [];
	for (let z = 0; z < diameter; z++) {
		for (let x = 0; x < diameter; x++) {
			const dx = x - center;
			const dz = z - center;
			const dist = Math.hypot(dx, dz);
			if (dist > radius + EPSILON) continue;
			if (!isFilled && dist <= radius - thickness - EPSILON) continue;
			cells.push({ x, z });
		}
	}

	return { diameter, mode: options.mode === 'filled' ? 'filled' : 'hollow', cells };
}

/**
 * Validates a block name for /fill and /setblock usage.
 * Accepts Bedrock-style names (`stone`) and namespaced names
 * (`minecraft:stone`); throws on anything else.
 */
export function sanitizeBlockName(raw: string): string {
	const name = raw.trim().toLowerCase();
	const pattern = /^[a-z0-9_]+(?::[a-z0-9_]+)?$/;
	if (!pattern.test(name)) {
		throw new Error(`Invalid block name: ${raw}`);
	}
	return name;
}

/**
 * World coordinate of the grid cell (0, 0) for a circle whose "anchor" is at
 * the given world position. The anchor is the cell chosen as the center of the
 * circle in the UI (for even diameters it falls between two cells, and the
 * anchor is the cell just past the center).
 */
export function gridToWorldOrigin(diameter: number, anchor: WorldAnchor): WorldAnchor {
	const offset = Math.floor(diameter / 2);
	return {
		x: anchor.x - offset,
		y: anchor.y,
		z: anchor.z - offset,
	};
}

/**
 * Builds the command list for a shape anchored at a world position.
 *
 * Flat circles (height === 1) use horizontal run merging: contiguous cells of
 * the same row become a single /fill. Extrusions (height > 1) use vertical
 * run merging: every occupied column becomes one /fill spanning the full
 * height, which keeps the command count independent of the height.
 */
export function buildCommands(shape: CircleShape, options: CommandBuildOptions): CommandBuildResult {
	const block = sanitizeBlockName(options.block);
	const { diameter, cells } = shape;
	const height = clampInt(options.height, MIN_HEIGHT, MAX_HEIGHT);
	const origin = gridToWorldOrigin(diameter, options.anchorWorld);

	const commands: string[] = [];
	let blockCount = 0;

	if (height > 1) {
		// Vertical runs: one /fill per occupied column.
		const byColumn = [...cells].sort((a, b) => a.z - b.z || a.x - b.x);
		for (const cell of byColumn) {
			const x = origin.x + cell.x;
			const z = origin.z + cell.z;
			commands.push(`/fill ${x} ${origin.y} ${z} ${x} ${origin.y + height - 1} ${z} ${block}`);
			blockCount += height;
		}
	} else {
		// Horizontal runs: one /fill per contiguous row segment.
		const byRow = [...cells].sort((a, b) => a.z - b.z || a.x - b.x);
		let i = 0;
		while (i < byRow.length) {
			const rowStart = byRow[i];
			let runEnd = rowStart;
			let runLength = 1;
			while (
				i + 1 < byRow.length &&
				byRow[i + 1].z === rowStart.z &&
				byRow[i + 1].x === runEnd.x + 1
			) {
				runEnd = byRow[i + 1];
				runLength++;
				i++;
			}
			const x1 = origin.x + rowStart.x;
			const x2 = origin.x + runEnd.x;
			const z = origin.z + rowStart.z;
			const y = origin.y;
			commands.push(
				runLength === 1
					? `/setblock ${x1} ${y} ${z} ${block}`
					: `/fill ${x1} ${y} ${z} ${x2} ${y} ${z} ${block}`
			);
			blockCount += runLength;
			i++;
		}
	}

	return { commands, blockCount };
}

/** True when the total block volume is reasonable to render at once. */
export function isVolumeSafe(blockCount: number): boolean {
	return blockCount <= MAX_TOTAL_BLOCKS;
}

/** Returns the lines to display in the preview textarea, plus how many were
 * omitted (always 0 when under the limit). */
export function limitCommandsForPreview(commands: string[]): {
	lines: string[];
	hidden: number;
} {
	if (commands.length <= COMMAND_PREVIEW_LIMIT) {
		return { lines: commands, hidden: 0 };
	}
	return {
		lines: commands.slice(0, COMMAND_PREVIEW_LIMIT),
		hidden: commands.length - COMMAND_PREVIEW_LIMIT,
	};
}

/** Palette of common block colors used for the canvas preview. */
export const BLOCK_COLORS: Record<string, string> = {
	stone: '#7a7a7a',
	cobblestone: '#8a8a8a',
	dirt: '#866043',
	oak_log: '#6b5233',
	oak_planks: '#b08a55',
	spruce_planks: '#7a5a35',
	dark_oak_planks: '#4a3520',
	glass: '#a8d8e0',
	iron_block: '#d8d8d8',
	gold_block: '#f5c542',
	diamond_block: '#4adbcd',
	emerald_block: '#3fdc6c',
	obsidian: '#191025',
	netherrack: '#6f3340',
	white_concrete: '#cfd5d6',
	black_concrete: '#0a0a0c',
	red_concrete: '#98353f',
	blue_concrete: '#2a3d96',
	sand: '#dbd3a0',
	glowstone: '#f9d67a',
};

/** Fallback preview color when a block has no palette entry. */
export const FALLBACK_BLOCK_COLOR = '#caa84a';
