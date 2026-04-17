import assert from "node:assert/strict";

const DIRECT_MEDIA_EXT_RE =
  /\.(mp4|mkv|webm|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd|ts|m4s|weba)(?:$|[?#])/i;
const DIRECT_FILE_EXT_RE =
  /\.(exe|msi|msix|msixbundle|appx|appxbundle|zip|rar|7z|tar|gz|bz2|xz|iso|img|dmg|pkg|deb|rpm|apk|ipa|jar|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|json|xml|txt|rtf|epub)(?:$|[?#])/i;

function isManifestLikeUrl(url = "") {
  return /(?:\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|master\.m3u8|playlist\.m3u8|manifest)/i.test(url);
}

function isClearlyDirectMedia(url = "") {
  return !!(
    url &&
    (DIRECT_MEDIA_EXT_RE.test(url) ||
      DIRECT_FILE_EXT_RE.test(url) ||
      /(?:googlevideo\.com|videoplayback|\.m3u8(?:$|[?#])|\.mpd(?:$|[?#]))/i.test(url))
  );
}

function isYouTubePageUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "youtube-nocookie.com" ||
      host === "www.youtube-nocookie.com"
    );
  } catch {
    return false;
  }
}

function normalizeComparableUrl(url = "") {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function shouldPreferYouTubeMetadata({ payloadUrl = "", referrerUrl = "" }) {
  return (
    isYouTubePageUrl(referrerUrl) ||
    isYouTubePageUrl(payloadUrl) ||
    ((payloadUrl.includes("googlevideo.com") || payloadUrl.includes("videoplayback")) &&
      isYouTubePageUrl(referrerUrl))
  );
}

function classifyBrowserDownloadTakeover({ url = "", filename = "", attempts = 0 }) {
  const hasGoodDirectUrl = isClearlyDirectMedia(url);
  const hasStrongFilenameSignal = DIRECT_FILE_EXT_RE.test(filename);

  if (!hasGoodDirectUrl && hasStrongFilenameSignal && attempts < 8) {
    return "wait_for_final_url";
  }
  if (!hasGoodDirectUrl) {
    return "leave_in_browser";
  }
  return "take_over";
}

function extensionRoutingDecision({
  payloadUrl = "",
  rawMediaUrl = "",
  referrerUrl = "",
  source = "chromium-scan-overlay",
}) {
  const preferredManifestUrl =
    (isManifestLikeUrl(payloadUrl) && payloadUrl) ||
    (isManifestLikeUrl(rawMediaUrl) ? rawMediaUrl : "");
  const isLikelyDirectFromUrlMismatch =
    payloadUrl &&
    referrerUrl &&
    normalizeComparableUrl(payloadUrl) !== normalizeComparableUrl(referrerUrl);
  const effectiveUrl =
    preferredManifestUrl ||
    rawMediaUrl ||
    (isLikelyDirectFromUrlMismatch ? payloadUrl : "") ||
    payloadUrl;

  if (shouldPreferYouTubeMetadata({ payloadUrl, referrerUrl })) {
    return "open_metadata";
  }

  if (
    source === "chromium-scan-overlay" &&
    !preferredManifestUrl &&
    isClearlyDirectMedia(effectiveUrl) &&
    !isManifestLikeUrl(effectiveUrl)
  ) {
    return "auto_queue_direct";
  }

  if (source === "chromium-downloads-api") {
    return "auto_queue_direct";
  }

  return "open_metadata";
}

const cases = [
  {
    label: "youtube playback should open metadata instead of direct queue",
    actual: extensionRoutingDecision({
      payloadUrl: "https://rr2---sn-ab5l6n7s.googlevideo.com/videoplayback?id=123",
      referrerUrl: "https://www.youtube.com/watch?v=abc123",
      source: "chromium-scan-overlay",
    }),
    expected: "open_metadata",
  },
  {
    label: "generic direct mp4 scan capture should auto queue",
    actual: extensionRoutingDecision({
      payloadUrl: "https://cdn.example.com/video.mp4",
      referrerUrl: "https://media.example.com/watch/alpha",
      source: "chromium-scan-overlay",
    }),
    expected: "auto_queue_direct",
  },
  {
    label: "manifest capture should prefer metadata flow",
    actual: extensionRoutingDecision({
      payloadUrl: "https://media.example.com/master.m3u8",
      referrerUrl: "https://media.example.com/watch/alpha",
      source: "chromium-scan-overlay",
    }),
    expected: "open_metadata",
  },
  {
    label: "browser download should wait for final direct url when only filename is strong",
    actual: classifyBrowserDownloadTakeover({
      url: "https://search.example.com/download-page",
      filename: "Installer.exe",
      attempts: 0,
    }),
    expected: "wait_for_final_url",
  },
  {
    label: "browser download should be left in browser when page url never resolves",
    actual: classifyBrowserDownloadTakeover({
      url: "https://search.example.com/download-page",
      filename: "Installer.exe",
      attempts: 8,
    }),
    expected: "leave_in_browser",
  },
  {
    label: "browser download should take over once final exe url is known",
    actual: classifyBrowserDownloadTakeover({
      url: "https://downloads.example.com/Installer.exe",
      filename: "Installer.exe",
      attempts: 1,
    }),
    expected: "take_over",
  },
];

for (const testCase of cases) {
  assert.equal(testCase.actual, testCase.expected, testCase.label);
  console.log(`PASS ${testCase.label}`);
}

console.log(`Summary: ${cases.length} handoff regression checks passed`);
