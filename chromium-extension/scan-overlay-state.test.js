import { describe, expect, it } from "vitest";

import { shouldReinjectScanOverlay } from "./scan-overlay-state.js";

describe("shouldReinjectScanOverlay", () => {
  it("requests reinjection when the scan overlay receiver is missing", () => {
    expect(
      shouldReinjectScanOverlay(
        new Error("Could not establish connection. Receiving end does not exist.")
      )
    ).toBe(true);
  });

  it("does not request reinjection for unrelated delivery failures", () => {
    expect(shouldReinjectScanOverlay(new Error("The frame was removed."))).toBe(false);
  });
});
