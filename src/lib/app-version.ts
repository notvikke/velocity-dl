import { getVersion } from "@tauri-apps/api/app";

const UNKNOWN_APP_VERSION = "v—";

export const loadAppVersion = async (): Promise<string> => {
  try {
    const version = (await getVersion()).trim();
    return version ? `v${version}` : UNKNOWN_APP_VERSION;
  } catch {
    return UNKNOWN_APP_VERSION;
  }
};
