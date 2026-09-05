/* ==========================================================================
   BedrockTools — API Docs app (vanilla module, sin dependencias)
   Lee /openapi.json, renderiza referencia estilo Spotify de 3 columnas:
   sidebar nav + centro endpoints + rail derecha (URL + Try-it + samples).
   ========================================================================== */

const MAX_BYTES = 30 * 1024 * 1024;
const SPEC_URLS = ["/openapi.json", "../openapi.json", "./openapi.json", "openapi.json"];
const METHOD_ORDER = ["post", "get", "options"];

const I18N = {
  es: {
    parameters: "Parámetros",
    requestBody: "Cuerpo de la petición",
    responses: "Respuestas",
    headers: "Headers",
    schema: "Esquema",
    example: "Ejemplo",
    required: "requerido",
    optional: "opcional",
    binaryNote: "Respuesta binaria (ZIP). Usa Try-it o cURL con --output para descargarla.",
    noParams: "Sin parámetros.",
    schemasTitle: "Esquemas",
    tryTarget: "Probar",
    send: "Enviar",
    sending: "Enviando…",
    noFile: "Selecciona un archivo primero.",
    tooLarge: "supera el límite de 30 MB",
    download: "Descargar respuesta",
    respEmpty: "Aún sin respuesta. Configura el Try-it y pulsa Enviar.",
    copied: "¡Copiado!",
    copy: "Copiar",
    navEndpoints: "Addon Converter",
    navSchemas: "Schemas",
    searchEmpty: "Sin resultados.",
  },
  en: {
    parameters: "Parameters",
    requestBody: "Request body",
    responses: "Responses",
    headers: "Headers",
    schema: "Schema",
    example: "Example",
    required: "required",
    optional: "optional",
    binaryNote: "Binary response (ZIP). Use Try-it or cURL with --output to download it.",
    noParams: "No parameters.",
    schemasTitle: "Schemas",
    tryTarget: "Try",
    send: "Send",
    sending: "Sending…",
    noFile: "Pick a file first.",
    tooLarge: "exceeds the 30 MB limit",
    download: "Download response",
    respEmpty: "No response yet. Configure Try-it and press Send.",
    copied: "Copied!",
    copy: "Copy",
    navEndpoints: "Addon Converter",
    navSchemas: "Schemas",
    searchEmpty: "No results.",
  },
};

const state = {
  lang: document.documentElement.lang === "en" ? "en" : "es",
  spec: null,
  servers: [],
  activeServer: "",
  ops: [],
  activeOp: null,
  tryCt: "multipart/form-data",
  lastBlobUrl: null,
};

let spyObserver = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
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

function mdLite(src) {
  if (src == null) return "";
  let h = esc(src);
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  return h;
}

function resolveRef(obj) {
  let cur = obj;
  const seen = new Set();
  while (cur && typeof cur === "object" && typeof cur.$ref === "string") {
    if (seen.has(cur.$ref)) break;
    seen.add(cur.$ref);
    const m = cur.$ref.match(/^#\/components\/(headers|schemas)\/(.+)$/);
    if (!m) break;
    const [, kind, name] = m;
    cur = state.spec?.components?.[kind]?.[name];
    if (!cur) return null;
  }
  return cur || null;
}

function schemaType(sch) {
  if (!sch) return "—";
  const r = resolveRef(sch) || sch;
  let base = Array.isArray(r.type) ? r.type.join(" | ") : r.type || (r.properties ? "object" : r.items ? "array" : "—");
  if (r.format) base += ` (${r.format})`;
  if (r.nullable) base += " · nullable";
  if (Array.isArray(r.enum) && r.enum.length) base += ` · enum: ${r.enum.join(", ")}`;
  return base;
}

function schemaExample(sch) {
  const r = resolveRef(sch) || sch;
  if (!r || typeof r !== "object") return "";
  if (r.example !== undefined) return String(r.example);
  if (Array.isArray(r.enum) && r.enum.length) return String(r.enum[0]);
  return "";
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

/* --- spec load ------------------------------------------------------------ */
async function loadSpec() {
  let lastErr = null;
  for (const u of SPEC_URLS) {
    try {
      const res = await fetch(u, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!res.ok) { lastErr = new Error(`${u}: HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("spec not found");
}

function normalizeSpec(spec) {
  state.spec = spec;
  state.servers = Array.isArray(spec.servers) ? spec.servers : [];
  state.activeServer = state.servers[0]?.url || window.location.origin;

  const pathEntries = Object.entries(spec.paths || {});
  const ops = [];
  for (const [path, item] of pathEntries) {
    for (const m of METHOD_ORDER) {
      const op = item?.[m];
      if (op) ops.push({ method: m, path, op });
    }
    for (const [m, op] of Object.entries(item || {})) {
      if (METHOD_ORDER.includes(m) || m.startsWith("x-") || ["parameters", "summary", "description", "$ref"].includes(m)) continue;
      if (op && typeof op === "object") ops.push({ method: m, path, op });
    }
  }
  state.ops = ops;
  state.activeOp = ops.find((o) => o.op.operationId === "convertAddon") || ops[0] || null;

  const v = spec.info?.version || "1.0.0";
  const chip = $("#ref-version");
  if (chip) chip.textContent = `v${v}`;
}

/* --- nav ------------------------------------------------------------------- */
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
  sel.addEventListener("change", () => {
    state.activeServer = sel.value;
    updateRail();
  });
}

function opLabel(o) {
  return o.op.summary || o.op.operationId || `${o.method.toUpperCase()} ${o.path}`;
}

function renderNav() {
  const nav = $("#ref-nav-tree");
  if (!nav) return;
  nav.innerHTML = "";

  const group = document.createElement("div");
  group.className = "ref-nav-group";
  group.innerHTML = `<button type="button" class="ref-nav-toggle" aria-expanded="true"><span>${esc(t("navEndpoints"))}</span><span class="caret">▾</span></button><div class="ref-nav-items"></div>`;
  const items = $(".ref-nav-items", group);
  const toggle = $(".ref-nav-toggle", group);
  toggle.addEventListener("click", () => {
    group.classList.toggle("closed");
    toggle.setAttribute("aria-expanded", group.classList.contains("closed") ? "false" : "true");
  });

  state.ops.forEach((o) => {
    const id = `op-${o.op.operationId || `${o.method}-${o.path.replace(/[^a-z0-9]+/gi, "-")}`}`;
    o.anchor = id;
    const a = document.createElement("a");
    a.className = "ref-nav-item";
    a.href = `#${id}`;
    a.dataset.op = id;
    a.dataset.search = `${o.method} ${o.path} ${opLabel(o)} ${o.op.description || ""}`.toLowerCase();
    a.innerHTML = `<span class="method-pill ${esc(o.method)}">${esc(o.method)}</span><span>${esc(opLabel(o))}</span>`;
    a.addEventListener("click", () => {
      setActiveOp(o, false);
      closeDrawer();
    });
    items.appendChild(a);
  });
  nav.appendChild(group);

  const schemas = Object.keys(state.spec?.components?.schemas || {});
  if (schemas.length) {
    const g2 = document.createElement("div");
    g2.className = "ref-nav-group";
    g2.innerHTML = `<button type="button" class="ref-nav-toggle" aria-expanded="true"><span>${esc(t("navSchemas"))}</span><span class="caret">▾</span></button><div class="ref-nav-items"></div>`;
    const box = $(".ref-nav-items", g2);
    $(".ref-nav-toggle", g2).addEventListener("click", () => g2.classList.toggle("closed"));
    schemas.forEach((name) => {
      const a = document.createElement("a");
      a.className = "ref-nav-item ref-nav-schema";
      a.href = `#schema-${name}`;
      a.dataset.search = `schema ${name}`.toLowerCase();
      a.innerHTML = `<span class="ref-type">${esc(name)}</span>`;
      a.addEventListener("click", () => closeDrawer());
      box.appendChild(a);
    });
    nav.appendChild(g2);
  }
  markActiveNav();
}

function markActiveNav() {
  $$("#ref-nav-tree .ref-nav-item").forEach((a) => {
    a.classList.toggle("active", !!state.activeOp && a.dataset.op === state.activeOp.anchor);
  });
}

function smoothScrollTo(el) {
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

function setActiveOp(o, scroll = true) {
  state.activeOp = o;
  markActiveNav();
  updateRail();
  if (scroll && o?.anchor) {
    smoothScrollTo(document.getElementById(o.anchor));
  }
}

/* --- endpoints -------------------------------------------------------------- */
function paramExample(p) {
  const sch = p.schema || {};
  if (sch.example !== undefined) return String(sch.example);
  if (p.example !== undefined) return String(p.example);
  return "";
}

function renderParams(op) {
  const params = op.op.parameters || [];
  if (!params.length) return `<p class="ref-req-desc">${esc(t("noParams"))}</p>`;
  const rows = params.map((p) => {
    const req = p.required ? `<span class="ref-reqbadge req">${esc(t("required"))}</span>` : `<span class="ref-reqbadge">${esc(t("optional"))}</span>`;
    return `<tr><td class="ref-mono">${esc(p.name)}</td><td>${esc(p.in || "query")}</td><td><span class="ref-type">${esc(schemaType(p.schema))}</span></td><td>${req}</td><td>${mdLite(p.description || "")}</td><td class="ref-mono">${esc(paramExample(p))}</td></tr>`;
  }).join("");
  return `<div class="ref-tablewrap"><table class="param-table"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Desc</th><th>Example</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function schemaTreeLines(name, sch, depth, out) {
  const r = resolveRef(sch) || sch || {};
  const pad = "  ".repeat(depth);
  const reqList = Array.isArray(r.required) ? r.required : [];
  if (r.type === "object" || r.properties) {
    out.push(`${pad}${name ? name + ": " : ""}object${r.nullable ? " · nullable" : ""}`);
    for (const [k, v] of Object.entries(r.properties || {})) {
      const rv = resolveRef(v) || v;
      const isReq = reqList.includes(k);
      const sub = rv?.type === "object" || rv?.properties ? "" : ` <span class="st-type">${esc(schemaType(rv))}</span>${isReq ? ' <span class="st-req">required</span>' : ""}${rv?.nullable ? ' <span class="st-null">nullable</span>' : ""}`;
      out.push(`${pad}  <span class="st-key">${esc(k)}</span>${sub}${rv?.description ? ` <span class="st-desc">— ${esc(rv.description)}</span>` : ""}`);
      if (rv?.type === "object" || rv?.properties) {
        schemaTreeLines(k, rv, depth + 2, out);
      } else if (rv?.type === "array" && rv?.items) {
        const it = resolveRef(rv.items) || rv.items;
        out.push(`${pad}    [] <span class="st-type">${esc(schemaType(it))}</span>`);
      }
    }
    return;
  }
  if (r.type === "array") {
    out.push(`${pad}${name ? name + ": " : ""}array`);
    if (r.items) schemaTreeLines("[]", r.items, depth + 1, out);
    return;
  }
  out.push(`${pad}${name ? name + ": " : ""}<span class="st-type">${esc(schemaType(r))}</span>`);
}

function schemaTreeHtml(sch, rootName = "") {
  const out = [];
  schemaTreeLines(rootName, sch, 0, out);
  return `<div class="schema-tree" tabindex="0">${out.join("\n")}</div>`;
}

function contentExampleHtml(media) {
  if (!media) return "";
  if (media.example !== undefined) {
    return `<div class="ref-sample-head"><span>${esc(t("example"))}</span><button type="button" class="ref-copybtn" data-copy>${esc(t("copy"))}</button></div><pre class="ref-sample" tabindex="0">${esc(typeof media.example === "string" ? media.example : prettyJson(media.example))}</pre>`;
  }
  const exs = media.examples || {};
  const keys = Object.keys(exs);
  if (!keys.length) return "";
  const first = exs[keys[0]];
  const val = first?.value !== undefined ? first.value : first;
  const label = first?.summary || keys[0];
  return `<div class="ref-sample-head"><span>${esc(t("example"))}: ${esc(label)}</span><button type="button" class="ref-copybtn" data-copy>${esc(t("copy"))}</button></div><pre class="ref-sample" tabindex="0">${esc(typeof val === "string" ? val : prettyJson(val))}</pre>`;
}

function renderRequestBody(op) {
  const content = op.op.requestBody?.content || {};
  const cts = Object.keys(content);
  if (!cts.length) return "";
  const tabs = cts.map((ct, i) =>
    `<button type="button" role="tab" class="ref-tab" data-ct="${esc(ct)}" aria-selected="${i === 0 ? "true" : "false"}" tabindex="${i === 0 ? "0" : "-1"}">${esc(ct)}</button>`
  ).join("");
  const panels = cts.map((ct, i) => {
    const media = content[ct];
    const sch = media?.schema ? resolveRef(media.schema) || media.schema : null;
    return `<div role="tabpanel" class="ref-tabpanel" data-ct-panel="${esc(ct)}"${i === 0 ? "" : " hidden"}>${sch ? schemaTreeHtml(sch) : ""}${contentExampleHtml(media)}</div>`;
  }).join("");
  return `<div class="ref-block"><h3>${esc(t("requestBody"))}${op.op.requestBody?.required ? ` · <span class="ref-reqbadge req">${esc(t("required"))}</span>` : ""}</h3>${op.op.requestBody?.description ? `<p class="ref-req-desc">${mdLite(op.op.requestBody.description)}</p>` : ""}<div class="ref-tabs" role="tablist" data-tabs="req">${tabs}</div>${panels}</div>`;
}

function statusDot(code) {
  if (code.startsWith("2")) return "ok";
  if (code.startsWith("4") || code.startsWith("5")) return "err";
  return "info";
}

function renderResponses(op) {
  const responses = op.op.responses || {};
  const codes = Object.keys(responses).sort();
  if (!codes.length) return "";
  const tabs = codes.map((c, i) =>
    `<button type="button" role="tab" class="ref-tab" data-code="${esc(c)}" aria-selected="${i === 0 ? "true" : "false"}" tabindex="${i === 0 ? "0" : "-1"}"><span class="ref-status-dot ${statusDot(c)}"></span>${esc(c)}</button>`
  ).join("");
  const panels = codes.map((c, i) => {
    const r = responses[c] || {};
    const headers = r.headers || {};
    const hnames = Object.keys(headers);
    const htable = hnames.length
      ? `<div class="ref-sample-head"><span>${esc(t("headers"))}</span></div><div class="ref-tablewrap"><table class="headers-table"><thead><tr><th>Header</th><th>Type</th><th>Desc</th><th>Example</th></tr></thead><tbody>${hnames.map((hn) => {
        const h = resolveRef(headers[hn]) || headers[hn] || {};
        const hs = h.schema ? resolveRef(h.schema) || h.schema : {};
        return `<tr><td class="ref-mono">${esc(hn)}</td><td><span class="ref-type">${esc(schemaType(hs))}</span></td><td>${mdLite(h.description || "")}</td><td class="ref-mono">${esc(hs.example !== undefined ? String(hs.example) : "")}</td></tr>`;
      }).join("")}</tbody></table></div>`
      : "";
    const content = r.content || {};
    const cts = Object.keys(content);
    let bodyHtml = "";
    if (!cts.length) {
      bodyHtml = `<p class="ref-req-desc">${esc(r.description || "")}</p>`;
    } else {
      bodyHtml = cts.map((ct) => {
        const media = content[ct];
        const sch = media?.schema ? resolveRef(media.schema) || media.schema : null;
        const isBinary = sch?.format === "binary" || ct.includes("zip") || ct.includes("octet-stream");
        return `<div class="ref-sample-head"><span>${esc(ct)}</span></div>${sch ? schemaTreeHtml(sch) : ""}${isBinary ? `<p class="ref-req-desc">⬇ ${esc(t("binaryNote"))}</p>` : contentExampleHtml(media)}`;
      }).join("");
    }
    return `<div role="tabpanel" class="ref-tabpanel" data-code-panel="${esc(c)}"${i === 0 ? "" : " hidden"}><p class="ref-req-desc">${mdLite(r.description || "")}</p>${htable}${bodyHtml}</div>`;
  }).join("");
  return `<div class="ref-block"><h3>${esc(t("responses"))}</h3><div class="ref-tabs" role="tablist" data-tabs="resp">${tabs}</div>${panels}</div>`;
}

function renderEndpoints() {
  const host = $("#ref-endpoints");
  if (!host) return;
  host.innerHTML = "";
  state.ops.forEach((o) => {
    const sec = document.createElement("section");
    sec.className = "ref-endpoint";
    sec.id = o.anchor;
    sec.dataset.search = `${o.method} ${o.path} ${opLabel(o)} ${o.op.description || ""}`.toLowerCase();
    sec.innerHTML = `
      <div class="ref-end-head">
        <h2>${esc(opLabel(o))}</h2>
        <p class="ref-end-desc">${mdLite(o.op.description || "")}</p>
        <div class="ref-request-line">
          <span class="method-pill ${esc(o.method)}">${esc(o.method)}</span>
          <code class="ref-path">${esc(o.path)}</code>
          <a class="ref-anchor" href="#${esc(o.anchor)}" title="Deep link">#</a>
        </div>
      </div>
      <div class="ref-block"><h3>${esc(t("parameters"))}</h3>${renderParams(o)}</div>
      ${renderRequestBody(o)}
      ${renderResponses(o)}`;
    host.appendChild(sec);
  });
  wireAllTabs(host);
  wireAllCopy(host);
}

function renderSchemas() {
  const host = $("#ref-schemas");
  if (!host) return;
  host.innerHTML = "";
  const schemas = state.spec?.components?.schemas || {};
  for (const [name, sch] of Object.entries(schemas)) {
    const r = resolveRef(sch) || sch;
    const sec = document.createElement("section");
    sec.className = "ref-endpoint";
    sec.id = `schema-${name}`;
    const props = r.properties || {};
    const rows = Object.entries(props).map(([k, v]) => {
      const rv = resolveRef(v) || v;
      const isReq = Array.isArray(r.required) && r.required.includes(k);
      return `<tr><td class="ref-mono">${esc(k)}</td><td><span class="ref-type">${esc(schemaType(rv))}</span></td><td>${isReq ? `<span class="ref-reqbadge req">${esc(t("required"))}</span>` : `<span class="ref-reqbadge">${esc(t("optional"))}</span>`}</td><td>${mdLite(rv.description || "")}</td><td class="ref-mono">${esc(rv.example !== undefined ? String(Array.isArray(rv.example) ? JSON.stringify(rv.example) : rv.example) : "")}</td></tr>`;
    }).join("");
    sec.innerHTML = `<div class="ref-end-head"><h2>${esc(name)}</h2><p class="ref-end-desc">${mdLite(r.description || "")}</p></div>${schemaTreeHtml(r)}${rows ? `<div class="ref-block"><div class="ref-tablewrap"><table class="param-table"><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Desc</th><th>Example</th></tr></thead><tbody>${rows}</tbody></table></div></div>` : ""}`;
    host.appendChild(sec);
  }
}

/* --- tabs + copy ------------------------------------------------------------ */
function wireTabs(list) {
  const tabs = $$('[role="tab"]', list);
  if (!tabs.length) return;
  const key = list.dataset.tabs || "x";
  const panels = [...list.parentElement.querySelectorAll(`.ref-tabpanel`)].filter((p) => {
    if (key === "req") return p.hasAttribute("data-ct-panel");
    if (key === "resp") return p.hasAttribute("data-code-panel");
    return true;
  });
  const select = (tab) => {
    tabs.forEach((x) => { x.setAttribute("aria-selected", x === tab ? "true" : "false"); x.tabIndex = x === tab ? 0 : -1; });
    const ct = tab.dataset.ct;
    const code = tab.dataset.code;
    panels.forEach((p) => {
      const show = (ct && p.dataset.ctPanel === ct) || (code && p.dataset.codePanel === code);
      if (show) p.removeAttribute("hidden"); else p.setAttribute("hidden", "");
    });
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : tabs[(i - 1 + tabs.length) % tabs.length];
      next.focus();
      select(next);
    });
  });
}

function wireAllTabs(root) {
  $$('[data-tabs]', root).forEach(wireTabs);
}

function wireAllCopy(root) {
  $$("[data-copy]", root).forEach((btn) => {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.addEventListener("click", () => {
      const pre = btn.parentElement?.nextElementSibling;
      const text = pre && pre.tagName === "PRE" ? pre.textContent : "";
      copyText(text, btn);
    });
  });
}

/* --- code samples (usan server activo) --------------------------------------- */
function baseUrl() {
  return (state.activeServer || window.location.origin).replace(/\/$/, "");
}

function tryFilename() {
  const inp = $("#try-filename");
  const v = inp?.value?.trim();
  return v || "addon.mcaddon";
}

function buildSamples() {
  const o = state.activeOp;
  if (!o) return { curl: "", js: "", py: "" };
  const url = `${baseUrl()}${o.path}`;
  const fn = tryFilename();
  if (o.method === "get") {
    return {
      curl: `curl "${url}"`,
      js: `const res = await fetch(${JSON.stringify(url)});\nif (!res.ok) throw new Error(await res.text());\nconst docs = await res.json();\nconsole.log(docs);`,
      py: `import requests\n\nres = requests.get(${JSON.stringify(url)})\nres.raise_for_status()\nprint(res.json())`,
    };
  }
  if (o.method === "options") {
    return {
      curl: `curl -X OPTIONS -i "${url}"`,
      js: `const res = await fetch(${JSON.stringify(url)}, { method: "OPTIONS" });\nconsole.log(res.status, [...res.headers]);`,
      py: `import requests\n\nres = requests.options(${JSON.stringify(url)})\nprint(res.status_code, res.headers)`,
    };
  }
  const ct = state.tryCt;
  if (ct === "application/json") {
    return {
      curl: `curl -X POST "${url}" -H "Content-Type: application/json" -d '{"file":"<base64>","filename":${JSON.stringify(fn)}}' --output converted.mcaddon`,
      js: `// JSON base64 (server-to-server)\nconst buf = await file.arrayBuffer();\nlet bin = "";\nconst bytes = new Uint8Array(buf);\nfor (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);\nconst res = await fetch(${JSON.stringify(url)}, {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ file: btoa(bin), filename: file.name }),\n});\nif (!res.ok) throw new Error(await res.text());\nconst blob = await res.blob();`,
      py: `import base64, requests\n\ndata = open("addon.mcaddon", "rb").read()\nres = requests.post(${JSON.stringify(url)}, json={\n    "file": base64.b64encode(data).decode(),\n    "filename": ${JSON.stringify(fn)},\n})\nres.raise_for_status()\nopen("converted.mcaddon", "wb").write(res.content)`,
    };
  }
  if (ct === "multipart/form-data") {
    return {
      curl: `curl -X POST "${url}" -F "file=@${fn}" --output converted.mcaddon`,
      js: `const fd = new FormData();\nfd.append("file", file);\nconst res = await fetch(${JSON.stringify(url)}, { method: "POST", body: fd });\nif (!res.ok) throw new Error(await res.text());\nconst blob = await res.blob();`,
      py: `import requests\n\nwith open(${JSON.stringify(fn)}, "rb") as f:\n    res = requests.post(${JSON.stringify(url)}, files={"file": f})\nres.raise_for_status()\nopen("converted.mcaddon", "wb").write(res.content)`,
    };
  }
  return {
    curl: `curl -X POST "${url}?filename=${encodeURIComponent(fn)}" --data-binary @${fn} -H "Content-Type: ${ct}" --output converted.mcaddon`,
    js: `const buf = await file.arrayBuffer();\nconst res = await fetch(${JSON.stringify(url)} + "?filename=" + encodeURIComponent(file.name), {\n  method: "POST",\n  headers: { "Content-Type": ${JSON.stringify(ct)} },\n  body: buf,\n});\nif (!res.ok) throw new Error(await res.text());\nconst blob = await res.blob();`,
    py: `import requests\n\ndata = open(${JSON.stringify(fn)}, "rb").read()\nres = requests.post(${JSON.stringify(url)}, params={"filename": ${JSON.stringify(fn)}}, data=data, headers={"Content-Type": ${JSON.stringify(ct)}})\nres.raise_for_status()\nopen("converted.mcaddon", "wb").write(res.content)`,
  };
}

/* --- rail -------------------------------------------------------------------- */
let codeLang = "curl";

function updateRail() {
  const o = state.activeOp;
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
  const target = $("#try-target");
  if (target && o) target.textContent = `${o.method.toUpperCase()} ${o.path}`;

  const isPost = o?.method === "post";
  ["#try-ct-wrap", "#try-file-wrap", "#try-name-wrap", "#try-b64-wrap"].forEach((s) => {
    const el = $(s);
    if (!el) return;
    if (!isPost) {
      el.style.display = "none";
    } else {
      el.style.display = "";
    }
  });
  const b64w = $("#try-b64-wrap");
  if (b64w && isPost) b64w.style.display = state.tryCt === "application/json" ? "" : "none";
}

function wireRail() {
  const railTabs = [...document.querySelectorAll("#ref-code-tabs .ref-tab")];
  const selectRail = (tab) => {
    $$("#ref-code-tabs .ref-tab").forEach((x) => { x.setAttribute("aria-pressed", x === tab ? "true" : "false"); x.tabIndex = x === tab ? 0 : -1; });
    codeLang = tab.dataset.clang || "curl";
    const samples = buildSamples();
    $("#ref-code-pre").textContent = samples[codeLang] || "";
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
  if (copyUrl && !copyUrl.dataset.label) copyUrl.dataset.label = copyUrl.textContent;
  copyUrl?.addEventListener("click", () => copyText($("#ref-urlbox-code")?.textContent || "", copyUrl));
  const copyCode = $("#ref-code-copy");
  if (copyCode && !copyCode.dataset.label) copyCode.dataset.label = copyCode.textContent;
  copyCode?.addEventListener("click", () => copyText($("#ref-code-pre")?.textContent || "", copyCode));

  $("#try-filename")?.addEventListener("input", () => {
    const samples = buildSamples();
    const pre = $("#ref-code-pre");
    if (pre) pre.textContent = samples[codeLang] || "";
    const urlbox = $("#ref-urlbox-code");
    if (urlbox && state.activeOp) urlbox.textContent = `${baseUrl()}${state.activeOp.path}`;
  });
  $("#try-ct")?.addEventListener("change", (e) => {
    state.tryCt = e.target.value;
    updateRail();
  });
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
    const nameInp = $("#try-filename");
    if (nameInp && !nameInp.value) nameInp.value = f.name;
  });
  $("#ref-try-send")?.addEventListener("click", sendTryIt);
}

/* --- Try-it ------------------------------------------------------------------- */
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
  const keys = Object.keys(obj || {});
  el.textContent = keys.length ? keys.map((k) => `${k}: ${obj[k]}`).join("\n") : "";
  el.style.display = keys.length ? "" : "none";
}

function setRespBody(text, isJson) {
  const pre = $("#ref-resp-pre");
  if (!pre) return;
  if (!text) { pre.textContent = ""; pre.style.display = "none"; return; }
  pre.style.display = "";
  if (isJson) {
    try { pre.textContent = prettyJson(JSON.parse(text)); return; } catch { /* raw */ }
  }
  pre.textContent = text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncado)` : text;
}

function setDownload(url, name) {
  const a = $("#ref-resp-download");
  if (!a) return;
  if (!url) { a.style.display = "none"; a.removeAttribute("href"); return; }
  a.style.display = "";
  a.href = url;
  a.download = name || "converted.mcaddon";
  a.textContent = `⬇ ${t("download")}${name ? ` (${name})` : ""}`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.includes(",") ? s.split(",").pop() : s);
    };
    r.onerror = () => reject(new Error("read error"));
    r.onabort = () => reject(new Error("read abort"));
    r.readAsDataURL(file);
  });
}

async function sendTryIt() {
  const btn = $("#ref-try-send");
  const o = state.activeOp;
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
    let res;
    if (o.method === "get" || o.method === "options") {
      res = await fetch(url, { method: o.method.toUpperCase() });
    } else if (state.tryCt === "multipart/form-data") {
      const f = $("#try-file")?.files?.[0];
      if (!f) throw new Error(t("noFile"));
      if (f.size > MAX_BYTES) throw new Error(`${f.name} ${t("tooLarge")}`);
      const fd = new FormData();
      fd.append("file", f, f.name);
      res = await fetch(url, { method: "POST", body: fd });
    } else if (state.tryCt === "application/json") {
      const f = $("#try-file")?.files?.[0];
      const manual = $("#try-base64")?.value?.trim();
      let b64 = manual || "";
      if (f) {
        if (f.size > MAX_BYTES) throw new Error(`${f.name} ${t("tooLarge")}`);
        b64 = await readFileAsBase64(f);
      }
      if (!b64) throw new Error(t("noFile"));
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: b64, filename: tryFilename() }),
      });
    } else {
      const f = $("#try-file")?.files?.[0];
      if (!f) throw new Error(t("noFile"));
      if (f.size > MAX_BYTES) throw new Error(`${f.name} ${t("tooLarge")}`);
      const buf = await f.arrayBuffer();
      const q = `${url}?filename=${encodeURIComponent($("#try-filename")?.value?.trim() || f.name)}`;
      res = await fetch(q, { method: "POST", headers: { "Content-Type": state.tryCt }, body: buf });
    }

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
      const name = (m?.[1]?.trim().replace(/"/g, "") || "converted_MODIFIED.mcaddon");
      state.lastBlobUrl = URL.createObjectURL(blob);
      setRespBody(`binary ${(blob.size / 1024).toFixed(1)} KB — ${ct}`, false);
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

/* --- search / drawer / spy ------------------------------------------------------ */
function wireSearch() {
  const inp = $("#ref-search");
  if (!inp) return;
  inp.addEventListener("input", () => {
    const q = inp.value.trim().toLowerCase();
    let visible = 0;
    $$("#ref-nav-tree .ref-nav-item").forEach((a) => {
      const hit = !q || (a.dataset.search || "").includes(q);
      a.classList.toggle("hidden-by-search", !hit);
      if (hit && a.dataset.op) visible++;
    });
    const empty = $("#ref-nav-empty");
    if (empty) empty.style.display = visible === 0 && q ? "block" : "none";
    $$("#ref-endpoints .ref-endpoint").forEach((s) => {
      s.classList.toggle("is-hidden", !(!q || (s.dataset.search || "").includes(q)));
    });
    const schHost = $("#ref-schemas");
    if (schHost) schHost.style.display = q ? "none" : "";
  });
}

function wireDrawer() {
  const btn = $("#ref-menu-btn");
  const side = $("#ref-sidebar");
  const ov = $("#ref-overlay");
  const syncAria = () => btn?.setAttribute("aria-expanded", side?.classList.contains("open") ? "true" : "false");
  btn?.addEventListener("click", () => {
    side?.classList.toggle("open");
    ov?.classList.toggle("show", !!side?.classList.contains("open"));
    syncAria();
  });
  ov?.addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  syncAria();
}

function closeDrawer() {
  $("#ref-sidebar")?.classList.remove("open");
  $("#ref-overlay")?.classList.remove("show");
  $("#ref-menu-btn")?.setAttribute("aria-expanded", "false");
}

function wireSpy() {
  if (!("IntersectionObserver" in window)) return;
  if (spyObserver) spyObserver.disconnect();
  const map = new Map(state.ops.map((o) => [o.anchor, o]));
  spyObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const o = map.get(en.target.id);
        if (o && o !== state.activeOp) {
          state.activeOp = o;
          markActiveNav();
          updateRail();
          history.replaceState(null, "", `#${o.anchor}`);
        }
      }
    }
  }, { rootMargin: "-30% 0px -55% 0px", threshold: 0 });
  state.ops.forEach((o) => {
    const el = document.getElementById(o.anchor);
    if (el) spyObserver.observe(el);
  });
}

/* --- i18n (solo chrome dinámico; estático lo hace initUi) ------------------------ */
export function setLang(lang) {
  state.lang = I18N[lang] ? lang : "es";
  if (!state.spec) return; // init() aún no cargó el spec: solo fija idioma
  renderNav();
  renderEndpoints();
  renderSchemas();
  wireSpy();
  const send = $("#ref-try-send");
  if (send && send.disabled !== true) send.textContent = t("send");
  const empty = $("#ref-resp-empty");
  if (empty) empty.textContent = t("respEmpty");
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
    renderNav();
    renderEndpoints();
    renderSchemas();
    wireRail();
    wireSearch();
    wireDrawer();
    updateRail();
    wireSpy();
    setRespMeta(null, null, false);

    const hash = (location.hash || "").replace("#", "");
    if (hash) {
      const hit = state.ops.find((o) => o.anchor === hash);
      if (hit) {
        setActiveOp(hit, false);
        requestAnimationFrame(() => smoothScrollTo(document.getElementById(hash)));
      } else {
        requestAnimationFrame(() => smoothScrollTo(document.getElementById(hash)));
      }
    }
    window.addEventListener("hashchange", () => {
      const h = (location.hash || "").replace("#", "");
      const hit = state.ops.find((o) => o.anchor === h);
      if (hit && hit !== state.activeOp) setActiveOp(hit, false);
    });
  } catch (e) {
    console.error("[api-docs]", e);
    if (errBox) {
      errBox.classList.add("show");
      errBox.innerHTML = `<strong>⚠ No se pudo cargar <code>/openapi.json</code>.</strong><br><span>${esc(String(e?.message || e))}</span><br><span>Sirve el repo con <code>bun scripts/serve.mjs</code> o <code>wrangler pages dev public</code> y abre <code>/api-docs/</code>.</span>`;
    }
    const skel = $("#ref-skeleton");
    if (skel) skel.style.display = "none";
  } finally {
    const skel = $("#ref-skeleton");
    if (skel && state.ops.length) skel.style.display = "none";
  }
}
