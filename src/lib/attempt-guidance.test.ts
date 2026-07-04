import { describe, expect, it } from "vitest";

import { deriveAttemptGuidance, type AttemptSessionForGuidance } from "./attempt-guidance";

const buildSession = (overrides: Partial<AttemptSessionForGuidance>): AttemptSessionForGuidance => ({
  id: "session-1",
  title: "Example",
  url: "https://example.com/video",
  status: "failed",
  steps: [],
  ...overrides,
});

describe("deriveAttemptGuidance", () => {
  it("explains when the queued URL behaved like a page instead of a direct file", () => {
    const guidance = deriveAttemptGuidance(
      buildSession({
        summary:
          "This URL behaved like a web page instead of a direct downloadable file. Open the metadata picker and let VelocityDL try extractor strategies.",
        steps: [
          {
            stepId: "validate_direct_url",
            label: "Validate queued URL as downloadable media",
            status: "failed",
            detail: "URL behaved like a page, not a direct file",
          },
        ],
      })
    );

    expect(guidance?.reason).toContain("page");
    expect(guidance?.nextAction).toContain("Start Download");
  });

  it("surfaces auth-gated extractor failures with a browser-session recommendation", () => {
    const guidance = deriveAttemptGuidance(
      buildSession({
        summary: "Failed to fetch media metadata.",
        steps: [
          {
            stepId: "ytdlp_strategy:browser_cookies",
            label: "yt-dlp strategy: Browser cookies",
            status: "failed",
            detail:
              "Site requires sign-in or bot verification. Use Deep Sniff after manual playback/login.",
          },
        ],
      })
    );

    expect(guidance?.reason).toContain("sign-in");
    expect(guidance?.nextAction).toContain("Deep Sniff");
  });

  it("treats extractor timeouts as weak capture failures instead of sign-in failures", () => {
    const guidance = deriveAttemptGuidance(
      buildSession({
        summary: "yt-dlp metadata attempt timed out after 45 seconds",
        steps: [
          {
            stepId: "ytdlp_strategy:browser_session_headers",
            label: "yt-dlp strategy: Browser session headers",
            status: "failed",
            detail:
              "Strategy 'Browser session headers' failed (exit exit code: 1): ERROR: Unable to download webpage: Connection to www.xvideos.com timed out. (connect timeout=20.0)",
          },
        ],
      })
    );

    expect(guidance?.reason).toContain("timed out");
    expect(guidance?.nextAction).toContain("actual media request");
  });

  it("keeps successful sessions informational instead of inventing a failure diagnosis", () => {
    const guidance = deriveAttemptGuidance(
      buildSession({
        status: "succeeded",
        summary: "Queued Example.mp4",
        steps: [
          {
            stepId: "route_selected",
            label: "Select browser takeover route",
            status: "succeeded",
            detail: "auto_start_direct",
          },
        ],
      })
    );

    expect(guidance?.reason).toContain("Queued");
    expect(guidance?.nextAction).toContain("Progress");
  });
});
