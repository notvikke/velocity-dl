import { describe, expect, it } from "vitest";
import { downloadRevealView, selectorForDownloadId } from "./download-reveal";

describe("accepted download reveal", () => {
  it("reveals the active queue without a stale category or search filter", () => {
    expect(downloadRevealView("download-123")).toEqual({
      downloadId: "download-123",
      activeTab: "active",
      activeCategory: "all",
      searchTerm: "",
    });
  });

  it("builds a safe selector for download ids containing punctuation", () => {
    expect(selectorForDownloadId('download"with\\punctuation')).toBe(
      '[data-download-id="download\\"with\\\\punctuation"]'
    );
  });
});
