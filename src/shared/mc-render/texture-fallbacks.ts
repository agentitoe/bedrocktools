// Texture fallback wiring shared by the tools that show item icons.
//
// `createIconElement` may return a flat placeholder whose URL can 404, so every
// tool attaches its own ordered candidate list; the upgrade logic is identical
// and lives here as the single source of truth.

/**
 * Keep the tool's texture fallback chain working on the flat placeholder the
 * shared factory returns. Baked atlas sprites are left untouched (their URL is
 * never one of the candidates).
 */
export function attachTextureFallbacks(
	icon: HTMLCanvasElement | HTMLImageElement,
	candidates: string[],
): void {
	if (!(icon instanceof HTMLImageElement)) return;
	const image: HTMLImageElement = icon;

	const current = image.getAttribute('src') ?? '';
	if (current.length > 0 && !candidates.includes(current)) return;

	let index = candidates.indexOf(current);
	if (index < 0) index = 0;
	image.onerror = () => {
		index++;
		if (index < candidates.length) {
			image.src = candidates[index];
		} else {
			image.onerror = null;
		}
	};
}
