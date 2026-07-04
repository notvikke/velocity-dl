const defaults = {
  takeoverAllDownloads: true,
  showContextMenu: true,
  scanCaptureMode: "quality_picker",
};

const settingsSummary = document.getElementById("settingsSummary");
const status = document.getElementById("status");

async function load() {
  const data = await chrome.storage.local.get(defaults);
  const scanCaptureMode =
    data.scanCaptureMode === "current_stream" || data.scanCaptureMode === "quality_picker"
      ? data.scanCaptureMode
      : data.autoOpenQualityPickerOnScanCapture === false
        ? "current_stream"
        : "quality_picker";
  settingsSummary.replaceChildren();
  [
    ["Take over downloads", data.takeoverAllDownloads ? "On" : "Off"],
    ["Context menus", data.showContextMenu ? "On" : "Off"],
    ["Scan capture mode", scanCaptureMode === "quality_picker" ? "Quality picker" : "Current stream"],
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
  setStatus("Popup settings mirrored here for diagnostics.");
}

let statusTimer = null;
function setStatus(text) {
  status.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ""), 1500);
}

load();
