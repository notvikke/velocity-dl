import { describe, expect, it } from "vitest";

import { shouldOpenPickerForBrowserCapture } from "./browser-capture-routing";

describe("shouldOpenPickerForBrowserCapture", () => {
  it("does not force the picker for strong direct scan-overlay captures in smart mode", () => {
    expect(
      shouldOpenPickerForBrowserCapture({
        source: "chromium-scan-overlay",
        browserConfidence: "strong_direct",
        scanCaptureMode: "smart",
      })
    ).toBe(false);
  });

  it("opens the picker for strong direct scan-overlay captures when the scan setting requests it", () => {
    expect(
      shouldOpenPickerForBrowserCapture({
        source: "chromium-scan-overlay",
        browserConfidence: "strong_direct",
        scanCaptureMode: "quality_picker",
      })
    ).toBe(true);
  });

  it("keeps normal browser direct auto-start outside scan overlay", () => {
    expect(
      shouldOpenPickerForBrowserCapture({
        source: "chromium-downloads-api",
        browserConfidence: "strong_direct",
        scanCaptureMode: "quality_picker",
      })
    ).toBe(false);
  });

  it("does not force the picker when current-stream mode is selected", () => {
    expect(
      shouldOpenPickerForBrowserCapture({
        source: "chromium-scan-overlay",
        browserConfidence: "strong_direct",
        scanCaptureMode: "current_stream",
      })
    ).toBe(false);
  });

  it("keeps compatibility with the legacy boolean fallback", () => {
    expect(
      shouldOpenPickerForBrowserCapture({
        source: "chromium-scan-overlay",
        browserConfidence: "strong_direct",
        scanAutoOpenQualityPicker: true,
      })
    ).toBe(true);
  });
});
