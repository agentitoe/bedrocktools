/**
 * Cloudflare Pages Function: POST /api/addon-converter
 * Guía seguida: https://developers.cloudflare.com/pages/functions/ (file-based routing, onRequest* API)
 *
 * Ruta generada por file-based routing:
 *   /functions/api/addon-converter.ts  ->  /api/addon-converter
 *
 * Métodos implementados (API reference):
 *   - onRequestGet     -> documentación JSON + health check
 *   - onRequestPost    -> conversión de .mcpack/.mcaddon/.zip
 *   - onRequestOptions -> CORS preflight
 *   - onRequest        -> 405 para verbos no permitidos
 */

import { unzipSync, zipSync } from "fflate";

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB igual que el frontend: src/tools/addon-converter (public/tools/addon-converter/index.html:415)
const ALLOWED_EXTS = [".mcpack", ".mcaddon", ".zip"];

// ------------------------------------------------------------
// Shared helpers (copias de src/shared/* para no depender de bundling cross-folder)
// ------------------------------------------------------------
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function decodeUtf8Sig(data: Uint8Array): string {
  let buf = data;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.slice(3);
  }
  return new TextDecoder("utf-8").decode(buf);
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Zip-Slip guard (mirror of src/shared/path.ts): null = reject entry. */
function sanitizeZipPath(rawPath: string): string | null {
  if (rawPath.indexOf("\0") !== -1) return null;
  const p = normalizePath(rawPath);
  if (p.startsWith("/") || p.startsWith("\\")) return null;
  if (/^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) return null;
  if (stack.length === 1 && (stack[0] === "__proto__" || stack[0] === "constructor" || stack[0] === "prototype")) {
    return null;
  }
  return stack.join("/");
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let inBlockComment = false;
  let inLineComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        result += c;
      }
      continue;
    }
    if (inString) {
      result += c;
      if (c === "\\") {
        result += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else {
      result += c;
    }
  }
  return result.trim();
}

// ------------------------------------------------------------
// Lógica de conversión (src/tools/addon-converter/index.ts:6-71)
// ------------------------------------------------------------
function isBehaviorPack(manifestText: string): boolean {
  const cleaned = stripJsonComments(manifestText);
  let data: any;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return false;
  }
  const modules = Array.isArray(data.modules) ? data.modules : [];
  for (const m of modules) {
    if (typeof m === "object" && m !== null && m.type === "data") {
      return true;
    }
  }
  const header = typeof data.header === "object" && data.header !== null ? data.header : {};
  if (header.module_type === "data") {
    return true;
  }
  return false;
}

function updateManifest(data: Uint8Array): Uint8Array {
  let manifest: any;
  try {
    const cleaned = stripJsonComments(decodeUtf8Sig(data));
    manifest = JSON.parse(cleaned);
  } catch {
    return data;
  }
  if (!manifest || typeof manifest !== "object") {
    return data;
  }
  if (!manifest.metadata || typeof manifest.metadata !== "object") {
    manifest.metadata = {};
  }
  manifest.metadata.product_type = "addon";
  return encodeUtf8(JSON.stringify(manifest, null, 4));
}

async function processPack(data: Uint8Array): Promise<Uint8Array> {
  const raw = unzipSync(data);
  const toZip: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(raw)) {
    if (path.endsWith("/")) continue;
    // Drop Zip-Slip / absolute entries instead of re-emitting them.
    const p = sanitizeZipPath(path);
    if (p === null) continue;
    if (p.toLowerCase().endsWith(".mcpack")) {
      toZip[p] = await processPack(content);
      continue;
    }
    const lower = p.toLowerCase();
    if (lower === "manifest.json" || /\/manifest\.json$/.test(lower)) {
      const text = decodeUtf8Sig(content);
      if (isBehaviorPack(text)) {
        toZip[p] = updateManifest(content);
        continue;
      }
    }
    toZip[p] = content;
  }
  return zipSync(toZip, { level: 6 });
}

// ------------------------------------------------------------
// CORS & response helpers (Pages Functions ejecuta en Cloudflare Workers)
// ------------------------------------------------------------
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Content-Disposition, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(data: unknown, status: number, cors: Record<string, string>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

// ------------------------------------------------------------
// GET /api/addon-converter  -> documentación
// ------------------------------------------------------------
export async function onRequestGet(context: { request: Request }) {
  const cors = corsHeaders(context.request);
  const url = new URL(context.request.url);
  const base = `${url.protocol}//${url.host}`;

  const docs = {
    name: "Addon Converter API",
    description: "Convierte archivos .mcpack/.mcaddon para activar logros (product_type=addon). Equivalente server-side de src/tools/addon-converter/index.ts",
    version: "1.0.0",
    route: "/api/addon-converter",
    methods: ["GET", "POST", "OPTIONS"],
    limits: {
      maxFileSize: `${MAX_FILE_SIZE / (1024 * 1024)} MB`,
      allowedExtensions: ALLOWED_EXTS,
      contentTypes: ["multipart/form-data", "application/zip", "application/octet-stream", "application/json (base64)"],
    },
    get: {
      description: "Retorna esta documentación. Útil como health-check.",
      response: "application/json",
      example: `curl ${base}/api/addon-converter`,
    },
    post: {
      description: "Convierte un pack. Añade metadata.product_type='addon' a los manifest.json de behavior packs (type=data).",
      consumes: [
        {
          type: "multipart/form-data",
          field: "file",
          example: `curl -X POST ${base}/api/addon-converter -F "file=@addon.mcaddon" --output converted.mcaddon`,
        },
        {
          type: "application/zip / application/octet-stream (raw body)",
          example: `curl -X POST ${base}/api/addon-converter --data-binary @addon.mcaddon -H "Content-Type: application/zip" --output converted.mcaddon`,
        },
        {
          type: "application/json (base64)",
          body: { file: "<base64>", filename: "addon.mcaddon (opcional)" },
          example: `curl -X POST ${base}/api/addon-converter -H "Content-Type: application/json" -d '{"file":"<base64>","filename":"addon.mcaddon"}' --output converted.mcaddon`,
        },
      ],
      queryParams: {
        filename: "opcional, nombre para el archivo de salida cuando se envía raw body (ej: ?filename=pack.mcaddon)",
      },
      success: {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="*_MODIFIED.mcaddon"',
          "X-Addon-Converter": "product_type=addon",
        },
        body: "binary zip",
      },
      errors: {
        400: "Falta archivo, zip inválido o JSON mal formado",
        413: "Archivo supera 30 MB",
        405: "Método no permitido",
      },
      jsExample: [
        "// multipart/form-data (recomendado)",
        "const fd = new FormData();",
        "fd.append('file', file); // File de <input type=file>",
        "const res = await fetch('/api/addon-converter', { method: 'POST', body: fd });",
        "if (!res.ok) throw new Error(await res.text());",
        "const blob = await res.blob();",
        "",
        "// raw",
        "const buf = await file.arrayBuffer();",
        "const res2 = await fetch('/api/addon-converter?filename=' + encodeURIComponent(file.name), { method: 'POST', headers: {'Content-Type':'application/zip'}, body: buf });",
      ].join("\n"),
    },
  };

  return jsonResponse(docs, 200, cors);
}

// ------------------------------------------------------------
// POST /api/addon-converter -> conversión
// ------------------------------------------------------------
export async function onRequestPost(context: { request: Request }) {
  const request = context.request;
  const cors = corsHeaders(request);

  // Early 413 por Content-Length si está presente
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_FILE_SIZE) {
    return jsonResponse(
      {
        error: "Payload Too Large",
        message: `El archivo supera el tamaño máximo permitido (${MAX_FILE_SIZE / (1024 * 1024)} MB).`,
        maxBytes: MAX_FILE_SIZE,
      },
      413,
      cors,
    );
  }

  let fileBuffer: ArrayBuffer | null = null;
  let originalFilename = "converted.mcaddon";

  const contentType = request.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      // Workers soporta request.formData() nativo (Pages Functions runtime = Workers)
      const formData = await request.formData();
      // acepta "file", "pack" o "addon" + primer File encontrado
      let fileEntry: FormDataEntryValue | null =
        formData.get("file") ?? formData.get("pack") ?? formData.get("addon") ?? null;
      if (!fileEntry) {
        // fallback: busca el primer File en el form
        for (const v of formData.values()) {
          if (typeof v !== "string" && v instanceof File) {
            fileEntry = v;
            break;
          }
        }
      }
      if (!fileEntry || typeof fileEntry === "string") {
        return jsonResponse(
          { error: "Bad Request", message: "Campo 'file' requerido. Usa multipart/form-data con file=@tu.mcaddon" },
          400,
          cors,
        );
      }
      const file = fileEntry as unknown as File;
      originalFilename = file.name || originalFilename;
      const buf = await file.arrayBuffer();
      if (buf.byteLength === 0) {
        return jsonResponse({ error: "Bad Request", message: "Archivo vacío." }, 400, cors);
      }
      if (buf.byteLength > MAX_FILE_SIZE) {
        return jsonResponse(
          { error: "Payload Too Large", message: `Archivo supera ${MAX_FILE_SIZE / (1024 * 1024)} MB.`, maxBytes: MAX_FILE_SIZE },
          413,
          cors,
        );
      }
      fileBuffer = buf;
    } else if (contentType.includes("application/json")) {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Bad Request", message: "JSON inválido." }, 400, cors);
      }
      const b64 = body.file ?? body.data ?? body.base64 ?? null;
      const filename = body.filename ?? body.name ?? body.fileName ?? null;
      if (!b64 || typeof b64 !== "string") {
        return jsonResponse(
          { error: "Bad Request", message: "JSON debe contener {\"file\": \"<base64>\"}." },
          400,
          cors,
        );
      }
      if (filename && typeof filename === "string") originalFilename = filename;
      // data URI support
      const cleanB64 = b64.includes(",") && b64.startsWith("data:") ? b64.split(",")[1] : b64;
      let binary: Uint8Array;
      try {
        binary = Uint8Array.from(atob(cleanB64), (c) => c.charCodeAt(0));
      } catch {
        return jsonResponse({ error: "Bad Request", message: "Base64 inválido." }, 400, cors);
      }
      if (binary.byteLength === 0) {
        return jsonResponse({ error: "Bad Request", message: "Archivo vacío tras decodificar base64." }, 400, cors);
      }
      if (binary.byteLength > MAX_FILE_SIZE) {
        return jsonResponse(
          { error: "Payload Too Large", message: `Archivo supera ${MAX_FILE_SIZE / (1024 * 1024)} MB.`, maxBytes: MAX_FILE_SIZE },
          413,
          cors,
        );
      }
      fileBuffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
    } else {
      // Raw body: application/zip, application/octet-stream, o sin content-type
      // También acepta application/x-zip-compressed etc.
      const url = new URL(request.url);
      const qpFilename = url.searchParams.get("filename") || url.searchParams.get("name") || url.searchParams.get("file");
      if (qpFilename) originalFilename = qpFilename;

      const cd = request.headers.get("content-disposition");
      if (!qpFilename && cd) {
        const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
        if (m) {
          try {
            originalFilename = decodeURIComponent(m[1].replace(/"/g, ""));
          } catch {
            originalFilename = m[1].replace(/"/g, "");
          }
        }
      }

      // Si no hay body, error guiado
      const buf = await request.arrayBuffer();
      if (!buf || buf.byteLength === 0) {
        return jsonResponse(
          {
            error: "Bad Request",
            message: "Falta archivo. Envía multipart/form-data con campo 'file' o body binario con Content-Type: application/zip.",
            hint: 'curl -F "file=@addon.mcaddon" /api/addon-converter',
          },
          400,
          cors,
        );
      }
      if (buf.byteLength > MAX_FILE_SIZE) {
        return jsonResponse(
          { error: "Payload Too Large", message: `Archivo supera ${MAX_FILE_SIZE / (1024 * 1024)} MB.`, maxBytes: MAX_FILE_SIZE },
          413,
          cors,
        );
      }
      fileBuffer = buf;
    }
  } catch (e: any) {
    return jsonResponse(
      { error: "Bad Request", message: e?.message || "Error leyendo la petición." },
      400,
      cors,
    );
  }

  // Validación de extensión (solo warning, no bloqueo)
  const lowerName = originalFilename.toLowerCase();
  const hasAllowedExt = ALLOWED_EXTS.some((ext) => lowerName.endsWith(ext));
  // no bloqueamos si no coincide, pero lo registramos por si se quiere auditar

  // Procesamiento
  let output: Uint8Array;
  let wasModified: boolean = false;
  try {
    const input = new Uint8Array(fileBuffer!);

    // Detección rápida de zip: PK\x03\x04
    if (input.length < 4 || input[0] !== 0x50 || input[1] !== 0x4b) {
      // fflate dará error de todas formas, pero damos mensaje más claro
      // permitimos intentar de todos modos por si es .mcpack sin firma estándar
    }

    // Guardamos hash simple para detectar si hubo cambio (opcional)
    // En lugar de hashear, comprobaremos si algún manifest cambió comparando inclusión de product_type
    const before = input;
    output = await processPack(before);

    // Heurística: si output !== input length o bytes difieren, asumimos modificación
    // Para ser exactos, buscamos si el zip resultante contiene product_type
    try {
      const check = unzipSync(output);
      for (const [p, c] of Object.entries(check)) {
        if (p.toLowerCase().endsWith("manifest.json")) {
          const txt = decodeUtf8Sig(c as Uint8Array);
          if (txt.includes('"product_type"') && txt.includes('"addon"')) {
            wasModified = true;
            break;
          }
        }
      }
    } catch {
      wasModified = true; // si no podemos inspeccionar, asumimos que se procesó
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Mensajes comunes de fflate: invalid zip data
    return jsonResponse(
      {
        error: "Unprocessable Entity",
        message: "Archivo zip inválido o corrupto. Asegúrate de subir un .mcpack/.mcaddon/.zip válido.",
        details: msg,
      },
      400,
      cors,
    );
  }

  // Nombre de salida: base_MODIFIED.ext (igual que frontend: public/tools/addon-converter/index.html:427)
  const ext = originalFilename.includes(".") ? originalFilename.slice(originalFilename.lastIndexOf(".")) : ".mcaddon";
  const base = originalFilename.slice(0, originalFilename.lastIndexOf(".") !== -1 ? originalFilename.lastIndexOf(".") : originalFilename.length) || "converted";
  const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "converted";
  const outName = `${safeBase}_MODIFIED${ext}`;

  const headers: Record<string, string> = {
    ...cors,
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${outName.replace(/"/g, '\\"')}"`,
    "Content-Length": String(output!.length),
    "X-Addon-Converter": "product_type=addon",
    "X-Addon-Modified": wasModified ? "true" : "false",
    "Cache-Control": "no-store",
  };

  if (!hasAllowedExt) {
    headers["X-Addon-Warning"] = "extension not in .mcpack/.mcaddon/.zip";
  }
  if (!wasModified) {
    headers["X-Addon-Warning"] = "no behavior pack manifest found; file returned unchanged except re-zip";
  }

  // Uint8Array es válido como BodyInit en Workers; cast para compatibilidad con lib DOM
  return new Response(output! as unknown as BodyInit, {
    status: 200,
    headers,
  });
}

// ------------------------------------------------------------
// OPTIONS -> CORS preflight (requerido por Pages Functions)
// ------------------------------------------------------------
export async function onRequestOptions(context: { request: Request }) {
  const cors = corsHeaders(context.request);
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Content-Disposition, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// ------------------------------------------------------------
// Fallback para verbos no soportados -> 405
// ------------------------------------------------------------
export async function onRequest(context: { request: Request }) {
  const cors = corsHeaders(context.request);
  const method = context.request.method.toUpperCase();
  if (method === "GET" || method === "POST" || method === "OPTIONS") {
    // Estos ya tienen handlers específicos; este fallback no debería ejecutarse para ellos,
    // pero lo dejamos por si el runtime invoca onRequest en lugar de onRequestVerb.
    // Delegamos:
    if (method === "GET") return onRequestGet(context);
    if (method === "POST") return onRequestPost(context);
    if (method === "OPTIONS") return onRequestOptions(context);
  }
  return jsonResponse(
    {
      error: "Method Not Allowed",
      message: `Método ${method} no soportado. Usa GET, POST u OPTIONS en /api/addon-converter.`,
      allowed: ["GET", "POST", "OPTIONS"],
    },
    405,
    { ...cors, Allow: "GET, POST, OPTIONS" },
  );
}
