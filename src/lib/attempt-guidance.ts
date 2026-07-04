export interface AttemptStepForGuidance {
  stepId: string;
  label: string;
  status: "running" | "succeeded" | "failed";
  detail?: string;
}

export interface AttemptSessionForGuidance {
  id: string;
  title: string;
  url: string;
  status: "running" | "succeeded" | "failed";
  summary?: string;
  steps: AttemptStepForGuidance[];
}

export interface AttemptGuidance {
  reason: string;
  nextAction: string;
  routeLabel?: string;
  sourceStepLabel?: string;
}

const ROUTE_LABELS: Record<string, string> = {
  auto_start_direct: "Browser direct auto-start",
  auto_start_manifest: "Browser manifest auto-start",
  confirm_start: "Browser confirmed start",
  rejected_invalid_url: "Browser capture rejected: invalid URL",
  rejected_duplicate: "Browser capture rejected: duplicate",
  rejected_disabled: "Browser capture rejected: disabled in settings",
  capture_processing_failed: "Browser capture processing failed",
  direct_file: "Direct file download",
  hls_manifest: "HLS manifest download",
  dash_manifest: "DASH manifest download",
  metadata_extractor: "Metadata extractor flow",
};

const normalizeText = (value?: string) => value?.trim().toLowerCase() ?? "";

const includesAny = (haystack: string, needles: string[]) =>
  needles.some((needle) => haystack.includes(needle));

const summarizeSucceededSession = (session: AttemptSessionForGuidance): AttemptGuidance => ({
  reason: session.summary?.trim() || "Download preparation completed successfully.",
  nextAction: "Progress should now move on the download card. If it stalls, reopen this procedure report and inspect the latest step.",
  routeLabel: detectRouteLabel(session),
});

export const formatAttemptRouteLabel = (route?: string) =>
  route ? ROUTE_LABELS[route] || route.replace(/_/g, " ") : undefined;

const detectRouteLabel = (session: AttemptSessionForGuidance) => {
  const routeStep = session.steps.find((step) => step.stepId === "route_selected");
  if (routeStep?.detail) {
    return formatAttemptRouteLabel(routeStep.detail);
  }

  const strategyStep = [...session.steps]
    .reverse()
    .find((step) => step.stepId === "classify_strategy" && step.status === "succeeded");
  return formatAttemptRouteLabel(strategyStep?.detail);
};

export const deriveAttemptGuidance = (
  session: AttemptSessionForGuidance
): AttemptGuidance | null => {
  if (!session) return null;
  if (session.status === "succeeded") {
    return summarizeSucceededSession(session);
  }

  const failedStep = [...session.steps].reverse().find((step) => step.status === "failed");
  const combined = normalizeText(
    [session.summary, failedStep?.label, failedStep?.detail, session.url].filter(Boolean).join(" | ")
  );
  const routeLabel = detectRouteLabel(session);

  if (includesAny(combined, ["duplicate capture", "matching active download already exists", "duplicate"])) {
    return {
      reason: "VelocityDL rejected this attempt because it matched a download that was already queued or recently captured.",
      nextAction: "Use the existing download entry instead of retrying immediately. If this was not the same file, wait for the dedupe window to expire and capture it again.",
      routeLabel,
      sourceStepLabel: failedStep?.label,
    };
  }

  if (
    includesAny(combined, [
      "behaved like a web page",
      "page, not a direct file",
      "response did not validate as direct media",
    ])
  ) {
    return {
      reason: "VelocityDL received a page URL, but that URL did not resolve to a directly downloadable media/file response.",
      nextAction: "Use Start Download so VelocityDL can run the metadata picker, or trigger the browser overlay on the actual playing media instead of the page URL.",
      routeLabel,
      sourceStepLabel: failedStep?.label,
    };
  }

  if (
    includesAny(combined, [
      "sign-in",
      "login",
      "bot verification",
      "403",
      "401",
      "forbidden",
      "unauthorized",
      "cookie",
      "auth required",
    ])
  ) {
    return {
      reason: "The site appears to require sign-in, browser-session cookies, or anti-bot clearance before the media URL can be used.",
      nextAction: "Stay logged in, start playback in the browser, then retry with the extension handoff or Deep Sniff so VelocityDL inherits the working session context.",
      routeLabel,
      sourceStepLabel: failedStep?.label,
    };
  }

  if (includesAny(combined, ["m3u8", "mpd", "manifest", "ffmpeg"])) {
    return {
      reason: "The browser handoff reached a stream-manifest path, but the manifest/FFmpeg stage did not complete cleanly.",
      nextAction: "Retry from the browser handoff while the page is still open, then check whether the stream is playback-gated or header-sensitive. If it repeats, export diagnostics from this procedure report.",
      routeLabel,
      sourceStepLabel: failedStep?.label,
    };
  }

  if (
    includesAny(combined, ["yt-dlp", "browser session headers", "default (auto)", "connection to"]) &&
    includesAny(combined, ["timed out", "timeout"])
  ) {
    return {
      reason: "VelocityDL fell back to page extraction, but the extractor timed out before it could resolve a stable media URL.",
      nextAction: "Retry after the actual media request has started in the browser. If scan overlay still only sees a blob-backed player/page URL, use Deep Sniff instead of the page handoff.",
      routeLabel,
      sourceStepLabel: failedStep?.label,
    };
  }

  if (includesAny(combined, ["yt-dlp", "extractor", "metadata"])) {
    return {
      reason: "VelocityDL could not extract stable media metadata from the captured page.",
      nextAction: "Prefer a browser-originated capture after playback starts. If the page stays ambiguous, use Start Download and verify the extractor path there instead of pasting the top-level page URL.",
      routeLabel,
      sourceStepLabel: failedStep?.label,
    };
  }

  if (includesAny(combined, ["timed out", "timeout"])) {
    return {
      reason: "The preparation flow timed out before VelocityDL got enough information to queue the download.",
      nextAction: "Retry with the browser page already loaded and media already playing. If the same timeout repeats, inspect the last failed step and export diagnostics.",
      routeLabel,
      sourceStepLabel: failedStep?.label,
    };
  }

  return {
    reason: failedStep?.detail?.trim() || session.summary?.trim() || "Download preparation failed before the item could be queued.",
    nextAction: "Inspect the failed step below, then retry from the browser handoff if this was browser-originated. If the failure repeats, copy diagnostics and compare the last failed step.",
    routeLabel,
    sourceStepLabel: failedStep?.label,
  };
};
