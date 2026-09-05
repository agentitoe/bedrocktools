/**
 * Addon Converter API: POST /api/addon-converter
 *
 * Sube tu .mcaddon y te lo devolvemos listo para usar con logros en Xbox.
 * Upload your .mcaddon and get it back ready to use with achievements on Xbox.
 */

import { unzipSync, zipSync } from "fflate";

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB
const ALLOWED_EXTS = [".mcpack", ".mcaddon", ".zip"];

// ------------------------------------------------------------
// Shared helpers
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

/** Zip-Slip guard: null = reject entry. */
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
// Conversion logic
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
    // Drop unsafe / absolute entries instead of re-emitting them.
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
// CORS & response helpers
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
// Language + bilingual errors
// ------------------------------------------------------------
function prefersSpanish(request: Request): boolean {
  const header = request.headers.get("accept-language") || "";
  const first = header.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return first === "es" || first.startsWith("es-") || first.startsWith("es;");
}

type ErrorCode =
  | "MISSING_FILE"
  | "EMPTY_FILE"
  | "INVALID_JSON"
  | "INVALID_BASE64"
  | "INVALID_ZIP"
  | "TOO_LARGE"
  | "METHOD_NOT_ALLOWED";

const ERROR_TEXTS: Record<ErrorCode, { error: string; message: string; messageEs: string; status: number }> = {
  MISSING_FILE: {
    error: "Missing file",
    message: "Upload a .mcpack/.mcaddon/.zip file",
    messageEs: "Sube un archivo .mcpack/.mcaddon/.zip",
    status: 400,
  },
  EMPTY_FILE: {
    error: "Empty file",
    message: "The file is empty. Upload a valid .mcpack/.mcaddon/.zip file",
    messageEs: "El archivo está vacío. Sube un archivo .mcpack/.mcaddon/.zip válido",
    status: 400,
  },
  INVALID_JSON: {
    error: "Invalid JSON",
    message: 'Invalid JSON. Send {"file": "<base64>"}',
    messageEs: 'JSON no válido. Envía {"file": "<base64>"}',
    status: 400,
  },
  INVALID_BASE64: {
    error: "Invalid base64",
    message: "Invalid base64 data",
    messageEs: "Datos base64 no válidos",
    status: 400,
  },
  INVALID_ZIP: {
    error: "Invalid ZIP",
    message: "Invalid or corrupted file. Upload a valid .mcpack/.mcaddon/.zip file",
    messageEs: "Archivo no válido o dañado. Sube un archivo .mcpack/.mcaddon/.zip válido",
    status: 400,
  },
  TOO_LARGE: {
    error: "File too large",
    message: "File is larger than 30 MB",
    messageEs: "El archivo supera los 30 MB",
    status: 413,
  },
  METHOD_NOT_ALLOWED: {
    error: "Method not allowed",
    message: "Method not allowed. Use GET or POST",
    messageEs: "Método no permitido. Usa GET o POST",
    status: 405,
  },
};

function errorResponse(code: ErrorCode, cors: Record<string, string>, method?: string, extraHeaders: Record<string, string> = {}): Response {
  const t = ERROR_TEXTS[code];
  const body =
    code === "METHOD_NOT_ALLOWED" && method
      ? {
          error: t.error,
          code,
          message: `Method ${method} not allowed. Use GET or POST`,
          messageEs: `Método ${method} no permitido. Usa GET o POST`,
        }
      : { error: t.error, code, message: t.message, messageEs: t.messageEs };
  return jsonResponse(body, t.status, cors, extraHeaders);
}

// ------------------------------------------------------------
// GET /api/addon-converter -> human-friendly docs
// ------------------------------------------------------------
export async function onRequestGet(context: { request: Request }) {
  const cors = corsHeaders(context.request);
  const url = new URL(context.request.url);
  const base = `${url.protocol}//${url.host}`;
  const es = prefersSpanish(context.request);

  const docs = es
    ? {
        name: "Addon Converter",
        whatFor: "Sube tu .mcaddon y te lo devolvemos listo para usar con logros en Xbox.",
        usage: {
          multipart: 'POST multipart/form-data con campo "file" (recomendado).',
          json: 'POST application/json con {"file": "<base64>", "filename": "addon.mcaddon"} (para bots).',
        },
        limits: { maxSize: "30 MB" },
        exampleCurl: `curl -X POST ${base}/api/addon-converter -F "file=@addon.mcaddon" --output converted.mcaddon`,
        docs: "/api-docs/",
      }
    : {
        name: "Addon Converter",
        whatFor: "Upload your .mcaddon and get it back ready to use with achievements on Xbox.",
        usage: {
          multipart: 'POST multipart/form-data with field "file" (recommended).',
          json: 'POST application/json with {"file": "<base64>", "filename": "addon.mcaddon"} (for bots).',
        },
        limits: { maxSize: "30 MB" },
        exampleCurl: `curl -X POST ${base}/api/addon-converter -F "file=@addon.mcaddon" --output converted.mcaddon`,
        docs: "/api-docs/",
      };

  return jsonResponse(docs, 200, cors);
}

// ------------------------------------------------------------
// POST /api/addon-converter -> conversion
// ------------------------------------------------------------
export async function onRequestPost(context: { request: Request }) {
  const request = context.request;
  const cors = corsHeaders(request);

  // Early 413 when Content-Length is present
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_FILE_SIZE) {
    return errorResponse("TOO_LARGE", cors);
  }

  let fileBuffer: ArrayBuffer | null = null;
  let originalFilename = "converted.mcaddon";

  const contentType = request.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      // Compat: "file", "pack", "addon", or first File found
      let fileEntry: FormDataEntryValue | null =
        formData.get("file") ?? formData.get("pack") ?? formData.get("addon") ?? null;
      if (!fileEntry) {
        for (const v of formData.values()) {
          if (typeof v !== "string" && v instanceof File) {
            fileEntry = v;
            break;
          }
        }
      }
      if (!fileEntry || typeof fileEntry === "string") {
        return errorResponse("MISSING_FILE", cors);
      }
      const file = fileEntry as unknown as File;
      originalFilename = file.name || originalFilename;
      const buf = await file.arrayBuffer();
      if (buf.byteLength === 0) {
        return errorResponse("EMPTY_FILE", cors);
      }
      if (buf.byteLength > MAX_FILE_SIZE) {
        return errorResponse("TOO_LARGE", cors);
      }
      fileBuffer = buf;
    } else if (contentType.includes("application/json")) {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return errorResponse("INVALID_JSON", cors);
      }
      // Compat: file / data / base64 + filename / name / fileName
      const b64 = body.file ?? body.data ?? body.base64 ?? null;
      const filename = body.filename ?? body.name ?? body.fileName ?? null;
      if (!b64 || typeof b64 !== "string") {
        return errorResponse("MISSING_FILE", cors);
      }
      if (filename && typeof filename === "string") originalFilename = filename;
      // data URI support
      const cleanB64 = b64.includes(",") && b64.startsWith("data:") ? b64.split(",")[1] : b64;
      let binary: Uint8Array;
      try {
        binary = Uint8Array.from(atob(cleanB64), (c) => c.charCodeAt(0));
      } catch {
        return errorResponse("INVALID_BASE64", cors);
      }
      if (binary.byteLength === 0) {
        return errorResponse("EMPTY_FILE", cors);
      }
      if (binary.byteLength > MAX_FILE_SIZE) {
        return errorResponse("TOO_LARGE", cors);
      }
      fileBuffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
    } else {
      // Raw body: application/zip, application/octet-stream, or no content-type
      // Compat: ?filename / ?name / ?file + Content-Disposition
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

      const buf = await request.arrayBuffer();
      if (!buf || buf.byteLength === 0) {
        return errorResponse("MISSING_FILE", cors);
      }
      if (buf.byteLength > MAX_FILE_SIZE) {
        return errorResponse("TOO_LARGE", cors);
      }
      fileBuffer = buf;
    }
  } catch (e: any) {
    return errorResponse("MISSING_FILE", cors);
  }

  // Extension check (warning only, never blocks)
  const lowerName = originalFilename.toLowerCase();
  const hasAllowedExt = ALLOWED_EXTS.some((ext) => lowerName.endsWith(ext));
  void hasAllowedExt;

  // Processing
  let output: Uint8Array;
  let wasModified: boolean = false;
  try {
    const input = new Uint8Array(fileBuffer!);
    output = await processPack(input);

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
      wasModified = true;
    }
  } catch {
    return errorResponse("INVALID_ZIP", cors);
  }

  // Output name: base_MODIFIED.ext
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

  if (!wasModified) {
    headers["X-Addon-Warning"] = prefersSpanish(request)
      ? "Sin pack de comportamiento, archivo devuelto sin cambios"
      : "No behavior pack found, file returned as-is";
  }

  return new Response(output! as unknown as BodyInit, {
    status: 200,
    headers,
  });
}

// ------------------------------------------------------------
// OPTIONS -> CORS preflight (needed for browsers)
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
// Fallback for unsupported verbs -> 405
// ------------------------------------------------------------
export async function onRequest(context: { request: Request }) {
  const cors = corsHeaders(context.request);
  const method = context.request.method.toUpperCase();
  if (method === "GET" || method === "POST" || method === "OPTIONS") {
    if (method === "GET") return onRequestGet(context);
    if (method === "POST") return onRequestPost(context);
    if (method === "OPTIONS") return onRequestOptions(context);
  }
  return errorResponse("METHOD_NOT_ALLOWED", cors, method, { Allow: "GET, POST, OPTIONS" });
}
