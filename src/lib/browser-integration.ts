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

export interface ExtensionIdentityStatus {
  kind: "chrome_web_store" | "local_unpacked" | "unsupported";
  supported: boolean;
  production: boolean;
  recommended: boolean;
}

export interface BrowserConnectionInput {
  runtimeId?: string;
  identity?: ExtensionIdentityStatus;
  nativeHostAvailable: boolean;
  anyBrowserAvailable: boolean;
  anyManifestInstalled: boolean;
}

export function browserConnectionPresentation(input: BrowserConnectionInput) {
  if (input.runtimeId && input.identity?.kind === "chrome_web_store" && input.identity.supported) {
    return {
      title: "Connected with the official extension",
      description: "VelocityDL is ready to receive downloads from your browser.",
      tone: "success" as const,
      extensionModeLabel: "Official Web Store",
    };
  }
  if (input.runtimeId && input.identity?.kind === "local_unpacked" && input.identity.supported) {
    return {
      title: "Connected via local extension",
      description: "Your locally loaded extension is connected and ready to use.",
      tone: "success" as const,
      extensionModeLabel: "Local extension",
    };
  }
  if (input.runtimeId) {
    return {
      title: "Extension ID mismatch",
      description: "The connected extension is not the official Web Store build or an unpacked ID configured in the native bridge.",
      tone: "warning" as const,
      extensionModeLabel: "Unknown",
    };
  }
  if (!input.nativeHostAvailable) {
    return {
      title: "Native host unavailable",
      description: "This build cannot find the desktop bridge required by the browser extension.",
      tone: "warning" as const,
      extensionModeLabel: "Not detected",
    };
  }
  if (!input.anyBrowserAvailable) {
    return {
      title: "Action required",
      description: "Install a supported Chromium browser to continue setup.",
      tone: "warning" as const,
      extensionModeLabel: "Not detected",
    };
  }
  if (!input.anyManifestInstalled) {
    return {
      title: "Browser setup incomplete",
      description: "Install or repair the browser bridge, then open the extension once.",
      tone: "warning" as const,
      extensionModeLabel: "Not detected",
    };
  }
  return {
    title: "Waiting for extension connection",
    description: "Open the extension from your browser toolbar to complete setup.",
    tone: "neutral" as const,
    extensionModeLabel: "Not detected",
  };
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
