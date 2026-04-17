const NATIVE_HOST = "com.velocitydl.native_host";

const DEFAULT_SETTINGS = {
  takeoverAllDownloads: true,
  showContextMenu: true,
  autoOpenQualityPickerOnScanCapture: true,
};
let menuRebuildQueue = Promise.resolve();
const WEBREQUEST_CAPTURE_DEDUPE_WINDOW_MS = 90_000;
const recentWebRequestCaptures = new Map();
const RECENT_PLAYABLE_BY_TAB_WINDOW_MS = 30 * 60_000;
const recentPlayableByTab = new Map();
const ACTIVE_SCAN_TABS_KEY = "activeScanTabs";
const LAST_SCAN_DEBUG_KEY = "lastScanDebug";
const pendingBrowserDownloads = new Map();
const DOWNLOADABLE_FILE_EXT_RE =
  /\.(exe|msi|msix|msixbundle|appx|appxbundle|zip|rar|7z|tar|gz|bz2|xz|iso|img|dmg|pkg|deb|rpm|apk|ipa|jar|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|json|xml|txt|rtf|epub)(?:$|[?#])/i;

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function parseUrlParts(url) {
  try {
    const parsed = new URL(url);
    return {
      href: parsed.href,
      host: parsed.hostname.toLowerCase(),
      path: parsed.pathname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

async function getActiveScanTabs() {
  const data = await chrome.storage.session.get(ACTIVE_SCAN_TABS_KEY);
  const raw = data?.[ACTIVE_SCAN_TABS_KEY];
  return Array.isArray(raw) ? raw.filter((id) => Number.isInteger(id) && id >= 0) : [];
}

async function isScanActiveForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  const activeTabs = await getActiveScanTabs();
  return activeTabs.includes(tabId);
}

async function setScanActiveForTab(tabId, active) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const activeTabs = new Set(await getActiveScanTabs());
  if (active) activeTabs.add(tabId);
  else activeTabs.delete(tabId);
  await chrome.storage.session.set({ [ACTIVE_SCAN_TABS_KEY]: [...activeTabs] });
}

async function applyScanStateToTab(tabId, active, frameId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const frameIds = Number.isInteger(frameId) && frameId >= 0
    ? [frameId]
    : await chrome.webNavigation
        .getAllFrames({ tabId })
        .then((frames) =>
          Array.isArray(frames) && frames.length
            ? frames.map((frame) => frame.frameId)
            : [0]
        )
        .catch(() => [0]);

  await Promise.all(
    frameIds.map(async (targetFrameId) => {
      try {
        await chrome.tabs.sendMessage(
          tabId,
          { type: "vdl_scan_set_active", active: !!active },
          { frameId: targetFrameId }
        );
      } catch (err) {
        const msg = String(err?.message || err || "");
        if (!msg.includes("Receiving end does not exist")) {
          console.warn("[VelocityDL] Failed to apply scan state:", err);
        }
      }
    })
  );
}

async function clearScanStateOnTab(tabId) {
  try {
    await applyScanStateToTab(tabId, false);
  } finally {
    await setScanActiveForTab(tabId, false);
  }
}

async function initializeActiveScanTabs() {
  const activeTabs = await getActiveScanTabs();
  if (!activeTabs.length) return;
  await Promise.all(
    activeTabs.map(async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
          await clearScanStateOnTab(tabId);
        }
      } catch {
        await clearScanStateOnTab(tabId);
      }
    })
  );
}

async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...data };
}

function removeAllContextMenus() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });
}

function createContextMenu(item) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(item, () => {
      // Ignore duplicate/no-op create races during worker wakeups.
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";
        if (!msg.includes("duplicate id")) {
          console.warn("[VelocityDL] context menu create error:", msg);
        }
      }
      resolve();
    });
  });
}

function removeContextMenu(id) {
  return new Promise((resolve) => {
    chrome.contextMenus.remove(id, () => {
      // It's fine if the item does not exist yet.
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";
        if (!msg.includes("Cannot find menu item")) {
          console.warn("[VelocityDL] context menu remove error:", msg);
        }
      }
      resolve();
    });
  });
}

async function rebuildContextMenus(enabled) {
  await removeAllContextMenus();
  if (!enabled) return;

  // Extra safety for Chromium forks: remove by id before create.
  await removeContextMenu("vdl-download-link");
  await removeContextMenu("vdl-download-page");
  await removeContextMenu("vdl-download-media");

  await createContextMenu({
    id: "vdl-download-link",
    title: "Download with VelocityDL",
    contexts: ["link"],
  });
  await createContextMenu({
    id: "vdl-download-page",
    title: "Download Page URL with VelocityDL",
    contexts: ["page"],
  });
  await createContextMenu({
    id: "vdl-download-media",
    title: "Download Media with VelocityDL",
    contexts: ["video", "audio"],
  });
}

function queueRebuildContextMenus(enabled) {
  menuRebuildQueue = menuRebuildQueue
    .then(() => rebuildContextMenus(enabled))
    .catch((err) => console.warn("[VelocityDL] context menu rebuild failed:", err));
}

function shouldHandleUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (url.startsWith("https://chrome.google.com/webstore")) return false;
  return true;
}

function isLikelyDirectMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  const parts = parseUrlParts(url);
  if (!parts) return false;
  return /\.(mp4|mkv|webm|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd|ts|m4s|weba)$/i.test(
    parts.path
  );
}

function isLikelyDownloadableFileUrl(url) {
  if (!url || typeof url !== "string") return false;
  const parts = parseUrlParts(url);
  if (!parts) return false;
  return DOWNLOADABLE_FILE_EXT_RE.test(parts.path);
}

function filenameLooksDownloadable(filename) {
  return typeof filename === "string" && DOWNLOADABLE_FILE_EXT_RE.test(filename.trim());
}

function isLikelySegmentUrl(url) {
  if (!url || typeof url !== "string") return false;
  return (
    /\.(m4s|ts|cmfv|cmfa|fmp4)(?:$|[?#])/i.test(url) ||
    /(?:^|[/?&])(chunk|segment|frag|fragment|sq|range)=/i.test(url)
  );
}

function isLikelyManifestUrl(url) {
  if (!url || typeof url !== "string") return false;
  const parts = parseUrlParts(url);
  if (!parts) return false;
  return /\.(m3u8|mpd)$/i.test(parts.path);
}

function isConcretePlayableUrl(url) {
  if (!shouldHandleUrl(url)) return false;
  const parts = parseUrlParts(url);
  if (!parts) return false;
  return (
    isLikelyManifestUrl(url) ||
    isLikelyDirectMediaUrl(url) ||
    (parts.host === "hanime-cdn.com" &&
      /\.(m3u8|mpd|mp4|webm|m4s|ts)$/i.test(parts.path)) ||
    (parts.host.includes("googlevideo.com") && /videoplayback/i.test(parts.href)) ||
    (parts.host.includes("cloudfront.net") &&
      /\.(m3u8|mpd|mp4|webm|m4s|ts)$/i.test(parts.path)) ||
    /(?:manifest|master\.m3u8|playlist\.m3u8)/i.test(parts.path)
  );
}

function isLikelyEmbedPageUrl(url) {
  if (!shouldHandleUrl(url)) return false;
  const parts = parseUrlParts(url);
  if (!parts) return false;
  return (
    /\/(?:embed|player|watch|video|videos|e)\//i.test(parts.path) ||
    /(?:vidara\.so)$/i.test(parts.host)
  );
}

function isInterestingMediaMime(mime) {
  if (!mime || typeof mime !== "string") return false;
  return (
    /^video\//i.test(mime) ||
    /^audio\//i.test(mime) ||
    /application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)/i.test(mime)
  );
}

function normalizeForWebRequestDedupe(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function shouldCaptureByUrl(url) {
  if (!shouldHandleUrl(url)) return false;
  if (isLikelySegmentUrl(url)) return false;
  return (
    isLikelyManifestUrl(url) ||
    /\.(mp4|mkv|webm|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|weba)(?:$|[?#])/i.test(url) ||
    /(?:googlevideo\.com\/videoplayback|manifest|master\.m3u8|playlist\.m3u8)/i.test(url)
  );
}

function shouldCaptureWebRequest(url, mime) {
  if (!shouldHandleUrl(url)) return false;
  if (isLikelySegmentUrl(url)) return false;
  if (shouldCaptureByUrl(url)) return true;
  return isInterestingMediaMime(mime || "");
}

function isLikelyJunkPlayableUrl(url) {
  if (!url || typeof url !== "string") return true;
  if (
    /(?:black[_-]?screen|teaser|trailer|promo|preview|sample|thumbnail|thumb|poster|sprite|ad[s]?)/i.test(
      url
    )
  ) {
    return true;
  }
  const shortDuration = /(?:^|[_-])(\d{1,2})s(?:[_\-.]|$)/i.exec(url);
  if (shortDuration && Number(shortDuration[1]) <= 8) {
    return true;
  }
  return false;
}

function scorePlayableCandidate(url, mime) {
  let score = 0;
  if (isLikelyManifestUrl(url)) score += 140;
  if (isLikelyDirectMediaUrl(url)) score += 45;
  if (/^video\//i.test(mime || "")) score += 35;
  if (/^audio\//i.test(mime || "")) score += 15;
  if (/(?:master|playlist|manifest|index)\.(?:m3u8|mpd)(?:$|[?#])/i.test(url)) score += 40;
  if (/\.mp4(?:$|[?#])/i.test(url)) score += 10;
  if (isLikelyJunkPlayableUrl(url)) score -= 300;
  return score;
}

function pruneWebRequestCaptureDedupe(now) {
  for (const [key, ts] of recentWebRequestCaptures.entries()) {
    if (now - ts > WEBREQUEST_CAPTURE_DEDUPE_WINDOW_MS) {
      recentWebRequestCaptures.delete(key);
    }
  }
}

function markWebRequestCaptured(url) {
  const now = Date.now();
  pruneWebRequestCaptureDedupe(now);
  const dedupeKey = normalizeForWebRequestDedupe(url);
  const seen = recentWebRequestCaptures.get(dedupeKey);
  if (seen && now - seen < WEBREQUEST_CAPTURE_DEDUPE_WINDOW_MS) {
    return false;
  }
  recentWebRequestCaptures.set(dedupeKey, now);
  return true;
}

function extractContentTypeHeader(headers) {
  if (!Array.isArray(headers)) return "";
  const match = headers.find((h) => String(h?.name || "").toLowerCase() === "content-type");
  return String(match?.value || "").split(";")[0].trim().toLowerCase();
}

function buildWebRequestHeaders(details) {
  const ref = details?.initiator || details?.documentUrl || "";
  if (shouldHandleUrl(ref)) {
    return { Referer: ref };
  }
  return null;
}

function rememberPlayableForTab(details, url, mime) {
  const tabId = details?.tabId;
  if (typeof tabId !== "number" || tabId < 0) return;
  if (isLikelySegmentUrl(url)) return;

  const now = Date.now();
  const score = scorePlayableCandidate(url, mime || "");
  if (score <= 0) return;

  const key = normalizeForWebRequestDedupe(url);
  const existing = recentPlayableByTab.get(tabId) || [];
  const next = existing
    .filter((entry) => now - entry.at <= RECENT_PLAYABLE_BY_TAB_WINDOW_MS && entry.key !== key)
    .concat([
      {
        key,
        url,
        at: now,
        score,
        mime: mime || "",
        initiator: details?.initiator || "",
        documentUrl: details?.documentUrl || "",
        origin: safeOrigin(url),
      },
    ])
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.at - a.at;
    })
    .slice(0, 12);
  recentPlayableByTab.set(tabId, next);
}

function recentPlayableForTab(tabId, preferredReferrer) {
  const fresh = rankedPlayableEntriesForTab(tabId, preferredReferrer);
  if (!fresh.length) return null;
  recentPlayableByTab.set(tabId, fresh.slice(0, 12));
  return fresh[0].url;
}

function rankedPlayableEntriesForTab(tabId, preferredReferrer) {
  if (typeof tabId !== "number" || tabId < 0) return null;
  const entries = recentPlayableByTab.get(tabId);
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const now = Date.now();
  const preferredOrigin = safeOrigin(preferredReferrer || "");
  const fresh = entries
    .filter((entry) => now - entry.at <= RECENT_PLAYABLE_BY_TAB_WINDOW_MS)
    .sort((a, b) => {
      const aFrameBonus =
        preferredReferrer && (a.documentUrl === preferredReferrer || a.initiator === preferredOrigin)
          ? 120
          : preferredOrigin && a.origin === preferredOrigin
            ? 60
            : 0;
      const bFrameBonus =
        preferredReferrer && (b.documentUrl === preferredReferrer || b.initiator === preferredOrigin)
          ? 120
          : preferredOrigin && b.origin === preferredOrigin
            ? 60
            : 0;
      const aEffective = a.score + aFrameBonus;
      const bEffective = b.score + bFrameBonus;
      if (bEffective !== aEffective) return bEffective - aEffective;
      return b.at - a.at;
    });
  if (!fresh.length) {
    recentPlayableByTab.delete(tabId);
    return [];
  }
  return fresh;
}

async function setLastScanDebug(debugInfo) {
  await chrome.storage.session.set({ [LAST_SCAN_DEBUG_KEY]: debugInfo });
}

function sendWebRequestCapture(details, mime) {
  const url = details?.url || "";
  if (!shouldCaptureWebRequest(url, mime)) return;
  if (!markWebRequestCaptured(url)) return;
  rememberPlayableForTab(details, url, mime || "");
}

function classifyCapture(payload) {
  const url = payload?.url || "";
  const rawMediaUrl = payload?.raw_media_url || payload?.rawMediaUrl || "";
  const mime = payload?.mime || "";

  if (/^blob:/i.test(rawMediaUrl) || /^blob:/i.test(url)) {
    return "blob_backed_media";
  }

  if (
    payload?.source === "chromium-context-media" ||
    payload?.source === "chromium-downloads-api" ||
    /^video\//i.test(mime) ||
    /^audio\//i.test(mime) ||
    /^application\/octet-stream$/i.test(mime) ||
    isLikelyDirectMediaUrl(url) ||
    isLikelyDownloadableFileUrl(url)
  ) {
    return "direct_media_url";
  }

  return "page_url";
}

async function sendCapture(payload) {
  try {
    const capture_type = payload.capture_type || classifyCapture(payload);
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      action: "capture",
      capture_type,
      ...payload,
    });
    if (!response?.ok) {
      console.warn("[VelocityDL] Native host returned error:", response?.message);
    }
  } catch (err) {
    console.warn("[VelocityDL] Native host communication failed:", err);
  }
}

async function pingNativeHost() {
  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      action: "ping",
    });
    if (response?.ok === true) {
      return { ok: true, message: "connected" };
    }
    return { ok: false, message: response?.message || "native host error" };
  } catch (err) {
    return { ok: false, message: String(err?.message || err || "native host unavailable") };
  }
}

async function toggleScanOnTab(tab) {
  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    return { ok: false, message: "Open a normal web page first." };
  }

  try {
    const nextActive = !(await isScanActiveForTab(tab.id));
    await setScanActiveForTab(tab.id, nextActive);
    await applyScanStateToTab(tab.id, nextActive);
    return { ok: true, active: nextActive };
  } catch (err) {
    console.warn("[VelocityDL] Failed to toggle scan overlay:", err);
    return { ok: false, message: "Failed to toggle scan overlay." };
  }
}

async function handleBrowserDownload(item) {
  const settings = await getSettings();
  if (!settings.takeoverAllDownloads) return;
  if (!shouldHandleUrl(item.url)) return;

  pendingBrowserDownloads.set(item.id, {
    id: item.id,
    createdAt: Date.now(),
    attempts: 0,
    url: item.finalUrl || item.url,
    originalUrl: item.url,
    filename: item.filename || null,
    mime: item.mime || null,
  });

  setTimeout(() => {
    flushPendingBrowserDownload(item.id);
  }, 700);
}

async function flushPendingBrowserDownload(id) {
  const pending = pendingBrowserDownloads.get(id);
  if (!pending) return;

  const candidateUrl = pending.url || pending.originalUrl || "";
  const hasGoodDirectUrl =
    isLikelyDirectMediaUrl(candidateUrl) ||
    isLikelyDownloadableFileUrl(candidateUrl);
  const hasStrongFilenameSignal = filenameLooksDownloadable(pending.filename || "");

  if (!hasGoodDirectUrl && hasStrongFilenameSignal && pending.attempts < 8) {
    pending.attempts += 1;
    setTimeout(() => {
      flushPendingBrowserDownload(id);
    }, 400);
    return;
  }

  pendingBrowserDownloads.delete(id);

  if (!hasGoodDirectUrl) {
    return;
  }

  await sendCapture({
    url: candidateUrl,
    filename: pending.filename || null,
    mime: pending.mime || null,
    source: "chromium-downloads-api",
    headers: null,
  });

  try {
    await chrome.downloads.cancel(id);
    await chrome.downloads.erase({ id });
  } catch (e) {
    // Some downloads cannot be cancelled quickly enough; ignore gracefully.
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set(settings);
  await chrome.storage.session.set({ [ACTIVE_SCAN_TABS_KEY]: [] });
  queueRebuildContextMenus(settings.showContextMenu);
});
chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await initializeActiveScanTabs();
  queueRebuildContextMenus(settings.showContextMenu);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearScanStateOnTab(tabId);
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details?.tabId < 0 || !/^https?:\/\//i.test(details?.url || "")) return;
  if (details.frameId === 0) {
    recentPlayableByTab.delete(details.tabId);
  }
  if (!(await isScanActiveForTab(details.tabId))) return;
  await applyScanStateToTab(details.tabId, true, details.frameId);
});

chrome.downloads.onCreated.addListener((item) => {
  handleBrowserDownload(item);
});

chrome.downloads.onChanged.addListener((delta) => {
  const pending = pendingBrowserDownloads.get(delta.id);
  if (!pending) return;

  if (delta.finalUrl?.current && shouldHandleUrl(delta.finalUrl.current)) {
    pending.url = delta.finalUrl.current;
  }
  if (delta.filename?.current) {
    const leaf = delta.filename.current.split(/[\\/]/).pop();
    if (leaf) {
      pending.filename = leaf;
    }
  }

  if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
    flushPendingBrowserDownload(delta.id);
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details?.tabId === -1) return;
    sendWebRequestCapture(details, "");
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details?.tabId === -1) return;
    const mime = extractContentTypeHeader(details.responseHeaders);
    if (!isInterestingMediaMime(mime)) return;
    sendWebRequestCapture(details, mime);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "vdl-download-link" && shouldHandleUrl(info.linkUrl)) {
    await sendCapture({
      url: info.linkUrl,
      referrer: info.pageUrl || null,
      source: "chromium-context-link",
      headers: info.pageUrl ? { Referer: info.pageUrl } : null,
    });
    return;
  }

  if (info.menuItemId === "vdl-download-page" && tab?.url && shouldHandleUrl(tab.url)) {
    await sendCapture({
      url: tab.url,
      source: "chromium-context-page",
      headers: tab.url ? { Referer: tab.url } : null,
    });
    return;
  }

  if (info.menuItemId === "vdl-download-media" && shouldHandleUrl(info.srcUrl)) {
    await sendCapture({
      url: info.srcUrl,
      referrer: info.pageUrl || null,
      source: "chromium-context-media",
      headers: info.pageUrl ? { Referer: info.pageUrl } : null,
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, "showContextMenu")) {
    queueRebuildContextMenus(!!changes.showContextMenu.newValue);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  await toggleScanOnTab(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "vdl_popup_get_state") {
    (async () => {
      const settings = await getSettings();
      const native = await pingNativeHost();
      const debug = (await chrome.storage.session.get(LAST_SCAN_DEBUG_KEY))?.[LAST_SCAN_DEBUG_KEY] || null;
      sendResponse({ ok: true, settings, native, runtimeId: chrome.runtime.id });
    })();
    return true;
  }

  if (message?.type === "vdl_popup_get_debug") {
    (async () => {
      const debug = (await chrome.storage.session.get(LAST_SCAN_DEBUG_KEY))?.[LAST_SCAN_DEBUG_KEY] || null;
      sendResponse({ ok: true, debug });
    })();
    return true;
  }

  if (message?.type === "vdl_popup_update_settings") {
    (async () => {
      const next = {
        takeoverAllDownloads: !!message.takeoverAllDownloads,
        showContextMenu: !!message.showContextMenu,
        autoOpenQualityPickerOnScanCapture:
          message.autoOpenQualityPickerOnScanCapture !== false,
      };
      await chrome.storage.local.set(next);
      queueRebuildContextMenus(next.showContextMenu);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "vdl_popup_toggle_scan") {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      const result = await toggleScanOnTab(tab);
      sendResponse(result);
    })();
    return true;
  }

  if (message?.type === "vdl_scan_overlay_get_state") {
    (async () => {
      sendResponse({
        ok: true,
        active: await isScanActiveForTab(sender?.tab?.id),
      });
    })();
    return true;
  }

  if (message?.type !== "vdl_capture_from_page") return false;

  (async () => {
    try {
      const senderTabId = sender?.tab?.id;
      const referrer = message.referrer || sender?.tab?.url || null;
      const rawMediaUrl = message.rawMediaUrl || null;
      let resolvedUrl = message.url;
      let resolvedRawMediaUrl = rawMediaUrl;
      const rankedCandidates = rankedPlayableEntriesForTab(senderTabId, referrer).slice(0, 5);

      const directRawMediaUrl =
        typeof rawMediaUrl === "string" && isConcretePlayableUrl(rawMediaUrl) ? rawMediaUrl : null;
      if (directRawMediaUrl) {
        resolvedUrl = directRawMediaUrl;
      } else {
        const canUseRecentPlayable =
          message?.source === "chromium-scan-overlay" &&
          (
            typeof resolvedUrl !== "string" ||
            !/^https?:\/\//i.test(resolvedUrl) ||
            resolvedUrl === referrer ||
            !isConcretePlayableUrl(resolvedUrl)
          );
        if (canUseRecentPlayable) {
          const recentPlayable = rankedCandidates[0]?.url || null;
          if (recentPlayable) {
            resolvedUrl = recentPlayable;
            resolvedRawMediaUrl = recentPlayable;
          }
        }
      }

      await setLastScanDebug({
        at: Date.now(),
        tabId: senderTabId ?? null,
        referrer,
        inputUrl: message.url || null,
        inputRawMediaUrl: rawMediaUrl || null,
        resolvedUrl,
        resolvedRawMediaUrl: resolvedRawMediaUrl || null,
        usedRecentPlayable:
          resolvedUrl !== message.url &&
          typeof resolvedUrl === "string" &&
          resolvedUrl === rankedCandidates[0]?.url,
        topCandidates: rankedCandidates.map((entry) => ({
          url: entry.url,
          score: entry.score,
          initiator: entry.initiator,
          documentUrl: entry.documentUrl,
          mime: entry.mime,
        })),
      });

      const lacksConcretePlayable =
        !isConcretePlayableUrl(resolvedUrl) &&
        !isConcretePlayableUrl(resolvedRawMediaUrl || "");
      const isLikelyBadEmbedFallback =
        message?.source === "chromium-scan-overlay" &&
        lacksConcretePlayable &&
        (
          !resolvedRawMediaUrl ||
          normalizeForWebRequestDedupe(resolvedRawMediaUrl) === normalizeForWebRequestDedupe(referrer || "")
        ) &&
        (
          normalizeForWebRequestDedupe(resolvedUrl) === normalizeForWebRequestDedupe(referrer || "") ||
          isLikelyEmbedPageUrl(resolvedUrl)
        );

      if (isLikelyBadEmbedFallback) {
        sendResponse({
          ok: false,
          message: "No direct video stream detected yet. Start playback, wait a few seconds, then try capture again.",
        });
        return;
      }

      if (!shouldHandleUrl(resolvedUrl)) {
        sendResponse({ ok: false, message: "invalid url" });
        return;
      }

      const payload = {
        url: resolvedUrl,
        filename: message.filename || null,
        mime: message.mime || null,
        raw_media_url: resolvedRawMediaUrl,
        referrer,
        source: "chromium-scan-overlay",
        scan_auto_open_quality_picker:
          (await getSettings()).autoOpenQualityPickerOnScanCapture !== false,
        headers: referrer
          ? {
              Referer: referrer,
              ...(resolvedRawMediaUrl
                ? { "X-VDL-Raw-Media-Url": String(resolvedRawMediaUrl) }
                : {}),
            }
          : (resolvedRawMediaUrl
              ? { "X-VDL-Raw-Media-Url": String(resolvedRawMediaUrl) }
              : null),
      };

      await sendCapture({
        ...payload,
        capture_type: classifyCapture(payload),
      });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, message: String(err) });
    }
  })();

  return true;
});
