export const DEFAULT_SCAN_CAPTURE_MODE = "smart";

export function normalizeScanCaptureMode(value, legacySettings = {}) {
  if (value === "smart" || value === "quality_picker" || value === "current_stream") {
    return value;
  }

  if (legacySettings.autoOpenQualityPickerOnScanCapture === false) {
    return "current_stream";
  }

  return DEFAULT_SCAN_CAPTURE_MODE;
}

export function getScanCaptureModeMeta(value, legacySettings = {}) {
  const mode = normalizeScanCaptureMode(value, legacySettings);

  switch (mode) {
    case "quality_picker":
      return {
        mode,
        badge: "Quality",
        label: "Quality picker",
        description: "Always hand off the quality manifest so VelocityDL can show available variants.",
      };
    case "current_stream":
      return {
        mode,
        badge: "Stream",
        label: "Current stream",
        description: "Prefer the exact media stream already playing on the page when possible.",
      };
    default:
      return {
        mode: DEFAULT_SCAN_CAPTURE_MODE,
        badge: "Smart",
        label: "Smart",
        description: "Auto-pick a direct file or the best available quality without extra prompts.",
      };
  }
}
