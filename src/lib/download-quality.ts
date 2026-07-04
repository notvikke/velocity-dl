export interface DownloadQualityBadgeInput {
  qualityLabel?: string;
  bitrateKbps?: number;
}

export function formatDownloadQualityBadge(input: DownloadQualityBadgeInput): string | null {
  const qualityLabel = typeof input.qualityLabel === "string" ? input.qualityLabel.trim() : "";
  const bitrateKbps =
    typeof input.bitrateKbps === "number" && Number.isFinite(input.bitrateKbps) && input.bitrateKbps > 0
      ? Math.round(input.bitrateKbps)
      : null;

  if (qualityLabel && bitrateKbps) {
    return `${qualityLabel} • ${bitrateKbps} kbps`;
  }
  if (qualityLabel) {
    return qualityLabel;
  }
  if (bitrateKbps) {
    return `${bitrateKbps} kbps`;
  }
  return null;
}
