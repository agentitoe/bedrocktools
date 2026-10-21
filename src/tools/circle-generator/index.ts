// Minecraft Circle Generator — Java + Bedrock
//
// The page markup lives in public/tools/circle-generator/index.html; this
// module only wires up the existing elements, renders the canvas preview and
// produces the command list. Pure logic lives in ./circle.ts and the text in
// ./translations.ts.

import { initUi, getLang } from '../../shared/ui';
import { translations } from './translations';
import {
	BLOCK_COLORS,
	FALLBACK_BLOCK_COLOR,
	MAX_DIAMETER,
	MAX_HEIGHT,
	MAX_THICKNESS,
	MIN_DIAMETER,
	MIN_HEIGHT,
	MIN_THICKNESS,
	buildCommands,
	generateCircle,
	isVolumeSafe,
	limitCommandsForPreview,
	sanitizeBlockName,
	type CircleMode,
} from './circle';

const CANVAS_CSS_SIZE = 288;

interface CircleControls {
	diameter: HTMLInputElement;
	diameterRange: HTMLInputElement;
	diameterValue: HTMLElement;
	thickness: HTMLInputElement;
	thicknessRange: HTMLInputElement;
	thicknessValue: HTMLElement;
	thicknessRow: HTMLElement;
	height: HTMLInputElement;
	heightRange: HTMLInputElement;
	heightValue: HTMLElement;
	modeRadios: NodeListOf<HTMLInputElement>;
	blockSelect: HTMLInputElement;
	blockCustom: HTMLInputElement;
	blockCustomRow: HTMLElement;
	coordX: HTMLInputElement;
	coordY: HTMLInputElement;
	coordZ: HTMLInputElement;
}

function t() {
	return translations[getLang()];
}

export function init(): void {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initGenerator);
	} else {
		initGenerator();
	}
}

function requireEl<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Missing element #${id}`);
	return el as unknown as T;
}

function initGenerator(): void {
	initUi(translations);

	const controls: CircleControls = {
		diameter: requireEl('circleDiameter'),
		diameterRange: requireEl('circleDiameterRange'),
		diameterValue: requireEl('circleDiameterValue'),
		thickness: requireEl('circleThickness'),
		thicknessRange: requireEl('circleThicknessRange'),
		thicknessValue: requireEl('circleThicknessValue'),
		thicknessRow: requireEl('circleThicknessRow'),
		height: requireEl('circleHeight'),
		heightRange: requireEl('circleHeightRange'),
		heightValue: requireEl('circleHeightValue'),
		modeRadios: document.querySelectorAll<HTMLInputElement>('input[name="circleMode"]'),
		blockSelect: requireEl('circleBlockSelect'),
		blockCustom: requireEl('circleBlockCustom'),
		blockCustomRow: requireEl('circleBlockCustomRow'),
		coordX: requireEl('circleCoordX'),
		coordY: requireEl('circleCoordY'),
		coordZ: requireEl('circleCoordZ'),
	};

	syncThicknessVisibility(controls);
	syncCustomBlockVisibility(controls);
	generate(controls);

	// Live re-render on every relevant change; the big button stays as a
	// submit affordance for the form.
	const relayout = () => generate(controls);
	const form = document.getElementById('circleForm');
	form?.addEventListener('submit', (e) => {
		e.preventDefault();
		relayout();
	});
	controls.modeRadios.forEach((radio) => radio.addEventListener('change', () => {
		syncThicknessVisibility(controls);
		relayout();
	}));
	controls.diameter.addEventListener('change', relayout);
	controls.thickness.addEventListener('change', relayout);
	controls.height.addEventListener('change', relayout);
	controls.blockSelect.addEventListener('change', () => {
		syncCustomBlockVisibility(controls);
		relayout();
	});
	controls.blockCustom.addEventListener('change', relayout);
	controls.coordX.addEventListener('change', relayout);
	controls.coordY.addEventListener('change', relayout);
	controls.coordZ.addEventListener('change', relayout);

	// Range and number inputs feed each other.
	syncRangePair(controls.diameter, controls.diameterRange, controls.diameterValue, MIN_DIAMETER, MAX_DIAMETER, relayout);
	syncRangePair(controls.thickness, controls.thicknessRange, controls.thicknessValue, MIN_THICKNESS, MAX_THICKNESS, relayout);
	syncRangePair(controls.height, controls.heightRange, controls.heightValue, MIN_HEIGHT, MAX_HEIGHT, relayout);
}

function syncRangePair(
	numberInput: HTMLInputElement,
	rangeInput: HTMLInputElement,
	valueLabel: HTMLElement,
	min: number,
	max: number,
	onChange: () => void,
): void {
	const apply = () => {
		valueLabel.textContent = String(clampFromInput(numberInput, min, max));
	};
	const fromNumber = () => {
		const clamped = clampFromInput(numberInput, min, max);
		rangeInput.value = String(clamped);
		apply();
		onChange();
	};
	const fromRange = () => {
		numberInput.value = rangeInput.value;
		apply();
		onChange();
	};
	numberInput.addEventListener('change', fromNumber);
	rangeInput.addEventListener('input', fromRange);
	numberInput.value = numberInput.value || String(min);
	apply();
}

function clampFromInput(input: HTMLInputElement, min: number, max: number): number {
	const raw = Number.parseInt(input.value, 10);
	return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min;
}

function readMode(controls: CircleControls): CircleMode {
	const checked = [...controls.modeRadios].find((radio) => radio.checked);
	return checked && checked.value === 'filled' ? 'filled' : 'hollow';
}

function syncThicknessVisibility(controls: CircleControls): void {
	controls.thicknessRow.style.display = readMode(controls) === 'filled' ? 'none' : '';
}

function syncCustomBlockVisibility(controls: CircleControls): void {
	controls.blockCustomRow.style.display = controls.blockSelect.value === 'custom' ? '' : 'none';
}

function readBlock(controls: CircleControls): string {
	const selected = controls.blockSelect.value;
	return selected === 'custom' ? controls.blockCustom.value || 'stone' : selected;
}

function readAnchor(controls: CircleControls): { x: number; y: number; z: number } {
	const num = (input: HTMLInputElement) => {
		const parsed = Number.parseInt(input.value, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return { x: num(controls.coordX), y: num(controls.coordY), z: num(controls.coordZ) };
}

function showError(message: string): void {
	const errorBox = document.getElementById('circleError');
	if (errorBox) {
		errorBox.textContent = message;
		errorBox.style.display = '';
	}
	const output = document.getElementById('circleResult');
	if (output) output.style.display = 'none';
}

function showResult(): void {
	const errorBox = document.getElementById('circleError');
	if (errorBox) errorBox.style.display = 'none';
	const output = document.getElementById('circleResult');
	if (output) output.style.display = '';
}

function generate(controls: CircleControls): void {
	showResult();

	const diameter = Number.parseInt(controls.diameter.value, 10);
	if (!Number.isFinite(diameter) || diameter < MIN_DIAMETER || diameter > MAX_DIAMETER) {
		showError(t().invalidInput);
		return;
	}
	const blockName = readBlock(controls);
	let sanitized: string;
	try {
		sanitized = sanitizeBlockName(blockName);
	} catch {
		showError(t().invalidBlock);
		return;
	}

	const shape = generateCircle({
		diameter,
		mode: readMode(controls),
		thickness: clampFromInput(controls.thickness, MIN_THICKNESS, MAX_THICKNESS),
	});
	const height = clampFromInput(controls.height, MIN_HEIGHT, MAX_HEIGHT);
	const commands = buildCommands(shape, {
		block: sanitized,
		anchorWorld: readAnchor(controls),
		height,
	});

	if (commands.blockCount === 0) {
		showError(t().emptyResult);
		return;
	}
	if (!isVolumeSafe(commands.blockCount)) {
		showError(t().tooBig);
		return;
	}

	renderStats(commands, diameter);
	renderPreview(diameter, shape, sanitized);
	renderCommands(commands);
}

function renderStats(commands: { commands: string[]; blockCount: number }, diameter: number): void {
	const blocks = document.getElementById('circleStatBlocks');
	const count = document.getElementById('circleStatCommands');
	const diameterEl = document.getElementById('circleStatDiameter');
	if (blocks) blocks.textContent = String(commands.blockCount);
	if (count) count.textContent = String(commands.commands.length);
	if (diameterEl) diameterEl.textContent = String(diameter);
}

function renderCommands(commands: { commands: string[]; blockCount: number }): void {
	const output = document.getElementById('commandOutput') as HTMLTextAreaElement | null;
	if (!output) return;

	const preview = limitCommandsForPreview(commands.commands);
	output.value = preview.lines.join('\n');

	const outputNote = document.getElementById('circleOutputNote');
	if (outputNote) {
		outputNote.textContent = preview.hidden > 0 ? t().previewTruncated : '';
		outputNote.style.display = preview.hidden > 0 ? '' : 'none';
	}

	const fullText = commands.commands.join('\n');

	const copy = document.getElementById('circleCopyBtn');
	const download = document.getElementById('circleDownloadBtn');
	if (copy) {
		copy.onclick = () => {
			navigator.clipboard.writeText(fullText).then(
				() => flashButton(copy, t().copySuccess),
				() => flashButton(copy, t().copyError),
			);
		};
	}
	if (download) {
		download.onclick = () => {
			// Chat-friendly command list download: works as a Data Pack function
			// in Java and a Behavior Pack function in Bedrock.
			const blob = new Blob(
				[`# Generated by Bedrock Tools (https://bedrocktools.pages.dev)\n${fullText}\n`],
				{ type: 'text/plain' },
			);
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'circle.mcfunction';
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		};
		const pngButton = document.getElementById('circleDownloadPngBtn');
		if (pngButton) {
			pngButton.onclick = () => {
				const canvas = document.getElementById('circleCanvas') as HTMLCanvasElement | null;
				if (!canvas || canvas.width === 0) return;
				// Export at full resolution (device pixels, not CSS size),
				// over the themed background so light blocks stay visible.
				const source = document.createElement('canvas');
				source.width = canvas.width;
				source.height = canvas.height;
				const sourceCtx = source.getContext('2d');
				if (sourceCtx) {
					const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
					if (bg) {
						sourceCtx.fillStyle = bg;
						sourceCtx.fillRect(0, 0, source.width, source.height);
					}
					sourceCtx.drawImage(canvas, 0, 0);
				}
				source.toBlob((blob) => {
					if (!blob) return;
					const url = URL.createObjectURL(blob);
					const link = document.createElement('a');
					link.href = url;
					link.download = 'circle.png';
					document.body.appendChild(link);
					link.click();
					link.remove();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
				}, 'image/png');
			};
		}
	}
}

function flashButton(button: HTMLElement, label: string): void {
	const original = button.textContent;
	button.textContent = label;
	button.setAttribute('aria-live', 'polite');
	setTimeout(() => {
		button.textContent = original;
	}, 2000);
}

function renderPreview(
	diameter: number,
	shape: ReturnType<typeof generateCircle>,
	block: string,
): void {
	const canvas = document.getElementById('circleCanvas') as HTMLCanvasElement | null;
	const note = document.getElementById('circlePreviewNote');
	if (!canvas) return;

	const cell = Math.max(1, Math.floor(CANVAS_CSS_SIZE / diameter));
	const size = Math.min(CANVAS_CSS_SIZE, cell * diameter);
	const ratio = window.devicePixelRatio || 1;
	canvas.width = size * ratio;
	canvas.height = size * ratio;
	canvas.style.width = `${size}px`;
	canvas.style.height = `${size}px`;

	if (note) {
		note.textContent = diameter > 64 ? `${t().previewNote} (1:${cell})` : '';
	}

	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, size, size);

	const style = getComputedStyle(document.body);
	ctx.strokeStyle = style.getPropertyValue('--border') || '#999';
	ctx.lineWidth = 1;
	for (let i = 0; i <= diameter; i += 8) {
		ctx.beginPath();
		ctx.moveTo(i * cell, 0);
		ctx.lineTo(i * cell, size);
		ctx.moveTo(0, i * cell);
		ctx.lineTo(size, i * cell);
		ctx.stroke();
	}

	ctx.fillStyle = BLOCK_COLORS[block] || FALLBACK_BLOCK_COLOR;
	for (const cellPos of shape.cells) {
		ctx.fillRect(cellPos.x * cell + 0.5, cellPos.z * cell + 0.5, cell - 1, cell - 1);
	}
}
