// Hand-built geometry for blocks whose vanilla assets ship no model JSON. In
// 26.x these blocks (chests, beds, banners, heads, shields, the decorated pot
// and the copper golem statue) are drawn by engine "special" renderers, so the
// assets repo only contains texture atlases. The builders here approximate
// those renderers with ordinary block-model cuboids.
//
// Conventions the offline rasterizer relies on:
// - UVs are in 0..16 space where the range covers the WHOLE texture image,
//   so pixel (x, y) on a WxH texture is UV (x * 16 / W, y * 16 / H).
// - The entity-model face that should look at the camera is assigned to
//   "south" (+Z): the [30, 45, 0] gui rotation shows the +Z face up front.
// - The measured atlas regions below were verified against the downloaded
//   textures pixel by pixel (see the probe notes next to each region).

/** Build a cuboid element whose faces may share one UV or map per face. */
export function cuboid(from, to, texture, uvMap) {
	const flat = Array.isArray(uvMap) ? uvMap : null;
	const faces = {};
	for (const f of ['down', 'up', 'north', 'south', 'west', 'east']) {
		const uv = flat ? flat : (uvMap && Array.isArray(uvMap[f]) ? uvMap[f] : [0, 0, 16, 16]);
		faces[f] = { uv, texture };
	}
	return { from, to, faces };
}

// Standard Minecraft skin head UV regions (pixel coordinates within the 64x64
// humanoid skin). The face (eyes) lives on the entity model's +Z (= "south" in
// block-model terms) face, so it must be mapped to "south" or heads show their
// back to the camera.
export const HEAD_REGIONS = {
	up: [8, 0, 16, 8],       // top of head
	down: [16, 0, 24, 8],    // bottom of head
	north: [24, 8, 32, 16],  // back of head
	south: [8, 8, 16, 16],   // front (face, eyes)
	west: [0, 8, 8, 16],     // right side
	east: [16, 8, 24, 16]    // left side
};

// Dragon head. The 256x256 dragon.png holds the head box lower-right of center:
// the 16x16 face with the magenta eyes sits at (128,48)-(144,64). Verify the
// neighbouring faces stay inside opaque dark texture, not the atlas void.
export const DRAGON_HEAD_REGIONS = {
	up: [128, 32, 144, 48],
	down: [144, 32, 160, 48],
	north: [112, 48, 128, 64],
	south: [128, 48, 144, 64],  // face with the magenta eyes
	west: [144, 48, 160, 64],
	east: [112, 32, 128, 48]
};

/** Build a head block model JSON referencing the given skin texture name. */
export function buildHeadModel(skinName, { width, height }, regions = HEAD_REGIONS) {
	const uv = {};
	for (const [face, region] of Object.entries(regions)) {
		uv[face] = [
			region[0] * 16 / width,
			region[1] * 16 / height,
			region[2] * 16 / width,
			region[3] * 16 / height
		];
	}
	return {
		textures: { skin: skinName },
		display: {
			gui: { rotation: [30, 45, 0], translation: [0, 3, 0], scale: [1, 1, 1] }
		},
		elements: [
			{
				from: [4, 0, 4],
				to: [12, 8, 12],
				faces: {
					down: { uv: uv.down, texture: '#skin' },
					up: { uv: uv.up, texture: '#skin' },
					north: { uv: uv.north, texture: '#skin' },
					south: { uv: uv.south, texture: '#skin' },
					west: { uv: uv.west, texture: '#skin' },
					east: { uv: uv.east, texture: '#skin' }
				}
			}
		]
	};
}

/**
 * Build a full bed block model (head + foot) referencing the given bed texture.
 * Geometry replicates the vanilla bed model (head board + frame + legs). UVs are
 * in 0-16 space mapping onto the 64x64 `entity/bed/{color}.png` atlas.
 */
export function buildBedModel(textureName) {
	// Foot part elements (from vanilla template_bed_foot).
	const foot = [
		{
			from: [0, 0, 0], to: [3, 3, 3],
			faces: {
				north: { uv: [12.5, 5.25, 13.25, 6], texture: '#bed' },
				east: { uv: [14.75, 5.25, 15.5, 6], texture: '#bed' },
				south: { uv: [14, 5.25, 14.75, 6], texture: '#bed' },
				west: { uv: [13.25, 5.25, 14, 6], texture: '#bed' },
				down: { uv: [14, 4.5, 14.75, 5.25], texture: '#bed' }
			}
		},
		{
			from: [13, 0, 0], to: [16, 3, 3],
			faces: {
				north: { uv: [14, 3.75, 13.25, 4.5], texture: '#bed' },
				east: { uv: [12.5, 3.75, 13.25, 4.5], texture: '#bed' },
				south: { uv: [14.75, 3.75, 15.5, 4.5], texture: '#bed' },
				west: { uv: [14, 3.75, 14.75, 4.5], texture: '#bed' },
				down: { uv: [14, 3, 14.75, 3.75], texture: '#bed' }
			}
		},
		{
			from: [0, 3, 0], to: [16, 9, 16],
			faces: {
				north: { uv: [5.5, 5.5, 9.5, 7], rotation: 180, texture: '#bed' },
				east: { uv: [0, 7, 1.5, 11], rotation: 270, texture: '#bed' },
				west: { uv: [5.5, 7, 7, 11], rotation: 90, texture: '#bed' },
				up: { uv: [1.5, 7, 5.5, 11], rotation: 180, texture: '#bed' },
				down: { uv: [7, 7, 11, 11], texture: '#bed' }
			}
		}
	];

	// Head part elements (from vanilla template_bed_head), offset +16 along Z so
	// the head block sits next to the foot block.
	const head = [
		{
			from: [0, 0, 13], to: [3, 3, 16],
			faces: {
				north: { uv: [14.75, 0.75, 15.5, 1.5], texture: '#bed' },
				east: { uv: [14, 0.75, 14.75, 1.5], texture: '#bed' },
				south: { uv: [13.25, 0.75, 14, 1.5], texture: '#bed' },
				west: { uv: [12.5, 0.75, 13.25, 1.5], texture: '#bed' },
				down: { uv: [14, 0, 14.75, 0.75], texture: '#bed' }
			}
		},
		{
			from: [13, 0, 13], to: [16, 3, 16],
			faces: {
				north: { uv: [14, 2.25, 14.75, 3], texture: '#bed' },
				east: { uv: [13.25, 2.25, 14, 3], texture: '#bed' },
				south: { uv: [12.5, 2.25, 13.25, 3], texture: '#bed' },
				west: { uv: [14.75, 2.25, 15.5, 3], texture: '#bed' },
				down: { uv: [14, 1.5, 14.75, 2.25], texture: '#bed' }
			}
		},
		{
			from: [0, 3, 0], to: [16, 9, 16],
			faces: {
				east: { uv: [0, 1.5, 1.5, 5.5], rotation: 270, texture: '#bed' },
				south: { uv: [1.5, 0, 5.5, 1.5], rotation: 180, texture: '#bed' },
				west: { uv: [5.5, 1.5, 7, 5.5], rotation: 90, texture: '#bed' },
				up: { uv: [1.5, 1.5, 5.5, 5.5], rotation: 180, texture: '#bed' },
				down: { uv: [7, 1.5, 11, 5.5], texture: '#bed' }
			}
		}
	].map((el) => ({
		from: [el.from[0], el.from[1], el.from[2] + 16],
		to: [el.to[0], el.to[1], el.to[2] + 16],
		faces: el.faces
	}));

	return {
		textures: { bed: textureName },
		display: {
			gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] }
		},
		elements: [...foot, ...head]
	};
}

/**
 * Build a chest block model (body + lid + latch). The 26.x chest texture
 * (entity/chest/*.png) is 64x64 (UV = pixel / 4). The atlas arranges each
 * 14x14 face cell with a 1px dark border, so every region below samples the
 * 12x12 interior of a known wood cell; the previous regions spanned two cells
 * plus the atlas void, which rendered as big black squares on the chests.
 */
export function buildChestModel(textureName) {
	const wood = [3.75, 5, 6.75, 7.75];      // interior of the body cell, px (15,20)-(27,31)
	const lidWood = [3.75, 0.25, 6.75, 3];   // interior of the lid cell, px (15,1)-(27,12)
	const latch = [0.25, 0.25, 1.25, 1.25];  // latch square, px (1,1)-(5,5)

	return {
		textures: { chest: textureName },
		display: { gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		elements: [
			cuboid([0, 0, 0], [16, 10, 14], '#chest', { north: wood, south: wood, east: wood, west: wood, up: wood, down: wood }),
			cuboid([0, 10, 0], [16, 14, 14], '#chest', { north: lidWood, south: lidWood, east: lidWood, west: lidWood, up: lidWood, down: wood }),
			cuboid([7, 10, 14], [9, 13, 15], '#chest', latch)
		]
	};
}

/**
 * Build a copper golem statue model (pedestal + body + head). The copper golem
 * texture (entity/copper_golem/*.png) is 64x64 (UV = pixel / 4). Measured
 * regions: the seated golem's face strip at (40,0)-(56,8), the head box
 * interior at (9,1)-(23,7), the body at (1,22)-(26,26) and the base strip at
 * (0,31)-(31,35).
 */
export function buildGolemStatueModel(textureName) {
	const headFace = [11.5, 5, 15.5, 7];       // cleanest 16x8 copper window, px (46,20)-(62,28)
	const headSide = [11.5, 5, 15.5, 7];
	const bodyTex = [0.25, 5.5, 6.5, 6.5];     // body, px (1,22)-(26,26)
	const baseTex = [0, 7.75, 7.75, 8.75];     // base strip, px (0,31)-(31,35)

	return {
		textures: { golem: textureName },
		display: { gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		elements: [
			cuboid([2, 0, 2], [14, 3, 14], '#golem', baseTex),
			cuboid([4, 3, 4], [12, 9, 12], '#golem', bodyTex),
			cuboid([4.5, 9, 4.5], [11.5, 15, 11.5], '#golem', { south: headFace, north: headSide, east: headSide, west: headSide, up: headSide, down: headSide })
		]
	};
}

/**
 * Build a shield model: a thin vertical slab carrying the (pre-rotated, 90°,
 * trimmed) shield_base texture (23x42). The white front plate occupies the top
 * 24 pixels, so the big faces sample only that region instead of the entire
 * sheet (which used to paint the handle pieces across the whole slab).
 */
export function buildShieldModel(textureName) {
	const front = [16 / 23, 32 / 42, 22 * 16 / 23, 11.5 * 16 / 42]; // white plate, px (1,2)-(22,11.5)
	const wood = [7.65, 12.95, 10.43, 15.24];                      // handle wood, px (11,34)-(15,40)
	return {
		textures: { shield: textureName },
		display: { gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		elements: [
			cuboid([5, 1, 7], [11, 15, 8], '#shield', {
				south: front,
				north: wood,
				east: wood,
				west: wood,
				up: wood,
				down: wood
			})
		]
	};
}

/** Build a banner model: a vertical pole with the tinted cloth hanging beside it. */
export function buildBannerModel(clothTexture, poleTexture) {
	return {
		textures: { cloth: clothTexture, pole: poleTexture },
		display: { gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		elements: [
			cuboid([7, 0, 7], [9, 16, 9], '#pole'),
			cuboid([0, 1, 8], [7, 13, 8.5], '#cloth')
		]
	};
}

/**
 * Build the decorated pot model. Vanilla 26.x renders it with an engine special
 * (models/block/decorated_pot.json only carries a particle texture), so the
 * vase silhouette is approximated with four stacked terracotta cuboids: base,
 * wide body, narrow neck and rim. Per-variant sherd sides are not modelled —
 * the plain terracotta body is the recognizable base icon.
 */
export function buildDecoratedPotModel() {
	return {
		textures: { side: 'terracotta' },
		display: { gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		elements: [
			cuboid([3, 0, 3], [13, 2, 13], '#side'),
			cuboid([2, 2, 2], [14, 11, 14], '#side'),
			cuboid([4, 11, 4], [12, 13, 12], '#side'),
			cuboid([3, 13, 3], [13, 16, 13], '#side')
		]
	};
}
