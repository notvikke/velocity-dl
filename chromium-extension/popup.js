const takeoverToggle = document.getElementById("takeoverToggle");
const menuToggle = document.getElementById("menuToggle");
const scanPickerToggle = document.getElementById("scanPickerToggle");
const scanBtn = document.getElementById("scanBtn");
const copyDebugBtn = document.getElementById("copyDebugBtn");
const nativeState = document.getElementById("nativeState");
const runtimeId = document.getElementById("runtimeId");
const statusEl = document.getElementById("status");
const openOptions = document.getElementById("openOptions");
const debugSummary = document.getElementById("debugSummary");
const debugDetails = document.getElementById("debugDetails");

const state = {
  takeoverAllDownloads: true,
  showContextMenu: true,
  autoOpenQualityPickerOnScanCapture: true,
};

function setToggle(btn, enabled) {
  btn.classList.toggle("on", !!enabled);
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
}

function setStatus(text, kind = "") {
  statusEl.textContent = text || "";
  statusEl.classList.remove("ok", "warn");
  if (kind) statusEl.classList.add(kind);
}

function renderDebug(debug) {
  if (!debug) {
    debugSummary.textContent = "No scan capture recorded yet.";
    debugDetails.textContent = "";
    return;
  }

  const when = new Date(debug.at).toLocaleTimeString();
  debugSummary.textContent = `${when} | resolved: ${debug.resolvedUrl || "none"}`;
  debugDetails.textContent = [
    `inputUrl: ${debug.inputUrl || ""}`,
    `inputRawMediaUrl: ${debug.inputRawMediaUrl || ""}`,
    `referrer: ${debug.referrer || ""}`,
    `resolvedUrl: ${debug.resolvedUrl || ""}`,
    `resolvedRawMediaUrl: ${debug.resolvedRawMediaUrl || ""}`,
    `usedRecentPlayable: ${debug.usedRecentPlayable ? "yes" : "no"}`,
    "",
    "topCandidates:",
    ...(Array.isArray(debug.topCandidates) && debug.topCandidates.length
      ? debug.topCandidates.map(
          (entry, index) =>
            `${index + 1}. score=${entry.score} | mime=${entry.mime || ""}\n   url=${entry.url}\n   initiator=${entry.initiator || ""}\n   documentUrl=${entry.documentUrl || ""}`
        )
      : ["(none)"]),
  ].join("\n");
}

async function buildDiagnosticsText() {
  const stateResp = await chrome.runtime.sendMessage({ type: "vdl_popup_get_state" });
  const debugResp = await chrome.runtime.sendMessage({ type: "vdl_popup_get_debug" });
  return [
    "VelocityDL Extension Diagnostics",
    `runtimeId: ${stateResp?.runtimeId || "unknown"}`,
    `nativeConnected: ${stateResp?.native?.ok ? "yes" : "no"}`,
    `nativeMessage: ${stateResp?.native?.message || ""}`,
    `takeoverAllDownloads: ${!!state.takeoverAllDownloads}`,
    `showContextMenu: ${!!state.showContextMenu}`,
    `autoOpenQualityPickerOnScanCapture: ${!!state.autoOpenQualityPickerOnScanCapture}`,
    "",
    "lastScanDebug:",
    debugResp?.debug
      ? [
          `at: ${new Date(debugResp.debug.at).toISOString()}`,
          `inputUrl: ${debugResp.debug.inputUrl || ""}`,
          `inputRawMediaUrl: ${debugResp.debug.inputRawMediaUrl || ""}`,
          `referrer: ${debugResp.debug.referrer || ""}`,
          `resolvedUrl: ${debugResp.debug.resolvedUrl || ""}`,
          `resolvedRawMediaUrl: ${debugResp.debug.resolvedRawMediaUrl || ""}`,
          `usedRecentPlayable: ${debugResp.debug.usedRecentPlayable ? "yes" : "no"}`,
          "topCandidates:",
          ...(Array.isArray(debugResp.debug.topCandidates) && debugResp.debug.topCandidates.length
            ? debugResp.debug.topCandidates.map(
                (entry, index) =>
                  `${index + 1}. score=${entry.score} | mime=${entry.mime || ""}\n   url=${entry.url}\n   initiator=${entry.initiator || ""}\n   documentUrl=${entry.documentUrl || ""}`
              )
            : ["(none)"]),
        ].join("\n")
      : "(none)",
  ].join("\n");
}

async function loadState() {
  const resp = await chrome.runtime.sendMessage({ type: "vdl_popup_get_state" });
  if (!resp?.ok) {
    nativeState.textContent = "Failed to load extension state";
    nativeState.className = "sub warn";
    return;
  }

  state.takeoverAllDownloads = !!resp.settings?.takeoverAllDownloads;
  state.showContextMenu = !!resp.settings?.showContextMenu;
  state.autoOpenQualityPickerOnScanCapture =
    resp.settings?.autoOpenQualityPickerOnScanCapture !== false;
  setToggle(takeoverToggle, state.takeoverAllDownloads);
  setToggle(menuToggle, state.showContextMenu);
  setToggle(scanPickerToggle, state.autoOpenQualityPickerOnScanCapture);
  runtimeId.textContent = `ID: ${resp.runtimeId || "unknown"}`;

  if (resp.native?.ok) {
    nativeState.textContent = "Native host connected";
    nativeState.className = "sub ok";
  } else {
    nativeState.textContent = `Native host unavailable: ${resp.native?.message || "unknown error"}`;
    nativeState.className = "sub warn";
  }

  const debugResp = await chrome.runtime.sendMessage({ type: "vdl_popup_get_debug" });
  renderDebug(debugResp?.debug || null);
}

async function saveState() {
  const resp = await chrome.runtime.sendMessage({
    type: "vdl_popup_update_settings",
    takeoverAllDownloads: state.takeoverAllDownloads,
    showContextMenu: state.showContextMenu,
    autoOpenQualityPickerOnScanCapture: state.autoOpenQualityPickerOnScanCapture,
  });
  if (!resp?.ok) {
    setStatus("Failed to save settings", "warn");
    return;
  }
  setStatus("Settings saved", "ok");
  setTimeout(() => setStatus(""), 1000);
}

takeoverToggle.addEventListener("click", async () => {
  state.takeoverAllDownloads = !state.takeoverAllDownloads;
  setToggle(takeoverToggle, state.takeoverAllDownloads);
  await saveState();
});

menuToggle.addEventListener("click", async () => {
  state.showContextMenu = !state.showContextMenu;
  setToggle(menuToggle, state.showContextMenu);
  await saveState();
});

scanPickerToggle.addEventListener("click", async () => {
  state.autoOpenQualityPickerOnScanCapture = !state.autoOpenQualityPickerOnScanCapture;
  setToggle(scanPickerToggle, state.autoOpenQualityPickerOnScanCapture);
  await saveState();
});

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  const resp = await chrome.runtime.sendMessage({ type: "vdl_popup_toggle_scan" });
  scanBtn.disabled = false;

  if (!resp?.ok) {
    setStatus(resp?.message || "Scan toggle failed", "warn");
    return;
  }
  setStatus("Scan toggled on current tab", "ok");
  await loadState();
});

copyDebugBtn.addEventListener("click", async () => {
  try {
    const diagnostics = await buildDiagnosticsText();
    await navigator.clipboard.writeText(diagnostics);
    setStatus("Extension diagnostics copied", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Failed to copy diagnostics", "warn");
  }
});

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

loadState().catch(() => {
  setStatus("Unable to initialize popup", "warn");
});
