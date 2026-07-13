export interface DownloadRevealView {
  downloadId: string;
  activeTab: "active";
  activeCategory: "all";
  searchTerm: "";
}

export const downloadRevealView = (downloadId: string): DownloadRevealView => ({
  downloadId,
  activeTab: "active",
  activeCategory: "all",
  searchTerm: "",
});

const escapeCssAttributeValue = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const selectorForDownloadId = (downloadId: string) =>
  `[data-download-id="${escapeCssAttributeValue(downloadId)}"]`;
