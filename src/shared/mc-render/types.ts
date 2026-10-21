// Shared geometry types for the isometric Minecraft item renderer.
//
// The types mirror the vanilla block-model pipeline: a model is a list of
// cuboid `elements`, each element exposes up to six textured faces, and the
// whole thing is carried through a `display.gui` transform to match the
// inventory ("isometric") view Minecraft uses. Every consumer — the build-time
// baker (`scripts/bake-icons.mjs`) and the browser fallback — speaks this
// vocabulary, so the geometry maths lives in exactly one place.

/** A point in model space (0..16 units, y up). */
export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

/** A texture anchor in 0..16 tile space (u → +x, v → +y downwards). */
export interface UV {
	u: number;
	v: number;
}

/**
 * A vanilla `display` entry. Applied to a vertex as
 * `origin(8,8,8) → translate(-8,-8,-8) → rotate R = Rx·Ry·Rz → scale → translate`.
 */
export interface DisplayTransform {
	rotation: [number, number, number];
	translation: [number, number, number];
	scale: [number, number, number];
}

/**
 * A model JSON as read from `public/data/models/all.json`.
 *
 * The values are intentionally `unknown`: model files in the wild are inconsistent,
 * so every field is validated at runtime before use instead of trusting the cast.
 */
export interface RawModel {
	parent?: string;
	textures?: Record<string, unknown>;
	elements?: unknown[];
	display?: Record<string, unknown>;
}

/**
 * One renderable quad of a model.
 *
 * Vertices are already transformed by `display.gui`, so consumers only need an
 * orthographic projection `(x, -y)` to place them on a canvas. The normal is
 * deliberately kept in *model* space (before the display transform) because
 * Minecraft's GUI shading is a fixed per-face brightness, not a view-dependent
 * light.
 */
export interface FaceGeometry {
	element: number; // index of the owning element, used to group faces per depth pass
	vertices: [Vec3, Vec3, Vec3, Vec3]; // already transformed by display.gui, CCW seen from outside
	uv: [UV, UV, UV, UV]; // anchors in 0..16 tile space, matching the vertices one to one
	texture: string; // peeled texture name, e.g. "oak_planks"
	normal: Vec3; // model-space normal, un-rotated by the display transform
	shade: boolean; // false when the element declares "shade": false
}

/** A texture already cropped to its first 16×16 frame. */
export interface TextureTile {
	width: number;
	height: number;
	image: CanvasImageSource;
}
