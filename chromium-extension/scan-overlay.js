(() => {
  if (window.__vdlScanOverlayInstalled) return;
  window.__vdlScanOverlayInstalled = true;

  const STATE = {
    active: false,
    map: new Map(),
    pageButton: null,
    observer: null,
    intervalId: null,
    rafPending: false,
    boundUpdate: null,
  };

  const BTN_CLASS = "vdl-scan-overlay-btn";
  const PAGE_BTN_CLASS = "vdl-scan-overlay-page-btn";
  const TOAST_CLASS = "vdl-scan-overlay-toast";

  function isHttpUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
  }

  function mediaUrl(media) {
    return media.currentSrc || media.src || null;
  }

  function mediaMime(media) {
    if (media.tagName.toLowerCase() === "video") return "video/*";
    if (media.tagName.toLowerCase() === "audio") return "audio/*";
    return null;
  }

  function hasRuntimeContext() {
    try {
      return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function safeRuntimeGetURL(path) {
    if (!hasRuntimeContext()) return null;
    try {
      return chrome.runtime.getURL(path);
    } catch {
      return null;
    }
  }

  function safeSendMessage(message, callback) {
    if (!hasRuntimeContext()) {
      if (typeof callback === "function") callback();
      return false;
    }
    try {
      chrome.runtime.sendMessage(message, (...args) => {
        if (typeof callback === "function") {
          callback(...args);
        }
      });
      return true;
    } catch {
      if (typeof callback === "function") callback();
      return false;
    }
  }

  function disableForInvalidatedContext() {
    STATE.active = false;
    if (STATE.observer) {
      STATE.observer.disconnect();
      STATE.observer = null;
    }
    if (STATE.intervalId) {
      clearInterval(STATE.intervalId);
      STATE.intervalId = null;
    }
    if (STATE.boundUpdate) {
      window.removeEventListener("scroll", STATE.boundUpdate, true);
      window.removeEventListener("resize", STATE.boundUpdate, true);
      window.removeEventListener("visibilitychange", STATE.boundUpdate, true);
      STATE.boundUpdate = null;
    }
    removeAllButtons();
  }

  function inferCaptureFilename() {
    const hash = typeof location.hash === "string" ? location.hash : "";
    const v2Index = hash.indexOf("v2,");
    if (v2Index >= 0) {
      const payload = hash.slice(v2Index + 3).split(",");
      const slug = payload[1] || "";
      if (slug) {
        return slug.replace(/-/g, " ").trim();
      }
    }

    const title = (document.title || "").trim();
    if (!title) return null;

    return title
      .split(/\s+[|\-]\s+/)
      .map((part) => part.trim())
      .find(Boolean) || title;
  }

  function collectMediaElementsFromRoot(root, out) {
    if (!root) return;
    const mediaNodes = root.querySelectorAll ? root.querySelectorAll("video, audio") : [];
    mediaNodes.forEach((node) => out.push(node));

    const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
    allEls.forEach((el) => {
      if (el && el.shadowRoot) {
        collectMediaElementsFromRoot(el.shadowRoot, out);
      }
    });
  }

  function showToast(text) {
    const existing = document.querySelector(`.${TOAST_CLASS}`);
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = TOAST_CLASS;
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      background: "rgba(16,16,16,0.92)",
      color: "#fff",
      border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "10px",
      padding: "8px 10px",
      fontSize: "12px",
      fontFamily: "Segoe UI, Arial, sans-serif",
      boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
    });
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  function removeAllButtons() {
    for (const btn of STATE.map.values()) btn.remove();
    STATE.map.clear();
    if (STATE.pageButton) {
      STATE.pageButton.remove();
      STATE.pageButton = null;
    }
  }

  function updateButtonPositions() {
    STATE.rafPending = false;
    if (!STATE.active) return;

    for (const [media, btn] of STATE.map.entries()) {
      if (!media.isConnected) {
        btn.remove();
        STATE.map.delete(media);
        continue;
      }
      const rect = media.getBoundingClientRect();
      const visible = rect.width >= 120 && rect.height >= 80 && rect.bottom > 0 && rect.right > 0;
      if (!visible) {
        btn.style.display = "none";
        continue;
      }

      btn.style.display = "inline-flex";
      const top = Math.max(8, rect.top + 8);
      const left = Math.max(8, rect.right - 36);
      btn.style.top = `${top}px`;
      btn.style.left = `${left}px`;
    }
  }

  function schedulePositionUpdate() {
    if (STATE.rafPending) return;
    STATE.rafPending = true;
    requestAnimationFrame(updateButtonPositions);
  }

  function createButtonForMedia(media) {
    if (STATE.map.has(media)) return;
    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.title = "Download with VelocityDL";
    const logo = document.createElement("img");
    const logoUrl = safeRuntimeGetURL("icons/icon-32.png");
    if (!logoUrl) {
      return;
    }
    logo.src = logoUrl;
    logo.alt = "VelocityDL";
    Object.assign(logo.style, {
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "15px",
      height: "15px",
      display: "block",
      objectFit: "contain",
      objectPosition: "center center",
      maxWidth: "15px",
      maxHeight: "15px",
      margin: "0",
      padding: "0",
      border: "0",
      verticalAlign: "middle",
      pointerEvents: "none",
    });
    btn.appendChild(logo);
    Object.assign(btn.style, {
      position: "fixed",
      width: "28px",
      height: "28px",
      borderRadius: "999px",
      border: "1px solid rgba(255,255,255,0.35)",
      background: "rgba(0,0,0,0.75)",
      color: "#fff",
      fontSize: "11px",
      fontWeight: "700",
      cursor: "pointer",
      zIndex: "2147483646",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      padding: "0",
      lineHeight: "0",
      boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
      backdropFilter: "blur(2px)",
      overflow: "hidden",
    });

    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(0,0,0,0.9)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(0,0,0,0.75)";
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const directUrl = mediaUrl(media);
      const url = isHttpUrl(directUrl) ? directUrl : location.href;
      const sent = safeSendMessage(
        {
          type: "vdl_capture_from_page",
          source: "chromium-scan-overlay",
          url,
          rawMediaUrl: directUrl || null,
          referrer: location.href,
          filename: inferCaptureFilename(),
          mime: mediaMime(media),
        },
        (resp) => {
          if (!hasRuntimeContext()) {
            disableForInvalidatedContext();
            return;
          }
          if (chrome.runtime.lastError || !resp?.ok) {
            showToast("Capture failed");
          } else {
            showToast("Sent to VelocityDL");
          }
        }
      );
      if (!sent) {
        disableForInvalidatedContext();
      }
    });

    document.documentElement.appendChild(btn);
    STATE.map.set(media, btn);
    schedulePositionUpdate();
  }

  function ensurePageCaptureButton() {
    if (STATE.pageButton?.isConnected) return;

    const btn = document.createElement("button");
    btn.className = PAGE_BTN_CLASS;
    btn.type = "button";
    btn.textContent = "Capture Page Video";
    btn.title = "Capture the currently playing media from this page";
    Object.assign(btn.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483646",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px",
      borderRadius: "999px",
      border: "1px solid rgba(255,255,255,0.28)",
      background: "rgba(0,0,0,0.78)",
      color: "#fff",
      padding: "8px 12px",
      fontSize: "12px",
      fontWeight: "600",
      fontFamily: "Segoe UI, Arial, sans-serif",
      cursor: "pointer",
      boxShadow: "0 6px 18px rgba(0,0,0,0.32)",
      backdropFilter: "blur(2px)",
    });

    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(0,0,0,0.9)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(0,0,0,0.78)";
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sent = safeSendMessage(
        {
          type: "vdl_capture_from_page",
          source: "chromium-scan-overlay",
          url: location.href,
          rawMediaUrl: null,
          referrer: location.href,
          filename: inferCaptureFilename(),
          mime: null,
        },
        (resp) => {
          if (!hasRuntimeContext()) {
            disableForInvalidatedContext();
            return;
          }
          if (chrome.runtime.lastError || !resp?.ok) {
            showToast("Capture failed");
          } else {
            showToast("Sent to VelocityDL");
          }
        }
      );
      if (!sent) {
        disableForInvalidatedContext();
      }
    });

    document.documentElement.appendChild(btn);
    STATE.pageButton = btn;
  }

  function scanMediaElements() {
    if (!STATE.active) return;
    const mediaNodes = [];
    collectMediaElementsFromRoot(document, mediaNodes);
    mediaNodes.forEach((media) => {
      createButtonForMedia(media);
    });
    ensurePageCaptureButton();
    if (STATE.pageButton) {
      STATE.pageButton.style.opacity = mediaNodes.length ? "0.72" : "1";
    }
    schedulePositionUpdate();
  }

  function start() {
    if (STATE.active) return;
    STATE.active = true;
    scanMediaElements();

    STATE.observer = new MutationObserver(() => scanMediaElements());
    STATE.observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    STATE.intervalId = window.setInterval(scanMediaElements, 1200);

    STATE.boundUpdate = schedulePositionUpdate;
    window.addEventListener("scroll", STATE.boundUpdate, true);
    window.addEventListener("resize", STATE.boundUpdate, true);
    window.addEventListener("visibilitychange", STATE.boundUpdate, true);
    showToast("VelocityDL scan ON");
  }

  function stop() {
    if (!STATE.active) return;
    STATE.active = false;
    if (STATE.observer) {
      STATE.observer.disconnect();
      STATE.observer = null;
    }
    if (STATE.intervalId) {
      clearInterval(STATE.intervalId);
      STATE.intervalId = null;
    }
    if (STATE.boundUpdate) {
      window.removeEventListener("scroll", STATE.boundUpdate, true);
      window.removeEventListener("resize", STATE.boundUpdate, true);
      window.removeEventListener("visibilitychange", STATE.boundUpdate, true);
      STATE.boundUpdate = null;
    }
    removeAllButtons();
    showToast("VelocityDL scan OFF");
  }

  function toggle() {
    if (STATE.active) stop();
    else start();
  }

  function setActive(active) {
    if (active) start();
    else stop();
  }

  // Expose a toggle hook for all-frame script execution.
  window.__vdlToggleScanOverlay = toggle;
  window.__vdlSetScanOverlayActive = setActive;

  if (hasRuntimeContext()) {
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === "vdl_toggle_scan") {
          toggle();
          return;
        }
        if (message?.type === "vdl_scan_set_active") {
          setActive(!!message.active);
        }
      });
    } catch {
      disableForInvalidatedContext();
    }

    safeSendMessage({ type: "vdl_scan_overlay_get_state" }, (response) => {
      if (!hasRuntimeContext()) {
        disableForInvalidatedContext();
        return;
      }
      if (chrome.runtime.lastError) return;
      if (response?.active) {
        start();
      }
    });
  }
})();
