import { describe, expect, it } from "vitest";

import {
  shouldAutoRefreshDownload,
  type DownloadForRefresh,
  type DownloadRefreshRuntimeState,
} from "./download-refresh";

const now = 1_700_000_000_000;

const buildDownload = (overrides: Partial<DownloadForRefresh> = {}): DownloadForRefresh => ({
  id: "dl-1",
  status: "active",
  speed: "0 B/s",
  download_strategy: "direct_file",
  ...overrides,
});

const buildRuntimeState = (
  overrides: Partial<DownloadRefreshRuntimeState> = {}
): DownloadRefreshRuntimeState => ({
  lastObservedAt: now,
  lastProgressValue: 42,
  lastProgressAt: now - 35_000,
  lastNonZeroSpeedAt: now - 35_000,
  autoRefreshCount: 0,
  refreshInFlight: false,
  ...overrides,
});

describe("shouldAutoRefreshDownload", () => {
  it("does not refresh non-active downloads", () => {
    expect(
      shouldAutoRefreshDownload(buildDownload({ status: "paused" }), buildRuntimeState(), now)
    ).toBe(false);
  });

  it("does not refresh ffmpeg/manifest processing paths", () => {
    expect(
      shouldAutoRefreshDownload(
        buildDownload({ download_strategy: "hls_manifest" }),
        buildRuntimeState(),
        now
      )
    ).toBe(false);
  });

  it("does not refresh on a short 10 second zero-speed dip", () => {
    expect(
      shouldAutoRefreshDownload(
        buildDownload(),
        buildRuntimeState({
          lastProgressAt: now - 10_000,
          lastNonZeroSpeedAt: now - 10_000,
        }),
        now
      )
    ).toBe(false);
  });

  it("refreshes a direct active download after a sustained stall", () => {
    expect(shouldAutoRefreshDownload(buildDownload(), buildRuntimeState(), now)).toBe(true);
  });

  it("caps automatic refresh attempts to avoid loops", () => {
    expect(
      shouldAutoRefreshDownload(
        buildDownload(),
        buildRuntimeState({ autoRefreshCount: 2 }),
        now
      )
    ).toBe(false);
  });
});
