/* ==========================================================================
   BedrockTools — API Docs app (vanilla module, sin dependencias)
   Diseño humano 1 columna: hero + Try-it multipart arriba + samples
   simples + referencia POST/GET + <details> avanzado.
   - 1 solo fetch a /openapi.json (sin reintentos múltiples)
   - Sin operation OPTIONS, sin grupo Schemas, sin tablas CORS
   - Todo bilingüe ES/EN vía I18N + initUi/setLang
   ========================================================================== */

const MAX_BYTES = 30 * 1024 * 1024;
const SPEC_URL = "/openapi.json";
/* Solo lo que una persona necesita: convertir (POST) y ayuda (GET).
   OPTIONS se oculta a propósito: es preflight del navegador, no de personas. */
const METHOD_ORDER = ["post", "get"];
const HIDDEN_METHODS = new Set(["options", "head", "trace"]);
/* Solo estos headers importan a una persona. El resto (CORS genérico)
   se oculta para no parecer Swagger automático. */
const VISIBLE_HEADERS = new Set(["content-disposition", "x-addon-modified", "x-addon-warning"]);

const I18N = {
  es: {
    send: "Convertir",
    sending: "Convirtiendo…",
    noFile: "Selecciona un archivo primero.",
    tooLarge: "supera el límite de 30 MB",
    download: "Descargar",
    respEmpty: "Aún sin respuesta. Elige un archivo y pulsa Convertir.",
    copied: "¡Copiado!",
    copy: "Copiar",
    truncated: "…(truncado)",
    binaryReady: "listo para descargar",
    whatSend: "Qué enviar",
    whatGet: "Qué recibes",
    fileField: "Campo file con tu .mcpack / .mcaddon / .zip (máx. 30 MB).",
    outName: "El archivo vuelve con nombre *_MODIFIED.mcaddon.",
    modifiedNote: "X-Addon-Modified te dice si hubo cambios: true = convertido, false = venía igual.",
    warningNote: "Si no había behavior pack que convertir, verás un aviso humano y el archivo vuelve tal cual.",
    errorsTitle: "Si algo sale mal",
    helpTitle: "Ayuda de la API",
    convertTitle: "Convierte tu pack",
    convertDesc: "Sube tu archivo y te lo devolvemos listo para jugar con logros.",
    getDesc: "Devuelve una ayuda corta. Con Accept-Language: es recibes español; sin ella, inglés.",
    paramName: "filename",
    paramWhere: "query · opcional",
    paramDesc: "Solo para envío binario directo (raw). Con multipart no lo necesitas.",
    loadFailTitle: "No se pudo cargar /openapi.json.",
    loadFailHint: "Sirve el repo con bun scripts/serve.mjs y abre /api-docs/.",
    headersTitle: "Cabeceras que importan",
    hDisposition: "Nombre de descarga, ya con *_MODIFIED.mcaddon.",
    hModified: "true si tu pack quedó listo, false si venía sin cambios.",
    hWarning: "Aviso humano solo si no había nada que convertir.",
    advJsonSample: "JSON base64 (para bots)",
    advRawSample: "Binario directo (raw)",
  },
  en: {
    send: "Convert",
    sending: "Converting…",
    noFile: "Pick a file first.",
    tooLarge: "exceeds the 30 MB limit",
    download: "Download",
    respEmpty: "No response yet. Pick a file and press Convert.",
    copied: "Copied!",
    copy: "Copy",
    truncated: "…(truncated)",
    binaryReady: "ready to download",
    whatSend: "What to send",
    whatGet: "What you get",
    fileField: "Field file with your .mcpack / .mcaddon / .zip (max 30 MB).",
    outName: "The file comes back named *_MODIFIED.mcaddon.",
    modifiedNote: "X-Addon-Modified tells you if anything changed: true = converted, false = already fine.",
    warningNote: "If there was no behavior pack to convert, you will see a human notice and the file comes back as-is.",
    errorsTitle: "If something goes wrong",
    helpTitle: "API help",
    convertTitle: "Convert your pack",
    convertDesc: "Upload your file and get it back ready to play with achievements.",
    getDesc: "Returns a short help object. With Accept-Language: es you get Spanish; otherwise English.",
    paramName: "filename",
    paramWhere: "query · optional",
    paramDesc: "Only for raw binary uploads. With multipart you do not need it.",
    loadFailTitle: "Could not load /openapi.json.",
    loadFailHint: "Serve the repo with bun scripts/serve.mjs and open /api-docs/.",
    headersTitle: "Headers that matter",
    hDisposition: "Download name, already as *_MODIFIED.mcaddon.",
    hModified: "true if your pack is ready, false if unchanged.",
    hWarning: "Human notice only if there was nothing to convert.",
    advJsonSample: "JSON base64 (for bots)",
    advRawSample: "Raw binary",
  },
};

const state = {
  lang: document.documentElement.lang === "en" ? "en" : "es",
  spec: null,
  servers: [],
  activeServer: "",
  ops: [],
  activeOp: null,
  lastBlobUrl: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const t = (key) => (I18N[state.lang] && I18N[state.lang][key]) || I18N.es[key] || key;

/* --- utils --------------------------------------------------------------- */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function prettyJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function copyText(text, btn) {
  const orig = btn?.textContent;
  const done = () => {
    if (!btn) return;
    btn.textContent = t("copied");
    btn.classList.add("copied");
    setTimeout(() => { if (orig != null) btn.textContent = orig; btn.classList.remove("copied"); }, 1400);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text) && done());
  } else if (fallbackCopy(text)) {
    done();
  }
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Nombre de salida unificado: siempre *_MODIFIED.mcaddon */
function modifiedName(orig) {
  const base = String(orig || "addon.mcaddon").split(/[\\/]/).pop().trim() || "addon.mcaddon";
  const noExt = base.replace(/\.(mcpack|mcaddon|zip)$/i, "") || "addon";
  return `${noExt}_MODIFIED.mcaddon`;
}

/* --- spec load: UN solo intento ------------------------------------------- */
async function loadSpec() {
  const res = await fetch(SPEC_URL, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${SPEC_URL}: HTTP ${res.status}`);
  return res.json();
}

function normalizeSpec(spec) {
  state.spec = spec;
  state.servers = Array.isArray(spec.servers) ? spec.servers : [];
  state.activeServer = state.servers[0]?.url || window.location.origin;

  const ops = [];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const m of METHOD_ORDER) {
      const op = item?.[m];
      if (op) ops.push({ method: m, path, op });
    }
    // Cualquier otro método (options/head/…) se ignora a propósito.
  }
  state.ops = ops.filter((o) => !HIDDEN_METHODS.has(o.method));
  state.activeOp =
    state.ops.find((o) => o.op.operationId === "convertAddon") ||
    state.ops.find((o) => o.method === "post") ||
    state.ops[0] ||
    null;

  const v = spec.info?.version || "1.0.0";
  const chip = $("#ref-version");
  if (chip) chip.textContent = `v${v}`;
}

/* --- servers ---------------------------------------------------------------- */
function renderServerSelect() {
  const sel = $("#ref-server");
  if (!sel) return;
  sel.innerHTML = "";
  state.servers.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = s.url;
    o.textContent = `${s.url}${s.description ? ` — ${s.description}` : ""}`;
    if (i === 0) o.selected = true;
    sel.appendChild(o);
  });
  if (!state.servers.length) {
    const o = document.createElement("option");
    o.value = window.location.origin;
    o.textContent = window.location.origin;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    state.activeServer = sel.value;
    updateRail();
  };
}

function baseUrl() {
  return (state.activeServer || window.location.origin).replace(/\/$/, "");
}

function postOp() {
  return (
    state.ops.find((o) => o.op.operationId === "convertAddon") ||
    state.ops.find((o) => o.method === "post") ||
    state.activeOp
  );
}

/* --- endpoints humanos ------------------------------------------------------- */
function errorCards(op) {
  const responses = op.op.responses || {};
  const codes = Object.keys(responses)
    .filter((c) => c.startsWith("4"))
    .sort();
  if (!codes.length) return "";
  const items = codes
    .map((c) => {
      const r = responses[c] || {};
      const content = r.content?.["application/json"] || {};
      const ex = content.example || Object.values(content.examples || {})[0]?.value;
      const msg = state.lang === "es" ? ex?.messageEs || ex?.message : ex?.message || ex?.messageEs;
      const label = ex?.code ? `<code>${esc(ex.code)}</code> — ` : "";
      return `<li><strong>HTTP ${esc(c)}</strong> · ${label}${esc(msg || r.description || "")}</li>`;
    })
    .join("");
  return `<div class="ref-block"><h3>${esc(t("errorsTitle"))}</h3><ul class="err-list">${items}</ul></div>`;
}

function headersHuman() {
  const rows = [
    ["Content-Disposition", "attachment", t("hDisposition")],
    ["X-Addon-Modified", "true / false", t("hModified")],
    ["X-Addon-Warning", "string", t("hWarning")],
  ]
    .map(
      ([n, ex, d]) =>
        `<tr><td class="ref-mono">${esc(n)}</td><td class="ref-mono dim">${esc(ex)}</td><td>${esc(d)}</td></tr>`
    )
    .join("");
  return `<div class="ref-block"><h3>${esc(t("headersTitle"))}</h3>`
    + `<div class="ref-tablewrap"><table class="param-table"><tbody>${rows}</tbody></table></div>`
    + `<p class="ref-req-desc">💡 ${esc(t("modifiedNote"))}<br>⚠️ ${esc(t("warningNote"))}</p></div>`;
}

function renderEndpoints() {
  const host = $("#ref-endpoints");
  if (!host) return;
  host.innerHTML = "";
  const post = postOp();
  const get = state.ops.find((o) => o.method === "get");

  if (post) {
    const sec = document.createElement("section");
    sec.className = "ref-endpoint";
    sec.id = "op-convert";
    sec.innerHTML = `
      <div class="ref-end-head">
        <p class="ref-kicker"><span class="method-pill post">post</span> <code class="ref-path">${esc(post.path)}</code></p>
        <h2>${esc(t("convertTitle"))}</h2>
        <p class="ref-end-desc">${esc(t("convertDesc"))}</p>
      </div>
      <div class="ref-block"><h3>${esc(t("whatSend"))}</h3>
        <p class="ref-req-desc">📦 <code>multipart/form-data</code> · <code>file</code> — ${esc(t("fileField"))}</p>
        <p class="ref-req-desc">🔤 <code>?${esc(t("paramName"))}</code> (${esc(t("paramWhere"))}) — ${esc(t("paramDesc"))}</p>
      </div>
      <div class="ref-block"><h3>${esc(t("whatGet"))}</h3>
        <p class="ref-req-desc">⬇️ ZIP — ${esc(t("outName"))}</p>
      </div>
      ${headersHuman()}
      ${errorCards(post)}`;
    host.appendChild(sec);
  }

  if (get) {
    const sec = document.createElement("section");
    sec.className = "ref-endpoint ref-endpoint--ghost";
    sec.id = "op-help";
    sec.innerHTML = `
      <div class="ref-end-head">
        <p class="ref-kicker"><span class="method-pill get">get</span> <code class="ref-path">${esc(get.path)}</code></p>
        <h2>${esc(t("helpTitle"))}</h2>
        <p class="ref-end-desc">${esc(t("getDesc"))}</p>
        <p class="ref-req-desc"><code>{ name, whatFor, usage, limits, exampleCurl, docs }</code></p>
      </div>`;
    host.appendChild(sec);
  }
}

/* --- code samples: solo multipart simple -------------------------------------- */
let codeLang = "curl";

function buildSamples() {
  const o = postOp();
  const url = o ? `${baseUrl()}${o.path}` : `${baseUrl()}/api/addon-converter`;
  const out = "addon_MODIFIED.mcaddon";
  const get = state.ops.find((x) => x.method === "get");
  // Si el usuario está mirando la ayuda GET, muestra el GET simple.
  if (state.activeOp?.method === "get" && get) {
    const gurl = `${baseUrl()}${get.path}`;
    return {
      curl: `curl "${gurl}"`,
      js: `const res = await fetch(${JSON.stringify(gurl)});\nif (!res.ok) throw new Error(await res.text());\nconst docs = await res.json();\nconsole.log(docs);`,
      py: `import requests\n\nres = requests.get(${JSON.stringify(gurl)})\nres.raise_for_status()\nprint(res.json())`,
    };
  }
  return {
    curl: `curl -X POST "${url}" -F "file=@addon.mcaddon" --output ${out}`,
    js: `const fd = new FormData();\nfd.append("file", file);\nconst res = await fetch(${JSON.stringify(url)}, { method: "POST", body: fd });\nif (!res.ok) throw new Error(await res.text());\nconst blob = await res.blob();\nconst a = document.createElement("a");\na.href = URL.createObjectURL(blob);\na.download = ${JSON.stringify(out)};\na.click();`,
    py: `import requests\n\nwith open("addon.mcaddon", "rb") as f:\n    res = requests.post(${JSON.stringify(url)}, files={"file": f})\nres.raise_for_status()\nopen(${JSON.stringify(out)}, "wb").write(res.content)`,
  };
}

function buildAdvancedSamples() {
  const o = postOp();
  const url = o ? `${baseUrl()}${o.path}` : `${baseUrl()}/api/addon-converter`;
  const out = "addon_MODIFIED.mcaddon";
  const json = `curl -X POST "${url}" -H "Content-Type: application/json" -d '{"file":"<base64>","filename":"addon.mcaddon"}' --output ${out}`;
  const raw = `curl -X POST "${url}?filename=addon.mcaddon" --data-binary @addon.mcaddon -H "Content-Type: application/octet-stream" --output ${out}`;
  return { json, raw };
}

function updateRail() {
  const o = postOp();
  const urlbox = $("#ref-urlbox-code");
  const pill = $("#ref-urlbox-method");
  if (urlbox && o) {
    urlbox.textContent = `${baseUrl()}${o.path}`;
    if (pill) {
      pill.textContent = o.method;
      pill.className = `method-pill ${o.method}`;
    }
  }
  const samples = buildSamples();
  const pre = $("#ref-code-pre");
  if (pre) pre.textContent = samples[codeLang] || samples.curl || "";
  const adv = buildAdvancedSamples();
  const aj = $("#ref-adv-json");
  if (aj) aj.textContent = adv.json;
  const ar = $("#ref-adv-raw");
  if (ar) ar.textContent = adv.raw;
  const target = $("#try-target");
  if (target && o) target.textContent = `${o.method.toUpperCase()} ${o.path}`;
}

function wireRail() {
  const railTabs = [...document.querySelectorAll("#ref-code-tabs .ref-tab")];
  const selectRail = (tab) => {
    document.querySelectorAll("#ref-code-tabs .ref-tab").forEach((x) => {
      x.setAttribute("aria-pressed", x === tab ? "true" : "false");
      x.tabIndex = x === tab ? 0 : -1;
    });
    codeLang = tab.dataset.clang || "curl";
    const samples = buildSamples();
    const pre = $("#ref-code-pre");
    if (pre) pre.textContent = samples[codeLang] || "";
  };
  railTabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectRail(tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = e.key === "ArrowRight" ? railTabs[(i + 1) % railTabs.length] : railTabs[(i - 1 + railTabs.length) % railTabs.length];
      next.focus();
      selectRail(next);
    });
  });
  const copyUrl = $("#ref-urlbox-copy");
  copyUrl?.addEventListener("click", () => copyText($("#ref-urlbox-code")?.textContent || "", copyUrl));
  const copyCode = $("#ref-code-copy");
  copyCode?.addEventListener("click", () => copyText($("#ref-code-pre")?.textContent || "", copyCode));

  $("#try-file")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    const sizeEl = $("#try-size");
    const send = $("#ref-try-send");
    if (!f) {
      if (sizeEl) { sizeEl.textContent = ""; sizeEl.classList.remove("over"); }
      if (send) send.disabled = false;
      return;
    }
    const mb = (f.size / 1048576).toFixed(2);
    const over = f.size > MAX_BYTES;
    if (sizeEl) {
      sizeEl.textContent = `${f.name} — ${mb} MB${over ? ` · ${t("tooLarge")}` : ""}`;
      sizeEl.classList.toggle("over", over);
    }
    if (send) send.disabled = over;
  });
  $("#ref-try-send")?.addEventListener("click", sendTryIt);
}

/* --- Try-it: siempre multipart ------------------------------------------------- */
function setRespMeta(status, ms, ok) {
  const pill = $("#ref-resp-status");
  if (pill) {
    pill.textContent = status == null ? "—" : `HTTP ${status}`;
    pill.className = `ref-status-pill ${status == null ? "" : ok ? "ok" : "err"}`;
  }
  const el = $("#ref-resp-ms");
  if (el) el.textContent = ms == null ? "" : `${ms} ms`;
}

function setRespHeaders(obj) {
  const el = $("#ref-resp-headers");
  if (!el) return;
  const entries = Object.entries(obj || {}).filter(([k]) => VISIBLE_HEADERS.has(String(k).toLowerCase()));
  el.textContent = entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  el.style.display = entries.length ? "" : "none";
}

function setRespBody(text, isJson) {
  const pre = $("#ref-resp-pre");
  if (!pre) return;
  if (!text) { pre.textContent = ""; pre.style.display = "none"; return; }
  pre.style.display = "";
  if (isJson) {
    try { pre.textContent = prettyJson(JSON.parse(text)); return; } catch { /* raw */ }
  }
  pre.textContent = text.length > 20000 ? `${text.slice(0, 20000)}\n${t("truncated")}` : text;
}

function setDownload(url, name) {
  const a = $("#ref-resp-download");
  if (!a) return;
  if (!url) { a.style.display = "none"; a.removeAttribute("href"); return; }
  a.style.display = "";
  a.href = url;
  a.download = name || "addon_MODIFIED.mcaddon";
  a.textContent = `⬇ ${t("download")} (${name || "addon_MODIFIED.mcaddon"})`;
}

async function sendTryIt() {
  const btn = $("#ref-try-send");
  const o = postOp();
  if (!o) return;
  const url = `${baseUrl()}${o.path}`;
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = t("sending"); }
  setRespMeta(null, null, false);
  setRespHeaders({});
  setRespBody("", false);
  setDownload(null);
  const t0 = performance.now();

  try {
    const f = $("#try-file")?.files?.[0];
    if (!f) throw new Error(t("noFile"));
    if (f.size > MAX_BYTES) throw new Error(`${f.name} ${t("tooLarge")}`);
    const fd = new FormData();
    fd.append("file", f, f.name);
    const res = await fetch(url, { method: "POST", body: fd });

    const ms = Math.round(performance.now() - t0);
    const hobj = {};
    res.headers.forEach((v, k) => { hobj[k] = v; });
    const ct = res.headers.get("content-type") || "";
    setRespMeta(res.status, ms, res.ok);
    setRespHeaders(hobj);
    const emptyEl = $("#ref-resp-empty");
    if (emptyEl) emptyEl.style.display = "none";

    if (ct.includes("zip") || ct.includes("octet-stream")) {
      const blob = await res.blob();
      if (state.lastBlobUrl) URL.revokeObjectURL(state.lastBlobUrl);
      const cd = res.headers.get("content-disposition") || "";
      const m = cd.match(/filename="([^"]+)"/) || cd.match(/filename=([^;]+)/);
      const name = (m?.[1]?.trim().replace(/"/g, "") || modifiedName(f.name));
      state.lastBlobUrl = URL.createObjectURL(blob);
      setRespBody(`binary ${(blob.size / 1024).toFixed(1)} KB · ${ct} · ${t("binaryReady")}`, false);
      setDownload(state.lastBlobUrl, name);
    } else {
      const text = await res.text();
      setRespBody(text, ct.includes("json"));
    }
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    setRespMeta("ERR", ms, false);
    const emptyEl = $("#ref-resp-empty");
    if (emptyEl) emptyEl.style.display = "none";
    setRespBody(String(e?.message || e), false);
  } finally {
    if (btn) { btn.disabled = $("#try-file")?.files?.[0]?.size > MAX_BYTES; btn.textContent = orig; }
  }
}

/* --- i18n (solo chrome dinámico; estático lo hace initUi) ------------------------ */
export function setLang(lang) {
  state.lang = I18N[lang] ? lang : "es";
  if (!state.spec) return;
  renderEndpoints();
  const send = $("#ref-try-send");
  if (send && !send.disabled) send.textContent = t("send");
  const empty = $("#ref-resp-empty");
  if (empty && $("#ref-resp-pre")?.style.display === "none") empty.textContent = t("respEmpty");
  // Re-etiqueta el tamaño si hay archivo elegido
  const f = $("#try-file")?.files?.[0];
  const sizeEl = $("#try-size");
  if (f && sizeEl?.textContent) {
    const mb = (f.size / 1048576).toFixed(2);
    const over = f.size > MAX_BYTES;
    sizeEl.textContent = `${f.name} — ${mb} MB${over ? ` · ${t("tooLarge")}` : ""}`;
  }
  updateRail();
}

export function getLang() {
  return state.lang;
}

/* --- boot ------------------------------------------------------------------------- */
export async function init() {
  const errBox = $("#ref-error");
  try {
    const spec = await loadSpec();
    normalizeSpec(spec);
    renderServerSelect();
    renderEndpoints();
    wireRail();
    updateRail();
    setRespMeta(null, null, false);
  } catch (e) {
    console.error("[api-docs]", e);
    if (errBox) {
      errBox.classList.add("show");
      errBox.innerHTML = `<strong>⚠ ${esc(t("loadFailTitle"))}</strong><br><span>${esc(String(e?.message || e))}</span><br><span>${esc(t("loadFailHint"))}</span>`;
    }
    const skel = $("#ref-skeleton");
    if (skel) skel.style.display = "none";
  } finally {
    const skel = $("#ref-skeleton");
    if (skel && state.ops.length) skel.style.display = "none";
  }
}
