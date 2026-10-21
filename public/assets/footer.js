/**
 * Footer compartido de Bedrock Tools.
 *
 * Genera e inyecta el markup del <footer class="site-footer"> en cada
 * placeholder declarado como:
 *
 *   <footer
 *     class="site-footer"
 *     data-chrome="footer"
 *     data-footer-variant="home|default"
 *     data-footer-tagline="Texto de la tagline"
 *     data-footer-copyright="Texto inicial del copyright"
 *   ></footer>
 *
 * - `data-footer-variant="home"` añade el enlace "Informar de un error".
 * - `data-footer-variant="default"` usa GitHub + Licencias + Todas las herramientas.
 * - Los textos iniciales son el contenido por defecto en español; los elementos
 *   conservan sus atributos data-i18n para que initUi los traduzca después.
 *
 * Script clásico (sin módulos), pensado para cargarse con `defer` o justo tras
 * el placeholder. Usar siempre rutas relativas en el src (Sonar S6859).
 */
(function () {
	"use strict";

	var BASE_VARIANT_LINKS = {
		home:
			'<a class="footer-link" href="https://github.com/agentitoe/bedrocktools/issues" target="_blank" rel="noopener noreferrer">' +
			'<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-folder" /></svg>' +
			'<span data-i18n="footerIssues">Informar de un error</span>' +
			"</a>",
		default:
			'<a class="footer-link" href="/">' +
			'<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-blocks" /></svg>' +
			'<span data-i18n="footerAllTools">Todas las herramientas</span>' +
			"</a>",
	};

	var DEFAULT_TAGLINE = "Herramientas gratuitas para el ecosistema Minecraft, en Java y Bedrock.";

	function escapeText(value) {
		return String(value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function renderFooter(el) {
		var variant = el.getAttribute("data-footer-variant") === "home" ? "home" : "default";
		var tagline = el.getAttribute("data-footer-tagline") || DEFAULT_TAGLINE;
		var copyright = el.getAttribute("data-footer-copyright") || "";

		el.innerHTML =
			'<div class="container">' +
			'<div class="footer-inner">' +
			"<div>" +
			'<div class="footer-brand">BEDROCK TOOLS</div>' +
			'<p class="footer-tagline" data-i18n="footerTagline">' +
			escapeText(tagline) +
			"</p>" +
			"</div>" +
			'<nav class="footer-nav" aria-label="Footer">' +
			'<div class="footer-col">' +
			'<span class="footer-heading" data-i18n="footerColProject">Proyecto</span>' +
			'<a class="footer-link" href="https://github.com/agentitoe/bedrocktools" target="_blank" rel="noopener noreferrer">' +
			'<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-external" /></svg>' +
			"GitHub" +
			"</a>" +
			'<a class="footer-link" href="/licenses">' +
			'<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#i-file" /></svg>' +
			'<span data-i18n="footerLicense">Licencias</span>' +
			"</a>" +
			BASE_VARIANT_LINKS[variant] +
			"</div>" +
			"</nav>" +
			"</div>" +
			'<div class="footer-bottom">' +
			'<span data-i18n="copyright">' +
			escapeText(copyright) +
			"</span>" +
			'<span data-i18n="footerMadeWith">Hecho con \u2665 para la comunidad de Minecraft</span>' +
			"</div>" +
			"</div>";
	}

	function init() {
		var placeholders = document.querySelectorAll('footer[data-chrome="footer"]');
		for (var i = 0; i < placeholders.length; i += 1) {
			renderFooter(placeholders[i]);
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
