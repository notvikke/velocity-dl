import {
  DEFAULT_SCAN_CAPTURE_MODE,
  getScanCaptureModeMeta,
  normalizeScanCaptureMode,
} from "./scan-capture-mode.js";

const defaults = {
  takeoverAllDownloads: true,
  showContextMenu: true,
  scanCaptureMode: DEFAULT_SCAN_CAPTURE_MODE,
};

const settingsSummary = document.getElementById("settingsSummary");
const status = document.getElementById("status");
const scanModeSelect = document.getElementById("scanModeSelect");
const scanModeDescription = document.getElementById("scanModeDescription");
const scanModeStatus = document.getElementById("scanModeStatus");

let currentSettings = { ...defaults };

function renderScanMode(mode, legacySettings = {}) {
  const scanModeMeta = getScanCaptureModeMeta(mode, legacySettings);
  if (scanModeSelect) {
    scanModeSelect.value = scanModeMeta.mode;
  }
  if (scanModeDescription) {
    scanModeDescription.textContent = scanModeMeta.description;
  }
  return scanModeMeta;
}

function renderSettingsSummary(scanModeMeta) {
  settingsSummary.replaceChildren();
  [
    ["Take over downloads", currentSettings.takeoverAllDownloads ? "On" : "Off"],
    ["Context menus", currentSettings.showContextMenu ? "On" : "Off"],
    ["Scan capture mode", scanModeMeta.label],
    ["Runtime ID", chrome.runtime.id],
  ].forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "kv-row";

    const left = document.createElement("div");
    left.className = "label";
    left.textContent = label;

    const right = document.createElement("div");
    right.textContent = value;

    row.appendChild(left);
    row.appendChild(right);
    settingsSummary.appendChild(row);
  });
}

async function load() {
  const data = await chrome.storage.local.get(defaults);
  currentSettings = {
    takeoverAllDownloads: !!data.takeoverAllDownloads,
    showContextMenu: !!data.showContextMenu,
    scanCaptureMode: normalizeScanCaptureMode(data.scanCaptureMode, data),
  };
  const scanModeMeta = renderScanMode(currentSettings.scanCaptureMode, data);
  renderSettingsSummary(scanModeMeta);
  setStatus("Popup settings mirrored here for diagnostics.");
}

let statusTimer = null;
function setStatus(text) {
  status.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ""), 1500);
}

let scanModeStatusTimer = null;
function setScanModeStatus(text) {
  scanModeStatus.textContent = text;
  if (scanModeStatusTimer) clearTimeout(scanModeStatusTimer);
  scanModeStatusTimer = setTimeout(() => (scanModeStatus.textContent = ""), 1500);
}

scanModeSelect?.addEventListener("change", async () => {
  const nextMode = normalizeScanCaptureMode(scanModeSelect.value);
  currentSettings.scanCaptureMode = nextMode;
  await chrome.storage.local.set({ scanCaptureMode: nextMode });
  const scanModeMeta = renderScanMode(nextMode);
  renderSettingsSummary(scanModeMeta);
  setScanModeStatus("Advanced scan mode saved.");
});

load();
