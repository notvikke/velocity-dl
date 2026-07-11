import { describe, expect, it } from "vitest";

import { MediaCandidateStore, classifyMediaUrl } from "./media-observer-core.js";

describe("classifyMediaUrl", () => {
  it.each([
    ["https://cdn.test/master.m3u8?token=1", "hls_manifest"],
    ["https://cdn.test/manifest.mpd", "dash_manifest"],
    ["https://cdn.test/chunk-42.m4s", "dash_segment"],
    ["https://cdn.test/seg-42.ts", "hls_segment"],
    ["https://cdn.test/movie.mp4", "direct_media"],
    ["blob:https://player.test/id", "blob"],
  ])("classifies %s", (url, expected) => {
    expect(classifyMediaUrl(url)).toBe(expected);
  });
});

describe("MediaCandidateStore", () => {
  it("associates a blob-backed MSE player with its latest manifest and segments", () => {
    let now = 100;
    const store = new MediaCandidateStore({ now: () => now });
    store.observe({ tabId: 2, frameId: 3, url: "https://cdn.test/master.m3u8?token=x", kind: "fetch" });
    now += 1;
    store.observe({ tabId: 2, frameId: 3, url: "https://cdn.test/seg-1.ts?token=x", kind: "fetch" });
    now += 1;
    store.observe({ tabId: 2, frameId: 3, url: "blob:https://player.test/id", kind: "object_url" });

    expect(store.snapshot(2, 3)).toMatchObject({
      preferred_url: "https://cdn.test/master.m3u8?token=x",
      blob_urls: ["blob:https://player.test/id"],
      manifests: [{ url: "https://cdn.test/master.m3u8?token=x", type: "hls_manifest" }],
      segments: [{ url: "https://cdn.test/seg-1.ts?token=x", type: "hls_segment" }],
    });
  });

  it("deduplicates observations and enforces per-frame bounds", () => {
    const store = new MediaCandidateStore({ maxCandidates: 2 });
    store.observe({ tabId: 1, frameId: 0, url: "https://cdn.test/a.mp4", kind: "fetch" });
    store.observe({ tabId: 1, frameId: 0, url: "https://cdn.test/a.mp4", kind: "xhr" });
    store.observe({ tabId: 1, frameId: 0, url: "https://cdn.test/b.mp4", kind: "fetch" });
    store.observe({ tabId: 1, frameId: 0, url: "https://cdn.test/c.mp4", kind: "fetch" });

    const snapshot = store.snapshot(1, 0);
    expect(snapshot.direct.map((item) => item.url)).toEqual([
      "https://cdn.test/c.mp4",
      "https://cdn.test/b.mp4",
    ]);
  });
});
