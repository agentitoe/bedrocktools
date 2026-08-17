// Isometric Projector
// Projects 3D vertices to 2D isometric coordinates for Minecraft-style rendering

import { Vec3, Face } from './model-parser';

export interface ProjectedFace {
	vertices: ProjectedVertex[];
	uv: UV[];
	textureRef: string;
	avgDepth: number;        // For depth sorting (painter's algorithm)
	normal: Vec3;
}

export interface ProjectedVertex {
	x: number;
	y: number;
}

export interface UV {
	u: number;
	v: number;
}

/**
 * Project an already-transformed 3D vertex to 2D screen space.
 * Vertices have already been rotated/scaled by the model's display.gui transform
 * (rotation [30, 225, 0], scale 0.625), which orients the model for the isometric
 * "inventory" view. The projection is therefore a plain orthographic projection:
 * keep x, keep y (flipped for canvas), drop z. Depth for painter's sorting is the
 * transformed z coordinate.
 */
export function projectToIsometric(v: Vec3): ProjectedVertex {
	return { x: v.x, y: -v.y };
}

/**
 * Compute the outward normal of a face from its (already display-transformed)
 * 3D vertices. Used to cull faces that point away from the camera.
 */
function transformedFaceNormal(vertices: Vec3[]): Vec3 {
	const [v0, v1, v2] = vertices;
	const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
	const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
	return {
		x: e1.y * e2.z - e1.z * e2.y,
		y: e1.z * e2.x - e1.x * e2.z,
		z: e1.x * e2.y - e1.y * e2.x
	};
}

/**
 * Project all faces to 2D, culling back faces and computing depth for sorting.
 */
export function projectFaces(faces: Face[]): ProjectedFace[] {
	const projected: ProjectedFace[] = [];

	for (const face of faces) {
		// Back-face culling: the camera looks along -Z, so only faces whose
		// (transformed) normal points toward +Z are visible. Without this the
		// hidden faces bleed through and corrupt the icon.
		const n = transformedFaceNormal(face.vertices);
		if (n.z <= 0) continue;

		const projectedVertices = face.vertices.map(projectToIsometric);

		// Depth for painter's algorithm: transformed Z. Larger Z is closer to
		// the camera, so it is drawn last (see sortFacesByDepth).
		const avgZ = face.vertices.reduce((sum, v) => sum + v.z, 0) / face.vertices.length;

		projected.push({
			vertices: projectedVertices,
			uv: face.uv,
			textureRef: face.textureRef,
			avgDepth: avgZ,
			normal: face.normal
		});
	}

	return projected;
}

/**
 * Sort faces by depth (painter's algorithm) - back to front.
 * The camera looks along -Z, so smaller Z is farther away and is drawn first.
 */
export function sortFacesByDepth(faces: ProjectedFace[]): ProjectedFace[] {
	return [...faces].sort((a, b) => a.avgDepth - b.avgDepth);
}

/**
 * Scale and center projected coordinates to fit in canvas
 */
export function fitToCanvas(
	faces: ProjectedFace[],
	canvasSize: number,
	padding: number = 4
): ProjectedFace[] {
	if (faces.length === 0) return faces;

	// Find bounds
	let minX = Infinity, maxX = -Infinity;
	let minY = Infinity, maxY = -Infinity;

	for (const face of faces) {
		for (const v of face.vertices) {
			minX = Math.min(minX, v.x);
			maxX = Math.max(maxX, v.x);
			minY = Math.min(minY, v.y);
			maxY = Math.max(maxY, v.y);
		}
	}

	const width = maxX - minX;
	const height = maxY - minY;
	const maxDim = Math.max(width, height);

	if (maxDim === 0) return faces;

	const scale = (canvasSize - padding * 2) / maxDim;
	const offsetX = (canvasSize - width * scale) / 2 - minX * scale;
	const offsetY = (canvasSize - height * scale) / 2 - minY * scale;

	return faces.map(face => ({
		...face,
		vertices: face.vertices.map(v => ({
			x: v.x * scale + offsetX,
			y: v.y * scale + offsetY
		}))
	}));
}

/**
 * Calculate canvas bounds for a set of faces (for hit testing, etc)
 */
export function calculateBounds(faces: ProjectedFace[]): { minX: number; maxX: number; minY: number; maxY: number } {
	let minX = Infinity, maxX = -Infinity;
	let minY = Infinity, maxY = -Infinity;

	for (const face of faces) {
		for (const v of face.vertices) {
			minX = Math.min(minX, v.x);
			maxX = Math.max(maxX, v.x);
			minY = Math.min(minY, v.y);
			maxY = Math.max(maxY, v.y);
		}
	}

	return { minX, maxX, minY, maxY };
}