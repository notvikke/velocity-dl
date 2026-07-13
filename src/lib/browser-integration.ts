export interface BrowserIntegrationProfile {
  id: string;
  label: string;
  available: boolean;
  manifest_installed: boolean;
  registered_manifest_path?: string;
  manifest_extension_id?: string;
  runtime_matches_manifest: boolean;
  manifest_id_readable: boolean;
  install_url: string;
  extensions_url: string;
  setup_hint: string;
}

function normalizeBrowserName(value?: string) {
  return (value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function selectBrowserProfile(
  profiles: BrowserIntegrationProfile[],
  browserName?: string,
) {
  const normalized = normalizeBrowserName(browserName);
  const exact = profiles.find((profile) => {
    const id = normalizeBrowserName(profile.id);
    const label = normalizeBrowserName(profile.label);
    return normalized === id || normalized === label || normalized.includes(id);
  });
  if (exact) return exact;

  const available = profiles.filter((profile) => profile.available);
  if (available.length === 1) return available[0];
  return available.find((profile) => profile.manifest_installed) || null;
}

export function browserSetupInstruction(
  profile: BrowserIntegrationProfile,
  managedExtensionDirectory?: string,
) {
  const fallback = managedExtensionDirectory
    ? `If the store installation is unavailable, open ${profile.extensions_url}, enable Developer mode, and load unpacked from ${managedExtensionDirectory}.`
    : `If the store installation is unavailable, open ${profile.extensions_url} and use the app-managed unpacked extension after it is prepared.`;
  return `${profile.label}: ${profile.setup_hint} ${fallback}`;
}
