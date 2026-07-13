export type DownloadStatus = "active" | "paused" | "processing" | "finished" | "error";

export const ACTIVE_QUEUE_STATUSES: DownloadStatus[] = [
  "active",
  "paused",
  "processing",
  "error",
];

export const matchesDownloadTab = (
  status: DownloadStatus,
  tab: string,
  finishedWithinWindow: boolean
) => {
  if (tab === "active") return ACTIVE_QUEUE_STATUSES.includes(status);
  if (tab === "finished") return status === "finished" && finishedWithinWindow;
  return status === tab;
};
