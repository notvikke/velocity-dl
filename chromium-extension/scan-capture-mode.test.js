import { describe, expect, it } from "vitest";

import { DEFAULT_SCAN_CAPTURE_MODE, normalizeScanCaptureMode } from "./scan-capture-mode.js";

describe("normalizeScanCaptureMode", () => {
  it("defaults new installs to smart mode", () => {
    expect(DEFAULT_SCAN_CAPTURE_MODE).toBe("smart");
    expect(normalizeScanCaptureMode(undefined)).toBe("smart");
  });

  it("preserves the legacy current-stream fallback when the old boolean disabled the picker", () => {
    expect(normalizeScanCaptureMode(undefined, { autoOpenQualityPickerOnScanCapture: false })).toBe(
      "current_stream"
    );
  });
});
