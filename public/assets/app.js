import { initUi, FALLBACK_LANG } from "./ui.js";

const translations = {
	es: {
		title: "Bedrock Tools — Herramientas para Minecraft",
		heroBadge: "Herramientas para Minecraft Java y Bedrock",
		tagline: "Convierte addons, calcula coordenadas, organiza tus packs, explora items y crea recetas para Java y Bedrock. Gratis, sin registro y 100% en tu navegador.",
		heroCtaPrimary: "Explorar herramientas",
		heroCtaSecondary: "Ver items y bloques",
		statTools: "Herramientas",
		statFree: "Gratis",
		statLanguages: "Idiomas",
		statLimits: "Sin límites",
		toolsEyebrow: "Herramientas",
		toolsTitle: "Elige tu herramienta",
		toolsSubtitle: "Todo lo que necesitas para Minecraft, en Java y Bedrock.",
		groupBoth: "Java y Bedrock",
		groupBedrock: "Solo Bedrock",
		openTool: "Abrir herramienta",
		featuresEyebrow: "Ventajas",
		featuresTitle: "Hecho para jugadores",
		feature1Title: "100% gratis",
		feature1Desc: "Sin cuentas ni pagos. Todas las herramientas son gratis, para siempre.",
		feature2Title: "Privado y seguro",
		feature2Desc: "Tus archivos se procesan en tu navegador y nunca salen de tu dispositivo.",
		feature3Title: "Al instante",
		feature3Desc: "Sin descargas ni instalaciones. Abre una herramienta y empieza ya.",
		feature4Title: "Hecho para Xbox",
		feature4Desc: "Convierte y organiza packs listos para la carpeta com.mojang de Xbox.",
		footerTagline: "Herramientas gratuitas para Minecraft, en Java y Bedrock.",
		copyright: "Hecho con ♥️ por AgentitoE",
		changeLanguageTitle: "Cambiar idioma",
		switchToLightTitle: "Cambiar a tema claro",
		switchToDarkTitle: "Cambiar a tema oscuro",
	},
	en: {
		title: "Bedrock Tools — Tools for Minecraft",
		heroBadge: "Tools for Minecraft Java & Bedrock",
		tagline: "Convert addons, calculate coordinates, organize your packs, browse items and create recipes for Java and Bedrock. Free, no sign-up, 100% in your browser.",
		heroCtaPrimary: "Explore tools",
		heroCtaSecondary: "Browse items & blocks",
		statTools: "Tools",
		statFree: "Free",
		statLanguages: "Languages",
		statLimits: "No limits",
		toolsEyebrow: "Tools",
		toolsTitle: "Pick your tool",
		toolsSubtitle: "Everything you need for Minecraft, on Java and Bedrock.",
		groupBoth: "Java & Bedrock",
		groupBedrock: "Bedrock only",
		openTool: "Open tool",
		featuresEyebrow: "Benefits",
		featuresTitle: "Built for players",
		feature1Title: "100% free",
		feature1Desc: "No accounts, no payments. Every tool is free, forever.",
		feature2Title: "Private & secure",
		feature2Desc: "Your files are processed in your browser and never leave your device.",
		feature3Title: "Instant",
		feature3Desc: "No downloads or installs. Open a tool and start right away.",
		feature4Title: "Made for Xbox",
		feature4Desc: "Convert and organize packs ready for the com.mojang folder on Xbox.",
		footerTagline: "Free tools for Minecraft, on Java and Bedrock.",
		copyright: "Made with ♥️ by AgentitoE",
		changeLanguageTitle: "Change language",
		switchToLightTitle: "Switch to light theme",
		switchToDarkTitle: "Switch to dark theme",
	},
};

function pickLocalized(obj, lang) {
	if (!obj) return "";
	return obj[lang] ?? obj[FALLBACK_LANG] ?? Object.values(obj)[0] ?? "";
}

function toolCard(tool, i, lang) {
	const t = translations[lang];
	return (
		'<a class="tool-card reveal" style="--tool-color:' + tool.color + ';--d:' + (i * 0.06) + 's" href="' + tool.path + '">' +
		'<span class="tool-icon-tile">' + tool.icon + '</span>' +
		'<span class="tool-name">' + pickLocalized(tool.name, lang) + '</span>' +
		'<span class="tool-desc">' + pickLocalized(tool.description, lang) + '</span>' +
		'<span class="tool-link">' + t.openTool + ' <span class="arrow">→</span></span>' +
		"</a>"
	);
}

function initGrid(lang) {
	const bothGrid = document.getElementById("toolsGridBoth");
	const bedrockGrid = document.getElementById("toolsGridBedrock");
	if (!bothGrid && !bedrockGrid) return;
	fetch("/tools-manifest.json")
		.then((res) => res.json())
		.then((tools) => {
			const isBoth = (tool) =>
				Array.isArray(tool.platforms) &&
				tool.platforms.indexOf("java") !== -1 &&
				tool.platforms.indexOf("bedrock") !== -1;
			const both = tools.filter(isBoth);
			const bedrockOnly = tools.filter((tool) => !isBoth(tool));

			if (bothGrid) {
				bothGrid.innerHTML = both.map((tool, i) => toolCard(tool, i, lang)).join("");
			}
			if (bedrockGrid) {
				bedrockGrid.innerHTML = bedrockOnly.map((tool, i) => toolCard(tool, i, lang)).join("");
			}
			observeReveals();
		})
		.catch((err) => {
			console.error("Fetch error:", err);
			if (bothGrid) bothGrid.innerHTML = '<p style="color:var(--muted)">No tools available.</p>';
			if (bedrockGrid) bedrockGrid.innerHTML = "";
		});
}

let revealObserver = null;

function observeReveals() {
	const els = Array.from(document.querySelectorAll(".reveal")).filter((el) => !el.dataset.revealObserved);
	if (!els.length) return;

	if (!("IntersectionObserver" in window)) {
		els.forEach((el) => {
			el.dataset.revealObserved = "1";
			el.classList.add("in");
		});
		return;
	}

	if (!revealObserver) {
		revealObserver = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						entry.target.classList.add("in");
						revealObserver.unobserve(entry.target);
					}
				});
			},
			{ threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
		);
	}

	els.forEach((el) => {
		el.dataset.revealObserved = "1";
		revealObserver.observe(el);
	});
}

function initStats() {
	const counters = Array.from(document.querySelectorAll(".stat-num[data-count]"));
	if (!counters.length) return;

	const animate = (el) => {
		const target = parseInt(el.getAttribute("data-count"), 10);
		const suffix = el.getAttribute("data-suffix") || "";
		if (Number.isNaN(target)) return;
		const duration = 1300;
		const start = performance.now();
		const tick = (now) => {
			const p = Math.min((now - start) / duration, 1);
			const eased = 1 - Math.pow(1 - p, 3);
			el.textContent = Math.round(target * eased) + suffix;
			if (p < 1) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	};

	if (!("IntersectionObserver" in window)) {
		counters.forEach(animate);
		return;
	}

	const io = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				if (entry.isIntersecting) {
					animate(entry.target);
					io.unobserve(entry.target);
				}
			});
		},
		{ threshold: 0.4 }
	);

	counters.forEach((el) => io.observe(el));
}

const lang = initUi(translations, { onLangChange: initGrid });
initGrid(lang);
initStats();
observeReveals();
