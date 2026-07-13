import { describe, expect, it } from "vitest";
import { matchesDownloadTab } from "./download-visibility";

describe("download tab visibility", () => {
  it("keeps failed downloads visible in the active queue", () => {
    expect(matchesDownloadTab("error", "active", true)).toBe(true);
  });

  it("keeps expired finished downloads out of the finished queue", () => {
    expect(matchesDownloadTab("finished", "finished", false)).toBe(false);
  });
});
