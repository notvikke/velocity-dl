const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

const MANAGED_HEADER_NAMES = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const CANONICAL_HEADER_NAMES = new Map([
  ["accept", "Accept"],
  ["accept-language", "Accept-Language"],
  ["authorization", "Authorization"],
  ["cache-control", "Cache-Control"],
  ["content-type", "Content-Type"],
  ["cookie", "Cookie"],
  ["if-match", "If-Match"],
  ["if-modified-since", "If-Modified-Since"],
  ["if-none-match", "If-None-Match"],
  ["origin", "Origin"],
  ["pragma", "Pragma"],
  ["range", "Range"],
  ["referer", "Referer"],
  ["user-agent", "User-Agent"],
]);

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}

function canonicalHeaderName(name) {
  const lower = name.toLowerCase();
  return (
    CANONICAL_HEADER_NAMES.get(lower) ||
    lower
      .split("-")
      .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
      .join("-")
  );
}

function isValidHeader(name, value) {
  return (
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
    !name.startsWith(":") &&
    !/[\r\n\0]/.test(value) &&
    !MANAGED_HEADER_NAMES.has(name.toLowerCase())
  );
}

export function sanitizeRequestHeaders(headers) {
  const result = {};
  const entries = Array.isArray(headers)
    ? headers.map((entry) => [entry?.name, entry?.value])
    : Object.entries(headers || {});

  for (const [rawName, rawValue] of entries) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!name || !isValidHeader(name, value)) continue;
    const canonical = canonicalHeaderName(name);
    if (result[canonical] === undefined) {
      result[canonical] = value;
    } else {
      const separator = canonical === "Cookie" ? "; " : ", ";
      result[canonical] = `${result[canonical]}${separator}${value}`;
    }
  }
  return result;
}

export function serializeRequestBody(requestBody, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  if (!requestBody || typeof requestBody !== "object") return null;

  if (requestBody.formData && typeof requestBody.formData === "object") {
    const params = new URLSearchParams();
    for (const [name, values] of Object.entries(requestBody.formData)) {
      for (const value of Array.isArray(values) ? values : [values]) {
        params.append(name, String(value ?? ""));
      }
    }
    const data = params.toString();
    const byteLength = utf8Bytes(data).length;
    if (byteLength > maxBytes) {
      return { encoding: "unavailable", content_type: "application/x-www-form-urlencoded", data: null, byte_length: byteLength, truncated: true };
    }
    return { encoding: "utf8", content_type: "application/x-www-form-urlencoded", data, byte_length: byteLength, truncated: false };
  }

  if (Array.isArray(requestBody.raw)) {
    const parts = requestBody.raw
      .map((part) => part?.bytes)
      .filter((bytes) => bytes instanceof ArrayBuffer)
      .map((bytes) => new Uint8Array(bytes));
    const byteLength = parts.reduce((sum, bytes) => sum + bytes.length, 0);
    if (!parts.length && requestBody.error) {
      return { encoding: "unavailable", content_type: null, data: null, byte_length: 0, truncated: false };
    }
    if (byteLength > maxBytes) {
      return { encoding: "unavailable", content_type: null, data: null, byte_length: byteLength, truncated: true };
    }
    const joined = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return { encoding: "base64", content_type: null, data: bytesToBase64(joined), byte_length: byteLength, truncated: false };
  }

  return null;
}

export function mergeSessionCookies(headers, cookies) {
  const result = sanitizeRequestHeaders(headers || {});
  const ordered = [...(Array.isArray(cookies) ? cookies : [])]
    .filter((cookie) => typeof cookie?.name === "string" && cookie.name.trim())
    .sort((a, b) => String(b.path || "/").length - String(a.path || "/").length);
  const seenPairs = new Set();
  const pairs = [];
  for (const cookie of ordered) {
    const pair = `${cookie.name.trim()}=${cookie.value ?? ""}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    pairs.push(pair);
  }
  if (pairs.length) result.Cookie = pairs.join("; ");
  return result;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return String(url || "");
  }
}

function cloneContext(context) {
  return context ? structuredClone(context) : null;
}

export class RequestContextStore {
  constructor({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBodyBytes = maxBodyBytes;
    this.contexts = new Map();
  }

  get size() {
    return this.contexts.size;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [requestId, context] of this.contexts) {
      if (context.context_captured_at_ms < cutoff) this.contexts.delete(requestId);
    }
    while (this.contexts.size > this.maxEntries) {
      this.contexts.delete(this.contexts.keys().next().value);
    }
  }

  onBeforeRequest(details) {
    if (!details?.requestId || !/^https?:/i.test(details?.url || "")) return;
    const existing = this.contexts.get(details.requestId);
    const body = serializeRequestBody(details.requestBody, this.maxBodyBytes);
    const now = this.now();
    this.contexts.delete(details.requestId);
    this.contexts.set(details.requestId, {
      request_id: details.requestId,
      request_method: String(details.method || existing?.request_method || "GET").toUpperCase(),
      request_body: body || existing?.request_body || null,
      headers: existing?.headers || {},
      tab_id: Number.isInteger(details.tabId) ? details.tabId : -1,
      frame_id: Number.isInteger(details.frameId) ? details.frameId : -1,
      initiator: details.initiator || existing?.initiator || null,
      document_url: details.documentUrl || existing?.document_url || null,
      original_url: existing?.original_url || details.url,
      url: details.url,
      redirect_chain: existing?.redirect_chain || [],
      context_captured_at_ms: now,
    });
    this.prune();
  }

  onBeforeSendHeaders(details) {
    const context = this.contexts.get(details?.requestId);
    if (!context) return;
    context.headers = sanitizeRequestHeaders(details.requestHeaders);
    const contentType = context.headers["Content-Type"];
    if (contentType && context.request_body && !context.request_body.content_type) {
      context.request_body.content_type = contentType;
    }
    context.context_captured_at_ms = this.now();
  }

  onBeforeRedirect(details) {
    const context = this.contexts.get(details?.requestId);
    if (!context || !/^https?:/i.test(details?.redirectUrl || "")) return;
    context.redirect_chain.push(details.url || context.url);
    context.url = details.redirectUrl;
    context.context_captured_at_ms = this.now();
  }

  onCompleted(details) {
    const context = this.contexts.get(details?.requestId);
    if (!context) return;
    if (details?.url) context.url = details.url;
    context.context_captured_at_ms = this.now();
    this.prune();
  }

  findBest(url, tabId) {
    this.prune();
    const normalized = normalizeUrl(url);
    let best = null;
    let bestScore = -Infinity;
    for (const context of this.contexts.values()) {
      const urls = [context.url, context.original_url, ...(context.redirect_chain || [])].map(normalizeUrl);
      const exact = urls.includes(normalized);
      const sameTab = Number.isInteger(tabId) && tabId >= 0 && context.tab_id === tabId;
      if (!exact && !sameTab) continue;
      const score = (exact ? 1000 : 0) + (sameTab ? 100 : 0) + context.context_captured_at_ms / 1e13;
      if (score > bestScore) {
        best = context;
        bestScore = score;
      }
    }
    return cloneContext(best);
  }
}
