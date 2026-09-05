// Minecraft Coordinates Calculator
// Convert coordinates between Overworld and Nether (1:8 ratio).
//
// The page markup (form, styles, labels) lives in
// public/tools/coordenadas-minecraft/index.html. This module only wires up the
// existing elements and renders the result, so no HTML is generated here.

import { initUi, getLang } from '../../shared/ui';
import { translations } from './translations';
import { convertCoordinates, formatCoord, type Direction } from './convert';

export function init(): void {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initCalculator);
	} else {
		initCalculator();
	}
}

function t() {
	return translations[getLang()];
}

/** Minecraft world-border limit for X/Y/Z validation. */
const MAX_COORD = 30_000_000;

/** World-border + finiteness guard: rejects NaN/Infinity and out-of-range input. */
export function isValidCoord(n: number): boolean {
	return Number.isFinite(n) && Math.abs(n) <= MAX_COORD;
}

function showError(resultDiv: HTMLElement, message: string): void {
	resultDiv.textContent = "";
	const box = document.createElement("div");
	box.className = "result-error";
	box.textContent = message;
	resultDiv.appendChild(box);
}

function coordRow(doc: Document, label: string, value: number): HTMLSpanElement {
	const row = doc.createElement("span");
	row.className = "result-coord";
	const lab = doc.createElement("span");
	lab.className = "result-coord-label";
	lab.textContent = label + ":";
	const val = doc.createElement("span");
	val.className = "result-coord-value";
	val.textContent = String(formatCoord(value));
	row.append(lab, val);
	return row;
}

function resultColumn(
	doc: Document,
	title: string,
	x: number,
	y: number,
	z: number,
	tr: ReturnType<typeof t>,
): HTMLDivElement {
	const col = doc.createElement("div");
	col.className = "result-column";
	const strong = doc.createElement("strong");
	strong.textContent = title;
	const coords = doc.createElement("div");
	coords.className = "result-coords";
	coords.append(
		coordRow(doc, tr.xLabel, x),
		coordRow(doc, tr.yLabel, y),
		coordRow(doc, tr.zLabel, z),
	);
	col.append(strong, coords);
	return col;
}

function initCalculator(): void {
	initUi(translations);

	const form = document.getElementById('coordForm') as HTMLFormElement | null;
	const resultDiv = document.getElementById('result');
	const inputX = document.getElementById('coordX') as HTMLInputElement | null;
	const inputY = document.getElementById('coordY') as HTMLInputElement | null;
	const inputZ = document.getElementById('coordZ') as HTMLInputElement | null;
	if (!form || !resultDiv || !inputX || !inputY || !inputZ) return;

	form.addEventListener('submit', (e) => {
		e.preventDefault();

		const x = parseFloat(inputX.value);
		const y = parseFloat(inputY.value);
		const z = parseFloat(inputZ.value);
		const checked = form.querySelector('input[name="direction"]:checked') as HTMLInputElement | null;
		const rawDir = checked ? checked.value : 'toNether';
		const direction: Direction = rawDir === 'toOverworld' ? 'toOverworld' : 'toNether';

		if (!isValidCoord(x) || !isValidCoord(y) || !isValidCoord(z)) {
			showError(resultDiv, t().invalidInput);
			return;
		}

		// No artificial delay: render synchronously in the same frame.
		const { x: resultX, z: resultZ } = convertCoordinates(x, y, z, direction);

		const tr = t();
		const overworldX = direction === 'toNether' ? x : resultX;
		const overworldZ = direction === 'toNether' ? z : resultZ;
		const netherX = direction === 'toNether' ? resultX : x;
		const netherZ = direction === 'toNether' ? resultZ : z;

		const doc = document;
		resultDiv.textContent = "";
		const card = doc.createElement("div");
		card.className = "result-success";
		const h3 = doc.createElement("h3");
		h3.textContent = tr.resultTitle;
		const grid = doc.createElement("div");
		grid.className = "result-grid";
		grid.append(
			resultColumn(doc, tr.overworldLabel, overworldX, y, overworldZ, tr),
			resultColumn(doc, tr.netherLabel, netherX, y, netherZ, tr),
		);
		const copyBtn = doc.createElement("button");
		copyBtn.className = "copy-btn";
		copyBtn.id = "copyBtn";
		copyBtn.type = "button";
		copyBtn.textContent = tr.copyBtn;
		card.append(h3, grid, copyBtn);
		resultDiv.appendChild(card);

		// Single handler per render (assignment, not addEventListener pile-up).
		let revertTimer: number | undefined;
		copyBtn.onclick = () => {
			const textToCopy = `${tr.overworldLabel}: X=${formatCoord(overworldX)}, Y=${formatCoord(y)}, Z=${formatCoord(overworldZ)}\n${tr.netherLabel}: X=${formatCoord(netherX)}, Y=${formatCoord(y)}, Z=${formatCoord(netherZ)}`;
			navigator.clipboard.writeText(textToCopy).then(() => {
				copyBtn.textContent = tr.copySuccess;
				window.clearTimeout(revertTimer);
				revertTimer = window.setTimeout(() => {
					copyBtn.textContent = tr.copyBtn;
				}, 2000);
			}).catch(() => {
				copyBtn.textContent = tr.copyError;
				window.clearTimeout(revertTimer);
				revertTimer = window.setTimeout(() => {
					copyBtn.textContent = tr.copyBtn;
				}, 2000);
			});
		};
	});
}
