const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_CANDIDATES = 20;

export function classifyMediaUrl(url) {
  if (typeof url !== "string" || !url) return "unknown";
  if (/^blob:/i.test(url)) return "blob";
  let pathname;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (/\.m3u8$/i.test(pathname)) return "hls_manifest";
  if (/\.mpd$/i.test(pathname)) return "dash_manifest";
  if (/\.(?:m4s|cmfv|cmfa|fmp4)$/i.test(pathname)) return "dash_segment";
  if (/\.ts$/i.test(pathname)) return "hls_segment";
  if (/\.(?:mp4|mkv|webm|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|weba)$/i.test(pathname)) {
    return "direct_media";
  }
  return "unknown";
}

function frameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function pushUnique(items, entry, maxCandidates) {
  const without = items.filter((candidate) => candidate.url !== entry.url);
  without.unshift(entry);
  return without.slice(0, maxCandidates);
}

function emptyFrame(now) {
  return { updated_at_ms: now, manifests: [], segments: [], direct: [], blob_urls: [], source_buffer_mimes: [] };
}

export class MediaCandidateStore {
  constructor({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxCandidates = maxCandidates;
    this.frames = new Map();
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, frame] of this.frames) {
      if (frame.updated_at_ms < cutoff) this.frames.delete(key);
    }
  }

  observe(event) {
    const tabId = Number.isInteger(event?.tabId) ? event.tabId : -1;
    const frameId = Number.isInteger(event?.frameId) ? event.frameId : 0;
    if (tabId < 0) return null;
    this.prune();
    const key = frameKey(tabId, frameId);
    const now = this.now();
    const frame = this.frames.get(key) || emptyFrame(now);
    frame.updated_at_ms = now;
    const url = typeof event?.url === "string" ? event.url : "";
    const type = classifyMediaUrl(url);
    const entry = { url, type, kind: event?.kind || "unknown", at: now };

    if (type === "hls_manifest" || type === "dash_manifest") {
      frame.manifests = pushUnique(frame.manifests, entry, this.maxCandidates);
    } else if (type === "hls_segment" || type === "dash_segment") {
      frame.segments = pushUnique(frame.segments, entry, this.maxCandidates);
    } else if (type === "direct_media") {
      frame.direct = pushUnique(frame.direct, entry, this.maxCandidates);
    } else if (type === "blob") {
      frame.blob_urls = [url, ...frame.blob_urls.filter((candidate) => candidate !== url)].slice(0, this.maxCandidates);
    }

    if (typeof event?.mime === "string" && event.mime) {
      frame.source_buffer_mimes = [event.mime, ...frame.source_buffer_mimes.filter((mime) => mime !== event.mime)].slice(0, this.maxCandidates);
    }
    this.frames.set(key, frame);
    return this.snapshot(tabId, frameId);
  }

  snapshot(tabId, frameId = null) {
    this.prune();
    const matching = [];
    for (const [key, frame] of this.frames) {
      if (!key.startsWith(`${tabId}:`)) continue;
      if (frameId !== null && key !== frameKey(tabId, frameId)) continue;
      matching.push(frame);
    }
    if (!matching.length) return null;
    matching.sort((a, b) => b.updated_at_ms - a.updated_at_ms);
    const merge = (field) => {
      const seen = new Set();
      return matching.flatMap((frame) => frame[field]).filter((item) => {
        const key = typeof item === "string" ? item : item.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, this.maxCandidates);
    };
    const manifests = merge("manifests");
    const direct = merge("direct");
    return {
      preferred_url: manifests[0]?.url || direct[0]?.url || null,
      manifests,
      segments: merge("segments"),
      direct,
      blob_urls: merge("blob_urls"),
      source_buffer_mimes: merge("source_buffer_mimes"),
      updated_at_ms: matching[0].updated_at_ms,
    };
  }
}
