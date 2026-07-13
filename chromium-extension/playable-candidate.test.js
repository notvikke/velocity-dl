import { describe, expect, it } from "vitest";

import { scorePlayableCandidate } from "./playable-candidate.js";

describe("scorePlayableCandidate", () => {
  it("prefers suffix-bearing master manifests over leaf renditions", () => {
    const master = scorePlayableCandidate("https://cdn.test/playlist_vp9.m3u8", "");
    const suffixedMaster = scorePlayableCandidate(
      "https://cdn.test/master-1080.m3u8?token=x",
      ""
    );
    const videoLeaf = scorePlayableCandidate("https://cdn.test/vp_io8op/v.m3u8", "");
    const audioLeaf = scorePlayableCandidate("https://cdn.test/snd/a.m3u8", "");

    expect(videoLeaf).toBe(185);
    expect(audioLeaf).toBe(185);
    expect(master).toBe(225);
    expect(suffixedMaster).toBe(225);
  });

  it("preserves direct-media and junk candidate scoring", () => {
    expect(scorePlayableCandidate("https://cdn.test/movie.mp4", "video/mp4")).toBe(90);
    expect(scorePlayableCandidate("https://cdn.test/preview.mp4", "video/mp4")).toBe(-210);
  });
});
