import { initUi, FALLBACK_LANG } from "./ui.js";

const translations = {
	es: {
		title: "Bedrock Tools — Herramientas para Minecraft",
		skipToContent: "Saltar al contenido",
		heroBadge: "Herramientas para Minecraft Java y Bedrock",
		tagline: "Convierte addons, calcula coordenadas, organiza tus packs, explora los objetos del juego y crea recetas. Todo corre en tu navegador.",
		heroCtaPrimary: "Explorar herramientas",
		heroCtaSecondary: "Ver items y bloques",
		statItems: "Objetos catalogados",
		statTools: "Herramientas",
		statLanguages: "Idiomas",
		statUploads: "Archivos subidos",
		toolsEyebrow: "Herramientas",
		toolsTitle: "Elige tu herramienta",
		toolsSubtitle: "Todo lo que necesitas para Minecraft, en Java y Bedrock.",
		groupBoth: "Java y Bedrock",
		groupBedrock: "Solo Bedrock",
		openTool: "Abrir",
		toolsLoadError: "No pudimos cargar la lista de herramientas. Recarga la página para intentarlo de nuevo.",
		featuresEyebrow: "Ventajas",
		featuresTitle: "Por qué Bedrock Tools",
		feature1Title: "Tus archivos no salen del navegador",
		feature1Desc: "Cada conversión ocurre en tu dispositivo. Ningún pack, receta o comando pasa por un servidor nuestro.",
		feature2Title: "Al instante",
		feature2Desc: "Abre una herramienta y empieza. Sin descargas, instalaciones ni esperas.",
		feature3Title: "Pensado para Xbox y Java",
		feature3Desc: "Los packs se ordenan en la estructura com.mojang que espera la consola, y las recetas se exportan también como Data Pack.",
		feature4Title: "Gratis, sin cuentas y en dos idiomas",
		feature4Desc: "No hay registro, ni anuncios, ni versión de pago escondida. Español e inglés en todas las herramientas.",
		footerTagline: "Herramientas gratuitas para el ecosistema Minecraft, en Java y Bedrock.",
		footerColProject: "Proyecto",
		footerLicense: "Licencias",
		footerIssues: "Informar de un error",
		copyright: "© 2026 AgentitoE",
		footerMadeWith: "Hecho con ♥ para la comunidad de Minecraft",
		changeLanguageTitle: "Cambiar idioma",
		switchToLightTitle: "Cambiar a tema claro",
		switchToDarkTitle: "Cambiar a tema oscuro",
	},
	en: {
		title: "Bedrock Tools — Tools for Minecraft",
		skipToContent: "Skip to content",
		heroBadge: "Tools for Minecraft Java & Bedrock",
		tagline: "Convert addons, calculate coordinates, organize your packs, browse every item in the game and write recipes. It all runs in your browser.",
		heroCtaPrimary: "Explore tools",
		heroCtaSecondary: "Browse items & blocks",
		statItems: "Items catalogued",
		statTools: "Tools",
		statLanguages: "Languages",
		statUploads: "Files uploaded",
		toolsEyebrow: "Tools",
		toolsTitle: "Pick your tool",
		toolsSubtitle: "Everything you need for Minecraft, on Java and Bedrock.",
		groupBoth: "Java & Bedrock",
		groupBedrock: "Bedrock only",
		openTool: "Open",
		toolsLoadError: "We couldn't load the tool list. Reload the page to try again.",
		featuresEyebrow: "Benefits",
		featuresTitle: "Why Bedrock Tools",
		feature1Title: "Your files never leave the browser",
		feature1Desc: "Every conversion happens on your device. No pack, recipe or command goes through a server of ours.",
		feature2Title: "Instant",
		feature2Desc: "Open a tool and start. No downloads, no installs, no waiting.",
		feature3Title: "Built for Xbox and Java",
		feature3Desc: "Packs are laid out in the com.mojang structure the console expects, and recipes export as a Data Pack too.",
		feature4Title: "Free, no accounts, two languages",
		feature4Desc: "No sign-up, no ads, no hidden paid tier. Spanish and English across every tool.",
		footerTagline: "Free tools for the Minecraft ecosystem, on Java and Bedrock.",
		footerColProject: "Project",
		footerLicense: "Licenses",
		footerIssues: "Report a bug",
		copyright: "© 2026 AgentitoE",
		footerMadeWith: "Made with ♥ for the Minecraft community",
		changeLanguageTitle: "Change language",
		switchToLightTitle: "Switch to light theme",
		switchToDarkTitle: "Switch to dark theme",
	},
};

const ARROW = '<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-arrow-right"/></svg>';

/** Tool identity glyphs, keyed by the `icon` field of each manifest. */
const TOOL_ICONS = {
	blocks: "i-blocks",
	cube: "i-cube",
	grid3: "i-grid3",
	axes: "i-axes",
	convert: "i-convert",
	stack: "i-stack",
	"file-code": "i-file-code",
};

function pickLocalized(obj, lang) {
	if (!obj) return "";
	return obj[lang] ?? obj[FALLBACK_LANG] ?? Object.values(obj)[0] ?? "";
}

function toolIcon(iconKey) {
	const id = TOOL_ICONS[iconKey] ?? "i-cube";
	return `<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#${id}"/></svg>`;
}

function platformLabel(tool, lang) {
	const platforms = Array.isArray(tool.platforms) ? tool.platforms : ["bedrock"];
	const both = platforms.indexOf("java") !== -1 && platforms.indexOf("bedrock") !== -1;
	if (both) return lang === "es" ? "Java + Bedrock" : "Java + Bedrock";
	return lang === "es" ? "Solo Bedrock" : "Bedrock only";
}

function toolCard(tool, i, lang) {
	const t = translations[lang];
	const color = encodeURIComponent(tool.color || "#54b932");
	return (
		'<a class="tool-card reveal" style="--tool-color:' +
		color +
		";--d:" +
		i * 0.06 +
		's" href="' +
		tool.path +
		'">' +
		'<span class="tool-icon-tile">' +
		toolIcon(tool.icon) +
		"</span>" +
		'<span class="tool-name">' +
		pickLocalized(tool.name, lang) +
		"</span>" +
		'<span class="tool-desc">' +
		pickLocalized(tool.description, lang) +
		"</span>" +
		'<span class="tool-foot">' +
		'<span class="tool-platform">' +
		platformLabel(tool, lang) +
		"</span>" +
		'<span class="tool-go">' +
		t.openTool +
		ARROW +
		"</span>" +
		"</span>" +
		"</a>"
	);
}

function initGrid(lang) {
	const bothGrid = document.getElementById("toolsGridBoth");
	const bedrockGrid = document.getElementById("toolsGridBedrock");
	if (!bothGrid && !bedrockGrid) return;
	fetch("/tools-manifest.json")
		.then((res) => {
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		})
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
			trackCardPointers();
		})
		.catch((err) => {
			console.error("Fetch error:", err);
			const message =
				'<p class="tool-desc">' + translations[lang].toolsLoadError + "</p>";
			if (bothGrid) bothGrid.innerHTML = message;
			if (bedrockGrid) bedrockGrid.innerHTML = "";
		});
}

/**
 * Highlights the card under the cursor. One delegated listener covers every
 * card, including the ones rendered after a language change.
 */
function trackCardPointers() {
	for (const card of document.querySelectorAll(".tool-card")) {
		if (card.dataset.pointerTracked) continue;
		card.dataset.pointerTracked = "1";
		card.addEventListener("pointermove", (e) => {
			const rect = card.getBoundingClientRect();
			card.style.setProperty("--mx", ((e.clientX - rect.left) / rect.width) * 100 + "%");
			card.style.setProperty("--my", ((e.clientY - rect.top) / rect.height) * 100 + "%");
		});
	}
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

	const format = new Intl.NumberFormat(document.documentElement.lang || "es");

	const animate = (el) => {
		const target = parseInt(el.getAttribute("data-count"), 10);
		if (Number.isNaN(target)) return;
		const duration = 1300;
		const start = performance.now();
		const tick = (now) => {
			const p = Math.min((now - start) / duration, 1);
			const eased = 1 - Math.pow(1 - p, 3);
			el.textContent = format.format(Math.round(target * eased));
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
