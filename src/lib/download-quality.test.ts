import { describe, expect, it } from "vitest";

import { formatDownloadQualityBadge } from "./download-quality";

describe("formatDownloadQualityBadge", () => {
  it("formats resolution and bitrate when both are known", () => {
    expect(
      formatDownloadQualityBadge({
        qualityLabel: "1080p",
        bitrateKbps: 5312,
      })
    ).toBe("1080p • 5312 kbps");
  });

  it("returns only the quality label when bitrate is missing", () => {
    expect(
      formatDownloadQualityBadge({
        qualityLabel: "720p",
      })
    ).toBe("720p");
  });

  it("returns null when no trustworthy quality fields exist", () => {
    expect(formatDownloadQualityBadge({})).toBeNull();
  });
});
