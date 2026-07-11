import { describe, expect, it } from "vitest";

import { buildBrowserTakeoverHeaders } from "./takeover-session.js";

describe("buildBrowserTakeoverHeaders", () => {
  it("adds referer and deduplicated cookies for browser takeover downloads", () => {
    expect(
      buildBrowserTakeoverHeaders({
        referrer: "https://gofile.io/d/NZSbd5",
        cookies: [
          { name: "accountToken", value: "abc123" },
          { name: "guest", value: "1" },
          { name: "accountToken", value: "abc123" },
        ],
      })
    ).toEqual({
      Referer: "https://gofile.io/d/NZSbd5",
      Cookie: "accountToken=abc123; guest=1",
    });
  });

  it("returns null when there is no usable browser session context", () => {
    expect(
      buildBrowserTakeoverHeaders({
        referrer: "chrome://downloads",
        cookies: [],
      })
    ).toBeNull();
  });
});
