import { normalizeScanCaptureMode } from "./scan-capture-mode.js";

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isManifestLikeUrl(url) {
  return typeof url === "string" && /\.(m3u8|mpd)(?:$|[?#])/i.test(url);
}

function isConcretePlayableUrl(url) {
  if (!isHttpUrl(url)) return false;
  return (
    /\.(m3u8|mpd|mp4|mkv|webm|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|m4s|ts|weba)(?:$|[?#])/i.test(
      url
    ) ||
    /(?:googlevideo\.com\/videoplayback|manifest|master\.m3u8|playlist\.m3u8)/i.test(url)
  );
}

const MANIFEST_PREFERENCE_SCORE_GAP = 80;

export function chooseResolvedScanCapture({
  source,
  scanCaptureMode,
  messageUrl,
  referrer,
  directRawMediaUrl,
  rankedCandidates,
}) {
  const normalizedMode = normalizeScanCaptureMode(scanCaptureMode);
  const topCandidate = Array.isArray(rankedCandidates) ? rankedCandidates[0] : null;
  const topCandidateUrl = typeof topCandidate?.url === "string" ? topCandidate.url : null;
  const topCandidateScore = Number.isFinite(topCandidate?.score) ? topCandidate.score : Number.NEGATIVE_INFINITY;

  const directCandidateScore =
    typeof directRawMediaUrl === "string"
      ? (
          (Array.isArray(rankedCandidates)
            ? rankedCandidates.find((entry) => entry?.url === directRawMediaUrl)?.score
            : undefined) ??
          (isManifestLikeUrl(directRawMediaUrl) ? 140 : isConcretePlayableUrl(directRawMediaUrl) ? 45 : 0)
        )
      : Number.NEGATIVE_INFINITY;

  const shouldPreferRankedManifest =
    source === "chromium-scan-overlay" &&
    normalizedMode !== "current_stream" &&
    typeof directRawMediaUrl === "string" &&
    typeof topCandidateUrl === "string" &&
    isManifestLikeUrl(topCandidateUrl) &&
    topCandidateScore >= directCandidateScore + MANIFEST_PREFERENCE_SCORE_GAP;

  if (shouldPreferRankedManifest) {
    return {
      resolvedUrl: topCandidateUrl,
      resolvedRawMediaUrl: topCandidateUrl,
      usedRecentPlayable: topCandidateUrl !== messageUrl,
    };
  }

  if (typeof directRawMediaUrl === "string") {
    return {
      resolvedUrl: directRawMediaUrl,
      resolvedRawMediaUrl: directRawMediaUrl,
      usedRecentPlayable: false,
    };
  }

  const canUseRecentPlayable =
    source === "chromium-scan-overlay" &&
    (!isHttpUrl(messageUrl) || messageUrl === referrer || !isConcretePlayableUrl(messageUrl));

  if (canUseRecentPlayable && typeof topCandidateUrl === "string") {
    return {
      resolvedUrl: topCandidateUrl,
      resolvedRawMediaUrl: topCandidateUrl,
      usedRecentPlayable: topCandidateUrl !== messageUrl,
    };
  }

  return {
    resolvedUrl: messageUrl,
    resolvedRawMediaUrl: null,
    usedRecentPlayable: false,
  };
}
