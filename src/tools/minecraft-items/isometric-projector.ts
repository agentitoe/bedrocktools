// Isometric Projector
// Projects 3D vertices to 2D isometric coordinates for Minecraft-style rendering.
// Optimized to avoid per-frame allocations: manual loops, no .map/.reduce in
// hot paths. sortFacesByDepth stays non-mutating (tests).

import type { Vec3, Face } from './model-parser';

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
 * MATH UNTOUCHED.
 */
export function projectToIsometric(v: Vec3): ProjectedVertex {
	return { x: v.x, y: -v.y };
}

/**
 * Project all faces to 2D, culling back faces and computing depth for sorting.
 * Single-pass, pre-sized output, no intermediate .map/.reduce allocs.
 */
export function projectFaces(faces: Face[]): ProjectedFace[] {
	const out: ProjectedFace[] = [];
	for (let i = 0; i < faces.length; i++) {
		const face = faces[i];
		const verts = face.vertices;
		if (verts.length < 3) continue;
		// Back-face culling: the camera looks along -Z, so only faces whose
		// (transformed) normal points toward +Z are visible. Without this the
		// hidden faces bleed through and corrupt the icon.
		// Inline (e1 x e2).z — avoids allocating e1/e2/normal objects per face.
		const v0 = verts[0];
		const v1 = verts[1];
		const v2 = verts[2];
		const e1x = v1.x - v0.x;
		const e1y = v1.y - v0.y;
		const e2x = v2.x - v0.x;
		const e2y = v2.y - v0.y;
		const nz = e1x * e2y - e1y * e2x;
		if (nz <= 0) continue;

		const n = verts.length;
		const projectedVertices: ProjectedVertex[] = new Array<ProjectedVertex>(n);
		let zSum = 0;
		for (let k = 0; k < n; k++) {
			const v = verts[k];
			projectedVertices[k] = { x: v.x, y: -v.y };
			zSum += v.z;
		}

		out.push({
			vertices: projectedVertices,
			uv: face.uv,
			textureRef: face.textureRef,
			avgDepth: zSum / n,
			normal: face.normal
		});
	}

	return out;
}

/**
 * Sort faces by depth (painter's algorithm) - back to front.
 * The camera looks along -Z, so smaller Z is farther away and is drawn first.
 * Non-mutating: returns a new sorted array (tests rely on this).
 */
export function sortFacesByDepth(faces: ProjectedFace[]): ProjectedFace[] {
	return faces.slice().sort((a, b) => a.avgDepth - b.avgDepth);
}

function computeBounds(faces: ProjectedFace[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
	if (faces.length === 0) return null;
	let minX = Infinity, maxX = -Infinity;
	let minY = Infinity, maxY = -Infinity;
	for (let i = 0; i < faces.length; i++) {
		const vs = faces[i].vertices;
		for (let k = 0; k < vs.length; k++) {
			const v = vs[k];
			if (v.x < minX) minX = v.x;
			if (v.x > maxX) maxX = v.x;
			if (v.y < minY) minY = v.y;
			if (v.y > maxY) maxY = v.y;
		}
	}
	return { minX, maxX, minY, maxY };
}

/**
 * Scale and center projected coordinates to fit in canvas.
 * Reuses uv/textureRef/normal references (no deep clone); only vertices are new.
 */
export function fitToCanvas(
	faces: ProjectedFace[],
	canvasSize: number,
	padding: number = 4
): ProjectedFace[] {
	if (faces.length === 0) return faces;

	const b = computeBounds(faces);
	if (!b) return faces;

	const width = b.maxX - b.minX;
	const height = b.maxY - b.minY;
	const maxDim = width > height ? width : height;

	if (maxDim === 0) return faces;

	const scale = (canvasSize - padding * 2) / maxDim;
	const offsetX = (canvasSize - width * scale) / 2 - b.minX * scale;
	const offsetY = (canvasSize - height * scale) / 2 - b.minY * scale;

	const out: ProjectedFace[] = new Array<ProjectedFace>(faces.length);
	for (let i = 0; i < faces.length; i++) {
		const face = faces[i];
		const vs = face.vertices;
		const nv: ProjectedVertex[] = new Array<ProjectedVertex>(vs.length);
		for (let k = 0; k < vs.length; k++) {
			nv[k] = { x: vs[k].x * scale + offsetX, y: vs[k].y * scale + offsetY };
		}
		out[i] = {
			vertices: nv,
			uv: face.uv,
			textureRef: face.textureRef,
			avgDepth: face.avgDepth,
			normal: face.normal
		};
	}
	return out;
}

/**
 * Calculate canvas bounds for a set of faces (for hit testing, etc)
 */
export function calculateBounds(faces: ProjectedFace[]): { minX: number; maxX: number; minY: number; maxY: number } {
	let minX = Infinity, maxX = -Infinity;
	let minY = Infinity, maxY = -Infinity;

	for (let i = 0; i < faces.length; i++) {
		const vs = faces[i].vertices;
		for (let k = 0; k < vs.length; k++) {
			const v = vs[k];
			if (v.x < minX) minX = v.x;
			if (v.x > maxX) maxX = v.x;
			if (v.y < minY) minY = v.y;
			if (v.y > maxY) maxY = v.y;
		}
	}

	return { minX, maxX, minY, maxY };
}
