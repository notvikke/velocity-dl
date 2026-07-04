import { describe, expect, it } from "vitest";

import { shouldRejectWeakScanCapture } from "./capture-routing.js";

describe("shouldRejectWeakScanCapture", () => {
  it("rejects blob-backed scan captures when no concrete playable URL was found", () => {
    expect(
      shouldRejectWeakScanCapture({
        source: "chromium-scan-overlay",
        referrer: "https://www.xvideos.com/video.oheiepm1d80/eternal_best_scenes",
        resolvedUrl: "https://www.xvideos.com/video.oheiepm1d80/eternal_best_scenes",
        resolvedRawMediaUrl: "blob:https://www.xvideos.com/512815ae-52eb-47aa-8e44-b5ee61e24f9d",
        hasConcreteResolvedUrl: false,
        hasConcreteRawMediaUrl: false,
        hasTopCandidate: false,
        isLikelyEmbedPage: false,
        rawMediaWasBlob: true,
      })
    ).toEqual({
      reject: true,
      reason: "weak_blob_scan_capture",
    });
  });

  it("keeps a scan capture when a playable candidate was found", () => {
    expect(
      shouldRejectWeakScanCapture({
        source: "chromium-scan-overlay",
        referrer: "https://example.com/watch/1",
        resolvedUrl: "https://cdn.example.com/master.m3u8",
        resolvedRawMediaUrl: "https://cdn.example.com/master.m3u8",
        hasConcreteResolvedUrl: true,
        hasConcreteRawMediaUrl: true,
        hasTopCandidate: true,
        isLikelyEmbedPage: false,
        rawMediaWasBlob: true,
      })
    ).toEqual({
      reject: false,
      reason: null,
    });
  });

  it("does not affect non-scan sources", () => {
    expect(
      shouldRejectWeakScanCapture({
        source: "chromium-context-page",
        referrer: "https://example.com/watch/1",
        resolvedUrl: "https://example.com/watch/1",
        resolvedRawMediaUrl: null,
        hasConcreteResolvedUrl: false,
        hasConcreteRawMediaUrl: false,
        hasTopCandidate: false,
        isLikelyEmbedPage: false,
        rawMediaWasBlob: false,
      })
    ).toEqual({
      reject: false,
      reason: null,
    });
  });
});
