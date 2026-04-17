const defaults = {
  takeoverAllDownloads: true,
  showContextMenu: true,
  autoOpenQualityPickerOnScanCapture: true,
};

const takeoverInput = document.getElementById("takeoverAllDownloads");
const menuInput = document.getElementById("showContextMenu");
const scanPickerInput = document.getElementById("autoOpenQualityPickerOnScanCapture");
const status = document.getElementById("status");

async function load() {
  const data = await chrome.storage.local.get(defaults);
  takeoverInput.checked = !!data.takeoverAllDownloads;
  menuInput.checked = !!data.showContextMenu;
  scanPickerInput.checked = data.autoOpenQualityPickerOnScanCapture !== false;
}

let statusTimer = null;
function setStatus(text) {
  status.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ""), 1500);
}

async function save() {
  await chrome.storage.local.set({
    takeoverAllDownloads: takeoverInput.checked,
    showContextMenu: menuInput.checked,
    autoOpenQualityPickerOnScanCapture: scanPickerInput.checked,
  });
  setStatus("Saved");
}

takeoverInput.addEventListener("change", save);
menuInput.addEventListener("change", save);
scanPickerInput.addEventListener("change", save);

load();
