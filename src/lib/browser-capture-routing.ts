export interface BrowserCaptureRoutingInput {
  source?: string;
  browserConfidence?: "strong_direct" | "strong_manifest" | "ambiguous_media" | "page";
  scanCaptureMode?: "quality_picker" | "current_stream";
  scanAutoOpenQualityPicker?: boolean;
}

export const shouldOpenPickerForBrowserCapture = ({
  source,
  browserConfidence,
  scanCaptureMode,
  scanAutoOpenQualityPicker,
}: BrowserCaptureRoutingInput) =>
  source === "chromium-scan-overlay" &&
  browserConfidence === "strong_direct" &&
  (scanCaptureMode
    ? scanCaptureMode === "quality_picker"
    : scanAutoOpenQualityPicker !== false);
