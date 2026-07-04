function normalizeComparableUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url || "";
  }
}

export function shouldRejectWeakScanCapture({
  source,
  referrer,
  resolvedUrl,
  resolvedRawMediaUrl,
  hasConcreteResolvedUrl,
  hasConcreteRawMediaUrl,
  hasTopCandidate,
  isLikelyEmbedPage,
  rawMediaWasBlob,
}) {
  if (source !== "chromium-scan-overlay") {
    return { reject: false, reason: null };
  }

  if (hasConcreteResolvedUrl || hasConcreteRawMediaUrl || hasTopCandidate) {
    return { reject: false, reason: null };
  }

  const normalizedReferrer = normalizeComparableUrl(referrer || "");
  const normalizedResolvedUrl = normalizeComparableUrl(resolvedUrl || "");
  const normalizedRawMediaUrl = normalizeComparableUrl(resolvedRawMediaUrl || "");

  const fallsBackToPage =
    !normalizedResolvedUrl ||
    normalizedResolvedUrl === normalizedReferrer ||
    isLikelyEmbedPage;
  const rawMediaStillUnusable =
    !resolvedRawMediaUrl ||
    normalizedRawMediaUrl === normalizedReferrer ||
    rawMediaWasBlob;

  if (!fallsBackToPage || !rawMediaStillUnusable) {
    return { reject: false, reason: null };
  }

  return {
    reject: true,
    reason: rawMediaWasBlob ? "weak_blob_scan_capture" : "weak_page_scan_capture",
  };
}
