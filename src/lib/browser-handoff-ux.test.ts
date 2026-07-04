import { describe, expect, it } from "vitest";

import { shouldRevealAppForBrowserHandoff } from "./browser-handoff-ux";

describe("shouldRevealAppForBrowserHandoff", () => {
  it("reveals the app for accepted regular browser-download takeovers", () => {
    expect(
      shouldRevealAppForBrowserHandoff({
        source: "chromium-downloads-api",
        routeClass: "auto_start_direct",
      })
    ).toBe(true);
  });

  it("does not reveal the app for scan overlay captures", () => {
    expect(
      shouldRevealAppForBrowserHandoff({
        source: "chromium-scan-overlay",
        routeClass: "auto_start_direct",
      })
    ).toBe(false);
  });

  it("does not reveal the app for confirm-start flows", () => {
    expect(
      shouldRevealAppForBrowserHandoff({
        source: "chromium-downloads-api",
        routeClass: "confirm_start",
      })
    ).toBe(false);
  });
});
