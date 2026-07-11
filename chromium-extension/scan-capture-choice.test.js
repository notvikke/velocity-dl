import { describe, expect, it } from "vitest";

import { chooseResolvedScanCapture } from "./scan-capture-choice.js";

describe("chooseResolvedScanCapture", () => {
  it("prefers a much stronger manifest candidate for smart scan captures", () => {
    expect(
      chooseResolvedScanCapture({
        source: "chromium-scan-overlay",
        scanCaptureMode: "smart",
        messageUrl:
          "https://ev.phncdn.com/c6251/videos/202601/07/35086265/1080P_4000K_35086265.mp4?token=direct",
        referrer: "https://www.pornhub.org/view_video.php?viewkey=695dfa0b4c099",
        directRawMediaUrl:
          "https://ev.phncdn.com/c6251/videos/202601/07/35086265/1080P_4000K_35086265.mp4?token=direct",
        rankedCandidates: [
          {
            url: "https://hv-h.phncdn.com/hls/c6251/videos/202601/07/35086265/master.m3u8?token=manifest",
            score: 225,
          },
          {
            url: "https://ev.phncdn.com/c6251/videos/202601/07/35086265/1080P_4000K_35086265.mp4?token=direct",
            score: 55,
          },
        ],
      })
    ).toEqual({
      resolvedUrl:
        "https://hv-h.phncdn.com/hls/c6251/videos/202601/07/35086265/master.m3u8?token=manifest",
      resolvedRawMediaUrl:
        "https://hv-h.phncdn.com/hls/c6251/videos/202601/07/35086265/master.m3u8?token=manifest",
      usedRecentPlayable: true,
    });
  });

  it("prefers a much stronger manifest candidate for quality-picker scan captures", () => {
    expect(
      chooseResolvedScanCapture({
        source: "chromium-scan-overlay",
        scanCaptureMode: "quality_picker",
        messageUrl:
          "https://ev.phncdn.com/c6251/videos/202601/07/35086265/1080P_4000K_35086265.mp4?token=direct",
        referrer: "https://www.pornhub.org/view_video.php?viewkey=695dfa0b4c099",
        directRawMediaUrl:
          "https://ev.phncdn.com/c6251/videos/202601/07/35086265/1080P_4000K_35086265.mp4?token=direct",
        rankedCandidates: [
          {
            url: "https://hv-h.phncdn.com/hls/c6251/videos/202601/07/35086265/master.m3u8?token=manifest",
            score: 225,
          },
          {
            url: "https://ev.phncdn.com/c6251/videos/202601/07/35086265/1080P_4000K_35086265.mp4?token=direct",
            score: 55,
          },
        ],
      })
    ).toEqual({
      resolvedUrl:
        "https://hv-h.phncdn.com/hls/c6251/videos/202601/07/35086265/master.m3u8?token=manifest",
      resolvedRawMediaUrl:
        "https://hv-h.phncdn.com/hls/c6251/videos/202601/07/35086265/master.m3u8?token=manifest",
      usedRecentPlayable: true,
    });
  });

  it("keeps the concrete direct stream in current-stream mode", () => {
    expect(
      chooseResolvedScanCapture({
        source: "chromium-scan-overlay",
        scanCaptureMode: "current_stream",
        messageUrl: "https://example.com/video.mp4?token=direct",
        referrer: "https://example.com/watch/123",
        directRawMediaUrl: "https://example.com/video.mp4?token=direct",
        rankedCandidates: [
          { url: "https://example.com/master.m3u8?token=manifest", score: 225 },
          { url: "https://example.com/video.mp4?token=direct", score: 55 },
        ],
      })
    ).toEqual({
      resolvedUrl: "https://example.com/video.mp4?token=direct",
      resolvedRawMediaUrl: "https://example.com/video.mp4?token=direct",
      usedRecentPlayable: false,
    });
  });

  it("falls back to the strongest recent playable candidate when no direct media URL exists", () => {
    expect(
      chooseResolvedScanCapture({
        source: "chromium-scan-overlay",
        scanCaptureMode: "quality_picker",
        messageUrl: "https://example.com/watch/123",
        referrer: "https://example.com/watch/123",
        directRawMediaUrl: null,
        rankedCandidates: [{ url: "https://example.com/master.m3u8?token=manifest", score: 225 }],
      })
    ).toEqual({
      resolvedUrl: "https://example.com/master.m3u8?token=manifest",
      resolvedRawMediaUrl: "https://example.com/master.m3u8?token=manifest",
      usedRecentPlayable: true,
    });
  });
});
