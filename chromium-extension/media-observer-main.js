(() => {
  if (window.__vdlMediaObserverMainInstalled) return;
  window.__vdlMediaObserverMainInstalled = true;

  const EVENT_NAME = "velocitydl:media-observed:v1";
  const sourceBufferMimes = new WeakMap();

  function publish(detail) {
    try {
      const url = typeof detail?.url === "string" ? detail.url.slice(0, 16_384) : "";
      if (!url && detail?.kind !== "source_buffer_append") return;
      document.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: {
          kind: String(detail.kind || "unknown").slice(0, 64),
          url,
          method: String(detail.method || "GET").toUpperCase().slice(0, 16),
          mime: typeof detail.mime === "string" ? detail.mime.slice(0, 512) : "",
          byteLength: Number.isFinite(detail.byteLength) ? Math.max(0, detail.byteLength) : null,
          at: Date.now(),
        },
      }));
    } catch {}
  }

  function absoluteUrl(value) {
    try {
      return new URL(String(value || ""), location.href).href;
    } catch {
      return "";
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function velocityDlObservedFetch(input, init) {
      const requestUrl = absoluteUrl(typeof input === "string" || input instanceof URL ? input : input?.url);
      const method = init?.method || input?.method || "GET";
      publish({ kind: "fetch_request", url: requestUrl, method });
      const promise = originalFetch.apply(this, arguments);
      promise.then((response) => publish({
        kind: "fetch_response",
        url: response?.url || requestUrl,
        method,
        mime: response?.headers?.get?.("content-type") || "",
      })).catch(() => {});
      return promise;
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function velocityDlObservedOpen(method, url) {
    this.__vdlRequest = { method: String(method || "GET"), url: absoluteUrl(url) };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function velocityDlObservedSend() {
    const meta = this.__vdlRequest || { method: "GET", url: "" };
    publish({ kind: "xhr_request", ...meta });
    this.addEventListener("load", () => publish({
      kind: "xhr_response",
      url: this.responseURL || meta.url,
      method: meta.method,
      mime: this.getResponseHeader("content-type") || "",
    }), { once: true });
    return xhrSend.apply(this, arguments);
  };

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function velocityDlObservedObjectUrl(object) {
    const url = createObjectURL.apply(this, arguments);
    const isMediaSource = typeof MediaSource !== "undefined" && object instanceof MediaSource;
    publish({
      kind: isMediaSource ? "media_source_object_url" : "object_url",
      url,
      mime: object instanceof Blob ? object.type : "",
      byteLength: object instanceof Blob ? object.size : null,
    });
    return url;
  };

  if (typeof MediaSource !== "undefined") {
    const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function velocityDlObservedSourceBuffer(mime) {
      const buffer = addSourceBuffer.apply(this, arguments);
      sourceBufferMimes.set(buffer, String(mime || ""));
      publish({ kind: "source_buffer_created", url: location.href, mime });
      return buffer;
    };
  }

  if (typeof SourceBuffer !== "undefined") {
    const appendBuffer = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function velocityDlObservedAppendBuffer(data) {
      publish({
        kind: "source_buffer_append",
        url: location.href,
        mime: sourceBufferMimes.get(this) || "",
        byteLength: data?.byteLength,
      });
      return appendBuffer.apply(this, arguments);
    };
  }

  function observeRoot(root) {
    if (!root || root.__vdlMediaRootObserved) return;
    try { Object.defineProperty(root, "__vdlMediaRootObserved", { value: true }); } catch {}
    const scan = () => {
      root.querySelectorAll?.("video[src], audio[src], source[src]").forEach((node) => {
        publish({ kind: "dom_media", url: absoluteUrl(node.currentSrc || node.src), mime: node.type || "" });
      });
    };
    scan();
    new MutationObserver(scan).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "type"] });
  }

  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function velocityDlObservedShadow(init) {
    const root = attachShadow.apply(this, arguments);
    observeRoot(root);
    return root;
  };
  observeRoot(document);

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) publish({ kind: "resource_timing", url: entry.name });
    }).observe({ type: "resource", buffered: true });
  } catch {}
})();
