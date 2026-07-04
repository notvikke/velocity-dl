export interface BrowserHandoffUxInput {
  source?: string;
  routeClass?: string;
}

export const shouldRevealAppForBrowserHandoff = ({
  source,
  routeClass,
}: BrowserHandoffUxInput) =>
  source === "chromium-downloads-api" && routeClass === "auto_start_direct";
