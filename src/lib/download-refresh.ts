export interface DownloadForRefresh {
  id: string;
  status: "active" | "paused" | "processing" | "finished" | "error";
  speed: string;
  download_strategy?: string;
}

export interface DownloadRefreshRuntimeState {
  lastObservedAt: number;
  lastProgressValue: number;
  lastProgressAt: number;
  lastNonZeroSpeedAt: number;
  autoRefreshCount: number;
  refreshInFlight: boolean;
  lastRefreshAt?: number;
}

export const AUTO_REFRESH_IDLE_MS = 30_000;
export const AUTO_REFRESH_COOLDOWN_MS = 120_000;
export const MAX_AUTO_REFRESH_ATTEMPTS = 2;

const NON_REFRESHABLE_STRATEGIES = new Set(["hls_manifest", "dash_manifest"]);

export const isZeroLikeSpeed = (speed?: string) => {
  const normalized = speed?.trim().toLowerCase() ?? "";
  return !normalized || normalized === "0 b/s" || normalized === "preparing";
};

export const shouldAutoRefreshDownload = (
  download: DownloadForRefresh,
  runtime: DownloadRefreshRuntimeState | undefined,
  now: number
) => {
  if (!runtime) return false;
  if (download.status !== "active") return false;
  if (runtime.refreshInFlight) return false;
  if (runtime.autoRefreshCount >= MAX_AUTO_REFRESH_ATTEMPTS) return false;
  if (download.download_strategy && NON_REFRESHABLE_STRATEGIES.has(download.download_strategy)) {
    return false;
  }
  if (!isZeroLikeSpeed(download.speed)) {
    return false;
  }

  const lastMeaningfulActivityAt = Math.max(runtime.lastProgressAt, runtime.lastNonZeroSpeedAt);
  if (now - lastMeaningfulActivityAt < AUTO_REFRESH_IDLE_MS) {
    return false;
  }
  if (runtime.lastRefreshAt && now - runtime.lastRefreshAt < AUTO_REFRESH_COOLDOWN_MS) {
    return false;
  }
  return true;
};
