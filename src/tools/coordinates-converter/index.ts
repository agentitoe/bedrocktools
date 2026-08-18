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

function initCalculator(): void {
	initUi(translations);

	const form = document.getElementById('coordForm') as HTMLFormElement | null;
	const resultDiv = document.getElementById('result');
	if (!form || !resultDiv) return;

	form.addEventListener('submit', (e) => {
		e.preventDefault();

		const x = parseFloat((document.getElementById('coordX') as HTMLInputElement).value);
		const y = parseFloat((document.getElementById('coordY') as HTMLInputElement).value);
		const z = parseFloat((document.getElementById('coordZ') as HTMLInputElement).value);
		const checked = document.querySelector('input[name="direction"]:checked') as HTMLInputElement | null;
		const direction = checked ? checked.value : 'toNether';

		if (isNaN(x) || isNaN(y) || isNaN(z)) {
			resultDiv.innerHTML = `<div class="result-error">${t().invalidInput}</div>`;
			return;
		}

		resultDiv.innerHTML = `<div class="result-loading">${t().calculating}...</div>`;

		setTimeout(() => {
			const { x: resultX, z: resultZ } = convertCoordinates(x, y, z, direction as Direction);

			const tr = t();
			const overworldX = direction === 'toNether' ? x : resultX;
			const overworldZ = direction === 'toNether' ? z : resultZ;
			const netherX = direction === 'toNether' ? resultX : x;
			const netherZ = direction === 'toNether' ? resultZ : z;

			resultDiv.innerHTML = `
<div class="result-success">
<h3>${tr.resultTitle}</h3>
<div class="result-grid">
<div class="result-column">
<strong>${tr.overworldLabel}</strong>
<div class="result-coords">
<span class="result-coord"><span class="result-coord-label">${tr.xLabel}:</span><span class="result-coord-value">${formatCoord(overworldX)}</span></span>
<span class="result-coord"><span class="result-coord-label">${tr.yLabel}:</span><span class="result-coord-value">${formatCoord(y)}</span></span>
<span class="result-coord"><span class="result-coord-label">${tr.zLabel}:</span><span class="result-coord-value">${formatCoord(overworldZ)}</span></span>
</div>
</div>
<div class="result-column">
<strong>${tr.netherLabel}</strong>
<div class="result-coords">
<span class="result-coord"><span class="result-coord-label">${tr.xLabel}:</span><span class="result-coord-value">${formatCoord(netherX)}</span></span>
<span class="result-coord"><span class="result-coord-label">${tr.yLabel}:</span><span class="result-coord-value">${formatCoord(y)}</span></span>
<span class="result-coord"><span class="result-coord-label">${tr.zLabel}:</span><span class="result-coord-value">${formatCoord(netherZ)}</span></span>
</div>
</div>
</div>
<button class="copy-btn" id="copyBtn">${tr.copyBtn}</button>
</div>
`;

			const copyBtn = document.getElementById('copyBtn');
			if (copyBtn) {
				copyBtn.addEventListener('click', () => {
					const textToCopy = `${tr.overworldLabel}: X=${formatCoord(overworldX)}, Y=${formatCoord(y)}, Z=${formatCoord(overworldZ)}
${tr.netherLabel}: X=${formatCoord(netherX)}, Y=${formatCoord(y)}, Z=${formatCoord(netherZ)}`;

					navigator.clipboard.writeText(textToCopy).then(() => {
						copyBtn.textContent = tr.copySuccess;
						setTimeout(() => {
							copyBtn.textContent = tr.copyBtn;
						}, 2000);
					}).catch(() => {
						copyBtn.textContent = tr.copyError;
						setTimeout(() => {
							copyBtn.textContent = tr.copyBtn;
						}, 2000);
					});
				});
			}
		}, 300);
	});
}
