(() => {
  if (window.__vdlMediaObserverBridgeInstalled) return;
  window.__vdlMediaObserverBridgeInstalled = true;
  const EVENT_NAME = "velocitydl:media-observed:v1";
  const ALLOWED_KINDS = new Set([
    "fetch_request", "fetch_response", "xhr_request", "xhr_response", "object_url",
    "media_source_object_url", "source_buffer_created", "source_buffer_append",
    "dom_media", "resource_timing",
  ]);
  document.addEventListener(EVENT_NAME, (event) => {
    const detail = event?.detail;
    if (!detail || !ALLOWED_KINDS.has(detail.kind)) return;
    const url = typeof detail.url === "string" ? detail.url : "";
    if (url.length > 16_384 || (!/^https?:/i.test(url) && !/^blob:/i.test(url))) return;
    try {
      chrome.runtime.sendMessage({
        type: "vdl_media_observed",
        event: {
          kind: detail.kind,
          url,
          method: typeof detail.method === "string" ? detail.method : "GET",
          mime: typeof detail.mime === "string" ? detail.mime : "",
          byteLength: Number.isFinite(detail.byteLength) ? detail.byteLength : null,
          at: Number.isFinite(detail.at) ? detail.at : Date.now(),
        },
      });
    } catch {}
  }, true);
})();
