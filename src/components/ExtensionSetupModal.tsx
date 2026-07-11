import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

interface BrowserIntegrationStatus {
  extension_directory?: string;
  native_host_path?: string;
  webstore_extension_id: string;
  webstore_install_url: string;
  chrome_available: boolean;
  helium_available: boolean;
  edge_available: boolean;
  chrome_manifest_installed: boolean;
  chromium_manifest_installed: boolean;
  helium_manifest_installed: boolean;
  edge_manifest_installed: boolean;
  chrome_manifest_path?: string;
  chromium_manifest_path?: string;
  helium_manifest_path?: string;
  edge_manifest_path?: string;
  chrome_registered_manifest_path?: string;
  chromium_registered_manifest_path?: string;
  helium_registered_manifest_path?: string;
  edge_registered_manifest_path?: string;
  chrome_manifest_extension_id?: string;
  chromium_manifest_extension_id?: string;
  helium_manifest_extension_id?: string;
  edge_manifest_extension_id?: string;
  last_seen_runtime_id?: string;
  last_seen_browser?: string;
  last_heartbeat_at_ms?: number;
  chrome_runtime_matches_manifest: boolean;
  chromium_runtime_matches_manifest: boolean;
  helium_runtime_matches_manifest: boolean;
  edge_runtime_matches_manifest: boolean;
  chrome_manifest_id_readable: boolean;
  chromium_manifest_id_readable: boolean;
  helium_manifest_id_readable: boolean;
  edge_manifest_id_readable: boolean;
  docs_url: string;
}

interface BrowserIntegrationInstallResult {
  message: string;
  chrome_manifest_path?: string;
  edge_manifest_path?: string;
}

interface ExtensionSetupModalProps {
  isOpen: boolean;
  initialChromeId?: string;
  initialEdgeId?: string;
  onClose: () => void;
  onInstalled?: () => void | Promise<void>;
}

const STORAGE_KEYS = {
  chrome: "velocitydl.chromeExtensionId",
  edge: "velocitydl.edgeExtensionId",
};

export function ExtensionSetupModal({
  isOpen,
  initialChromeId,
  initialEdgeId,
  onClose,
  onInstalled,
}: ExtensionSetupModalProps) {
  const [status, setStatus] = useState<BrowserIntegrationStatus | null>(null);
  const [chromeId, setChromeId] = useState("");
  const [edgeId, setEdgeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refreshStatus = async () => {
    const next = await invoke<BrowserIntegrationStatus>("get_browser_integration_status");
    setStatus(next);
    return next;
  };

  useEffect(() => {
    if (!isOpen) return;
    refreshStatus().catch((error) => {
      console.error("Failed to load browser integration status", error);
      setMessage("Failed to inspect browser integration status");
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setChromeId(
      initialChromeId ||
        window.localStorage.getItem(STORAGE_KEYS.chrome) ||
        ""
    );
    setEdgeId(
      initialEdgeId ||
        window.localStorage.getItem(STORAGE_KEYS.edge) ||
        ""
    );
    setMessage("");
  }, [initialChromeId, initialEdgeId, isOpen]);

  const saveIdsLocally = () => {
    window.localStorage.setItem(STORAGE_KEYS.chrome, chromeId.trim());
    window.localStorage.setItem(STORAGE_KEYS.edge, edgeId.trim());
  };

  const openBrowserInstallPage = async (browser: "chrome" | "helium" | "edge") => {
    try {
      await invoke("open_browser_install_page", { browser });
      setMessage(
        browser === "chrome"
          ? "Opened Chrome Web Store page"
          : browser === "helium"
            ? "Opened Helium with the Chrome Web Store page"
            : "Opened Edge with the Chrome Web Store page"
      );
    } catch (error) {
      console.error(`Failed to open ${browser} install page`, error);
      setMessage(
        browser === "chrome"
          ? "Could not open the Chrome Web Store page in Chrome"
          : browser === "helium"
            ? "Could not open the Chrome Web Store page in Helium"
            : "Could not open the Chrome Web Store page in Edge"
      );
    }
  };

  const openBrowserPage = async (browser: "chrome" | "helium" | "edge") => {
    try {
      await invoke("open_browser_extensions_page", { browser });
      setMessage(
        browser === "chrome"
          ? "Opened Chrome extensions page"
          : browser === "helium"
            ? "Opened Helium extensions page"
          : "Opened Edge extensions page"
      );
    } catch (error) {
      console.error(`Failed to open ${browser} extensions page`, error);
      setMessage(
        browser === "chrome"
          ? "Could not open Chrome extensions page"
          : browser === "helium"
            ? "Could not open Helium extensions page"
          : "Could not open Edge extensions page"
      );
    }
  };

  const openExtensionFolder = async () => {
    if (!status?.extension_directory) {
      setMessage("Bundled extension files were not found in this build");
      return;
    }
    try {
      await invoke("open_folder", { path: status.extension_directory });
      setMessage("Opened bundled extension folder");
    } catch (error) {
      console.error("Failed to open extension folder", error);
      setMessage("Could not open bundled extension folder");
    }
  };

  const openDocs = async () => {
    if (!status?.docs_url) return;
    try {
      await invoke("open_extension_setup_link", { url: status.docs_url });
    } catch (error) {
      console.error("Failed to open browser integration docs", error);
      setMessage("Could not open browser integration guide");
    }
  };

  const installIntegration = async () => {
    const trimmedChromeId = chromeId.trim();
    const trimmedEdgeId = edgeId.trim();
    return installOrRepairIntegration({
      chromeExtensionId: trimmedChromeId || null,
      edgeExtensionId: trimmedEdgeId || null,
    });
  };

  const installOrRepairIntegration = async ({
    chromeExtensionId,
    edgeExtensionId,
  }: {
    chromeExtensionId: string | null;
    edgeExtensionId: string | null;
  }) => {
    setBusy(true);
    saveIdsLocally();
    try {
      const result = await invoke<BrowserIntegrationInstallResult>(
        "install_browser_integration",
        {
          chromeExtensionId,
          edgeExtensionId,
        }
      );
      setMessage(result.message);
      await refreshStatus();
      await onInstalled?.();
    } catch (error) {
      console.error("Failed to install native browser integration", error);
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to install native browser integration"
      );
    } finally {
      setBusy(false);
    }
  };

  const repairIntegration = async () => {
    const trimmedEdgeId = edgeId.trim();
    const fallbackEdgeId =
      trimmedEdgeId ||
      status?.edge_manifest_extension_id ||
      (
        (status?.last_seen_browser || "").toLowerCase().includes("edge") &&
        status?.last_seen_runtime_id
          ? status.last_seen_runtime_id
          : ""
      );

    await installOrRepairIntegration({
      chromeExtensionId: null,
      edgeExtensionId: fallbackEdgeId || null,
    });
  };

  const activeBrowser = useMemo(() => {
    const browser = (status?.last_seen_browser || "").toLowerCase();
    if (browser.includes("edge")) return "edge";
    if (browser.includes("chrome") || browser.includes("chromium") || browser.includes("helium")) {
      return "chrome";
    }
    return null;
  }, [status?.last_seen_browser]);

  const chromeManifestHint =
    status?.chrome_registered_manifest_path ||
    status?.chrome_manifest_path ||
    "Chrome manifest not installed yet";
  const heliumManifestHint =
    status?.helium_registered_manifest_path ||
    status?.helium_manifest_path ||
    "Helium manifest not installed yet";
  const chromiumManifestHint =
    status?.chromium_registered_manifest_path ||
    status?.chromium_manifest_path ||
    "Chromium fallback manifest not installed yet";
  const edgeManifestHint =
    status?.edge_registered_manifest_path ||
    status?.edge_manifest_path ||
    "Edge manifest not installed yet";

  const runtimeMatchLabel = useMemo(() => {
    if (!status?.last_seen_runtime_id) {
      return `No extension heartbeat detected yet. Install the web-store extension (${status?.webstore_extension_id || "stable ID"}), open its popup once, then refresh this screen.`;
    }
    if (
      activeBrowser === "chrome" &&
      status.chrome_manifest_installed &&
      !status.chrome_manifest_id_readable
    ) {
      return "A Chromium-family browser is connected, but the setup screen could not read the target ID back from the installed manifest.";
    }
    if (
      activeBrowser === "edge" &&
      status.edge_manifest_installed &&
      !status.edge_manifest_id_readable
    ) {
      return "Edge is connected, but the setup screen could not read the target ID back from the installed manifest.";
    }
    if (
      (activeBrowser === "chrome" && status.chrome_runtime_matches_manifest) ||
      (activeBrowser === "edge" && status.edge_runtime_matches_manifest)
    ) {
      return "The app heartbeat and installed browser manifest point to the same extension.";
    }
    return "The app detected an extension runtime ID that does not match the installed browser manifest.";
  }, [activeBrowser, status]);

  const connectionBadge = useMemo(() => {
    if (!status?.last_seen_runtime_id) {
      return {
        text: "Waiting",
        className: "rounded-full bg-white/10 px-2 py-1 text-[11px] font-medium text-gray-300",
      };
    }
    if (
      activeBrowser === "chrome" &&
      status.chrome_manifest_installed &&
      !status.chrome_manifest_id_readable
    ) {
      return {
        text: "ID Unknown",
        className: "rounded-full bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-300",
      };
    }
    if (
      activeBrowser === "edge" &&
      status.edge_manifest_installed &&
      !status.edge_manifest_id_readable
    ) {
      return {
        text: "ID Unknown",
        className: "rounded-full bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-300",
      };
    }
    if (
      (activeBrowser === "chrome" && status.chrome_runtime_matches_manifest) ||
      (activeBrowser === "edge" && status.edge_runtime_matches_manifest)
    ) {
      return {
        text: "IDs Match",
        className: "rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300",
      };
    }
    return {
      text: "Check IDs",
      className: "rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300",
    };
  }, [activeBrowser, status]);

  const heartbeatTimeLabel = useMemo(() => {
    if (!status?.last_heartbeat_at_ms) return "Not seen yet";
    return new Date(status.last_heartbeat_at_ms).toLocaleString();
  }, [status?.last_heartbeat_at_ms]);

  const connectionMatchesManifest = !!status?.last_seen_runtime_id && (
    (activeBrowser === "chrome" && status.chrome_runtime_matches_manifest) ||
    (activeBrowser === "edge" && status.edge_runtime_matches_manifest)
  );
  const isOfficialExtension =
    connectionMatchesManifest &&
    status?.last_seen_runtime_id === status?.webstore_extension_id;
  const isLocalExtension = connectionMatchesManifest && !isOfficialExtension;
  const anyManifestInstalled = !!status && (
    status.chrome_manifest_installed ||
    status.chromium_manifest_installed ||
    status.helium_manifest_installed ||
    status.edge_manifest_installed
  );
  const anyBrowserAvailable = !!status && (
    status.chrome_available || status.helium_available || status.edge_available
  );

  const masterStatus = useMemo(() => {
    if (!status) {
      return {
        title: "Verifying setup",
        description: "Checking the extension, native host, and browser connection.",
        tone: "neutral" as const,
        icon: LoaderCircle,
      };
    }
    if (connectionMatchesManifest) {
      return isOfficialExtension
        ? {
            title: "Connected with the official extension",
            description: "VelocityDL is ready to receive downloads from your browser.",
            tone: "success" as const,
            icon: CheckCircle2,
          }
        : {
            title: "Connected via local extension",
            description: "Your locally loaded extension is connected and ready to use.",
            tone: "success" as const,
            icon: CheckCircle2,
          };
    }
    if (status.last_seen_runtime_id) {
      const manifestIsUnreadable =
        (activeBrowser === "chrome" && status.chrome_manifest_installed && !status.chrome_manifest_id_readable) ||
        (activeBrowser === "edge" && status.edge_manifest_installed && !status.edge_manifest_id_readable);
      if (!activeBrowser || manifestIsUnreadable) {
        return {
          title: "Unknown connection state",
          description: runtimeMatchLabel,
          tone: "neutral" as const,
          icon: Circle,
        };
      }
      return {
        title: "Extension ID mismatch",
        description: runtimeMatchLabel,
        tone: "warning" as const,
        icon: AlertTriangle,
      };
    }
    if (!status.native_host_path) {
      return {
        title: "Native host unavailable",
        description: "This build cannot find the desktop bridge required by the browser extension.",
        tone: "warning" as const,
        icon: AlertTriangle,
      };
    }
    if (!anyBrowserAvailable) {
      return {
        title: "Action required",
        description: "Install a supported Chromium browser to continue setup.",
        tone: "warning" as const,
        icon: AlertTriangle,
      };
    }
    if (!anyManifestInstalled) {
      return {
        title: "Browser setup incomplete",
        description: "Install or repair the browser bridge, then open the extension once.",
        tone: "warning" as const,
        icon: AlertTriangle,
      };
    }
    return {
      title: "Waiting for extension connection",
      description: "Open the extension from your browser toolbar to complete setup.",
      tone: "neutral" as const,
      icon: Circle,
    };
  }, [
    activeBrowser,
    anyBrowserAvailable,
    anyManifestInstalled,
    connectionMatchesManifest,
    isOfficialExtension,
    runtimeMatchLabel,
    status,
  ]);

  const extensionModeLabel = isOfficialExtension
    ? "Official Web Store"
    : isLocalExtension
      ? "Local extension"
      : status?.last_seen_runtime_id
        ? "Unknown"
        : "Not detected";

  const activeManifestLabel = activeBrowser === "edge"
    ? status?.edge_manifest_installed ? "Edge ready" : "Edge incomplete"
    : activeBrowser === "chrome"
      ? status?.chrome_manifest_installed ? "Chromium ready" : "Chromium incomplete"
      : anyManifestInstalled
        ? "At least one ready"
        : "Not installed";

  const MasterIcon = masterStatus.icon;
  const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";
  const secondaryButton = `rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600 ${focusRing}`;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-5">
          <motion.button
            type="button"
            aria-label="Close browser setup assistant"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-black/75 backdrop-blur-sm"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-setup-title"
            aria-describedby="browser-setup-description"
            initial={{ scale: 0.97, opacity: 0, y: 14 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0, y: 14 }}
            className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60"
          >
            <header className="border-b border-zinc-800 px-4 py-4 sm:px-6">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-sky-400">
                  <Puzzle size={18} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="browser-setup-title" className="text-base font-semibold text-zinc-100">
                    Browser Setup Assistant
                  </h2>
                  <p id="browser-setup-description" className="mt-1 max-w-2xl text-xs leading-5 text-zinc-400">
                    VelocityDL needs a supported browser extension to communicate securely with the desktop app.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close browser setup assistant"
                  className={`rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-100 ${focusRing}`}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              <div className={`mt-4 flex items-start gap-3 rounded-xl border px-3.5 py-3 ${masterToneClasses[masterStatus.tone]}`} role="status">
                <MasterIcon className={masterStatus.title === "Verifying setup" ? "mt-0.5 animate-spin" : "mt-0.5"} size={17} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{masterStatus.title}</div>
                  <div className="mt-0.5 text-xs leading-5 opacity-80">{masterStatus.description}</div>
                </div>
              </div>
            </header>

            <div className="overflow-y-auto px-4 py-5 sm:px-6">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
                <main className="min-w-0 space-y-4">
                  <section className="rounded-xl border border-zinc-800 bg-zinc-900/45 p-4 sm:p-5">
                    <StepHeading number="1" title="Install the browser extension" />
                    <div className="mt-4 rounded-xl border border-sky-500/30 bg-sky-500/[0.07] p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-zinc-100">VelocityDL Bridge</h3>
                        <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                          Recommended
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-zinc-400">
                        Install from the Chrome Web Store for the standard setup that stays updated automatically.
                      </p>
                    </div>

                    <details className="group mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50">
                      <summary className={`cursor-pointer list-none px-3.5 py-3 text-xs font-medium text-zinc-300 hover:text-zinc-100 ${focusRing}`}>
                        <span className="inline-flex items-center gap-2">
                          <FolderOpen size={14} aria-hidden="true" />
                          Local or advanced installation
                        </span>
                      </summary>
                      <div className="border-t border-zinc-800 px-3.5 py-4">
                        <p className="text-xs leading-5 text-zinc-400">
                          Load the bundled extension unpacked, then enter the ID shown by your browser. This remains a fully supported alternative.
                        </p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1.5 block text-[11px] font-medium text-zinc-300">Chrome, Helium, or Chromium ID</span>
                            <input
                              value={chromeId}
                              onChange={(event) => setChromeId(event.target.value)}
                              placeholder="32-character extension ID"
                              className={`w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 ${focusRing}`}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-[11px] font-medium text-zinc-300">Edge ID</span>
                            <input
                              value={edgeId}
                              onChange={(event) => setEdgeId(event.target.value)}
                              placeholder="Optional if only using Chrome"
                              className={`w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 ${focusRing}`}
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" onClick={openExtensionFolder} disabled={!status?.extension_directory} className={secondaryButton}>
                            <span className="inline-flex items-center gap-2"><FolderOpen size={14} aria-hidden="true" />Open Extension Folder</span>
                          </button>
                          <button type="button" onClick={installIntegration} disabled={busy || (!chromeId.trim() && !edgeId.trim())} className={secondaryButton}>
                            {busy ? "Working..." : "Apply Manual IDs"}
                          </button>
                        </div>
                      </div>
                    </details>
                  </section>

                  <section className="rounded-xl border border-zinc-800 bg-zinc-900/45 p-4 sm:p-5">
                    <StepHeading number="2" title="Open a supported browser" />
                    <p className="mt-2 text-xs leading-5 text-zinc-400">
                      Open the Web Store listing in your preferred browser, install the extension, then select its toolbar icon once.
                    </p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      <BrowserButton label="Open In Chrome" available={!!status?.chrome_available} recommended onClick={() => openBrowserInstallPage("chrome")} focusRing={focusRing} />
                      <BrowserButton label="Open In Helium" available={!!status?.helium_available} onClick={() => openBrowserInstallPage("helium")} focusRing={focusRing} />
                      <BrowserButton label="Open In Edge" available={!!status?.edge_available} onClick={() => openBrowserInstallPage("edge")} focusRing={focusRing} />
                    </div>
                  </section>

                  <section className="rounded-xl border border-zinc-800 bg-zinc-900/45 p-4 sm:p-5">
                    <StepHeading number="3" title="Confirm the connection" />
                    <div className="mt-4 flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/55 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                          {connectionMatchesManifest ? <CheckCircle2 size={15} className="text-emerald-400" aria-hidden="true" /> : <Circle size={15} className="text-zinc-500" aria-hidden="true" />}
                          {connectionMatchesManifest ? `Connected · ${extensionModeLabel}` : connectionBadge.text}
                        </div>
                        <div className="mt-1 text-[11px] text-zinc-500">Last heartbeat: {heartbeatTimeLabel}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          refreshStatus()
                            .then(() => setMessage("Refreshed browser integration status"))
                            .catch((error) => {
                              console.error("Failed to refresh browser integration status", error);
                              setMessage("Could not refresh browser integration status");
                            });
                        }}
                        className={secondaryButton}
                      >
                        <span className="inline-flex items-center gap-2"><RefreshCw size={14} aria-hidden="true" />Refresh Status</span>
                      </button>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-zinc-400">{runtimeMatchLabel}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={repairIntegration}
                        disabled={busy || !status?.native_host_path}
                        className={`rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 ${focusRing}`}
                      >
                        {busy ? "Working..." : "Install or Repair Browser Bridge"}
                      </button>
                      <button type="button" onClick={openDocs} disabled={!status?.docs_url} className={secondaryButton}>
                        <span className="inline-flex items-center gap-2"><ExternalLink size={14} aria-hidden="true" />Open Setup Guide</span>
                      </button>
                    </div>
                  </section>
                </main>

                <aside className="min-w-0">
                  <section className="rounded-xl border border-zinc-800 bg-zinc-900/45 p-4 lg:sticky lg:top-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                      <ShieldCheck size={16} className="text-sky-400" aria-hidden="true" />
                      Readiness
                    </div>
                    <div className="mt-4 grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
                      <ReadinessItem label="Extension" value={status?.last_seen_runtime_id ? "Detected" : "Waiting"} ready={!!status?.last_seen_runtime_id} />
                      <ReadinessItem label="Extension mode" value={extensionModeLabel} ready={connectionMatchesManifest} neutral={!connectionMatchesManifest} />
                      <ReadinessItem label="Native host" value={status?.native_host_path ? "Available" : "Unavailable"} ready={!!status?.native_host_path} />
                      <ReadinessItem label="Browser manifest" value={activeManifestLabel} ready={anyManifestInstalled} />
                      <ReadinessItem label="Connection" value={connectionBadge.text} ready={connectionMatchesManifest} neutral={!status?.last_seen_runtime_id} />
                      <ReadinessItem label="Heartbeat" value={heartbeatTimeLabel} ready={!!status?.last_heartbeat_at_ms} neutral={!status?.last_heartbeat_at_ms} />
                    </div>

                    <div className="mt-4 border-t border-zinc-800 pt-4">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Browser tools</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" onClick={() => openBrowserPage("chrome")} disabled={!status?.chrome_available} className={secondaryButton}>Chrome extensions</button>
                        <button type="button" onClick={() => openBrowserPage("helium")} disabled={!status?.helium_available} className={secondaryButton}>Helium extensions</button>
                        <button type="button" onClick={() => openBrowserPage("edge")} disabled={!status?.edge_available} className={secondaryButton}>Edge extensions</button>
                      </div>
                    </div>
                  </section>
                </aside>
              </div>

              {message && (
                <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-3 text-xs text-zinc-300" role="status">
                  {message}
                </div>
              )}

              <details className="group mt-5 rounded-xl border border-zinc-800 bg-zinc-900/35">
                <summary className={`cursor-pointer list-none px-4 py-3.5 text-sm font-semibold text-zinc-300 transition hover:text-zinc-100 ${focusRing}`}>
                  Advanced Diagnostics
                </summary>
                <div className="border-t border-zinc-800 p-4">
                  <div className="grid gap-3 xl:grid-cols-2">
                    <DiagnosticGroup title="Extension and connection">
                      <DiagnosticValue label="Production extension ID" value={status?.webstore_extension_id} />
                      <DiagnosticValue label="Chrome Web Store install URL" value={status?.webstore_install_url} />
                      <DiagnosticValue label="Currently detected extension ID" value={status?.last_seen_runtime_id} />
                      <DiagnosticValue label="Active extension mode" value={extensionModeLabel} />
                      <DiagnosticValue label="Last seen browser" value={status?.last_seen_browser} />
                      <DiagnosticValue label="Last heartbeat" value={heartbeatTimeLabel} />
                      <DiagnosticValue label="Last heartbeat raw value" value={status?.last_heartbeat_at_ms} />
                      <DiagnosticValue label="Raw connection value" value={connectionBadge.text} />
                      <DiagnosticValue label="Connection detail" value={runtimeMatchLabel} />
                    </DiagnosticGroup>
                    <DiagnosticGroup title="Native host and local extension">
                      <DiagnosticValue label="Native host path" value={status?.native_host_path} />
                      <DiagnosticValue label="Bundled extension directory" value={status?.extension_directory} />
                      <DiagnosticValue label="Setup guide URL" value={status?.docs_url} />
                      <DiagnosticValue label="Chrome available" value={status?.chrome_available} />
                      <DiagnosticValue label="Helium available" value={status?.helium_available} />
                      <DiagnosticValue label="Edge available" value={status?.edge_available} />
                    </DiagnosticGroup>
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-2">
                    <DiagnosticGroup title="ID comparison values">
                      <IdRow label="Detected by app" value={status?.last_seen_runtime_id} hint={status?.last_seen_browser ? `Browser: ${status.last_seen_browser}` : "No heartbeat detected yet"} status={status?.last_seen_runtime_id ? "unknown" : "missing"} />
                      <IdRow label="Chrome manifest target" value={status?.chrome_manifest_extension_id} hint={chromeManifestHint} status={!status?.chrome_manifest_installed ? "missing" : !status.chrome_manifest_id_readable ? "unknown" : status.chrome_runtime_matches_manifest ? "match" : "different"} />
                      <IdRow label="Chromium fallback target" value={status?.chromium_manifest_extension_id} hint={chromiumManifestHint} status={!status?.chromium_manifest_installed ? "missing" : !status.chromium_manifest_id_readable ? "unknown" : status.chromium_runtime_matches_manifest ? "match" : "different"} />
                      <IdRow label="Helium manifest target" value={status?.helium_manifest_extension_id} hint={heliumManifestHint} status={!status?.helium_manifest_installed ? "missing" : !status.helium_manifest_id_readable ? "unknown" : status.helium_runtime_matches_manifest ? "match" : "different"} />
                      <IdRow label="Edge manifest target" value={status?.edge_manifest_extension_id} hint={edgeManifestHint} status={!status?.edge_manifest_installed ? "missing" : !status.edge_manifest_id_readable ? "unknown" : status.edge_runtime_matches_manifest ? "match" : "different"} />
                    </DiagnosticGroup>
                    <DiagnosticGroup title="Raw manifest checks">
                      <DiagnosticValue label="Chrome manifest installed" value={status?.chrome_manifest_installed} />
                      <DiagnosticValue label="Chrome manifest ID readable" value={status?.chrome_manifest_id_readable} />
                      <DiagnosticValue label="Chrome runtime matches manifest" value={status?.chrome_runtime_matches_manifest} />
                      <DiagnosticValue label="Chromium manifest installed" value={status?.chromium_manifest_installed} />
                      <DiagnosticValue label="Chromium manifest ID readable" value={status?.chromium_manifest_id_readable} />
                      <DiagnosticValue label="Chromium runtime matches manifest" value={status?.chromium_runtime_matches_manifest} />
                      <DiagnosticValue label="Helium manifest installed" value={status?.helium_manifest_installed} />
                      <DiagnosticValue label="Helium manifest ID readable" value={status?.helium_manifest_id_readable} />
                      <DiagnosticValue label="Helium runtime matches manifest" value={status?.helium_runtime_matches_manifest} />
                      <DiagnosticValue label="Edge manifest installed" value={status?.edge_manifest_installed} />
                      <DiagnosticValue label="Edge manifest ID readable" value={status?.edge_manifest_id_readable} />
                      <DiagnosticValue label="Edge runtime matches manifest" value={status?.edge_runtime_matches_manifest} />
                    </DiagnosticGroup>
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-2">
                    <DiagnosticGroup title="Manifest file targets">
                      <DiagnosticValue label="Chrome manifest path" value={status?.chrome_manifest_path} />
                      <DiagnosticValue label="Chromium fallback manifest path" value={status?.chromium_manifest_path} />
                      <DiagnosticValue label="Helium manifest path" value={status?.helium_manifest_path} />
                      <DiagnosticValue label="Edge manifest path" value={status?.edge_manifest_path} />
                    </DiagnosticGroup>
                    <DiagnosticGroup title="Registered manifest targets">
                      <DiagnosticValue label="Chrome registered target" value={status?.chrome_registered_manifest_path} />
                      <DiagnosticValue label="Chromium fallback registered target" value={status?.chromium_registered_manifest_path} />
                      <DiagnosticValue label="Helium registered target" value={status?.helium_registered_manifest_path} />
                      <DiagnosticValue label="Edge registered target" value={status?.edge_registered_manifest_path} />
                    </DiagnosticGroup>
                  </div>
                </div>
              </details>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

const masterToneClasses = {
  success: "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-200",
  warning: "border-amber-500/25 bg-amber-500/[0.07] text-amber-200",
  neutral: "border-zinc-700 bg-zinc-900 text-zinc-300",
};

function StepHeading({ number, title }: { number: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-[11px] font-semibold text-zinc-300">
        {number}
      </span>
      <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
    </div>
  );
}

function BrowserButton({
  label,
  available,
  recommended = false,
  onClick,
  focusRing,
}: {
  label: string;
  available: boolean;
  recommended?: boolean;
  onClick: () => void;
  focusRing: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!available}
      aria-label={label}
      className={`rounded-lg border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-950 disabled:text-zinc-600 ${
        recommended
          ? "border-sky-500/40 bg-sky-500/10 text-zinc-100 hover:bg-sky-500/15"
          : "border-zinc-700 bg-zinc-950/70 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-900"
      } ${focusRing}`}
    >
      <span className="block text-xs font-semibold">{label}</span>
      <span className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
        {available ? <Check size={11} aria-hidden="true" /> : <Circle size={11} aria-hidden="true" />}
        {available ? recommended ? "Recommended · Available" : "Available" : "Not available"}
      </span>
    </button>
  );
}

function ReadinessItem({
  label,
  value,
  ready,
  neutral = false,
}: {
  label: string;
  value: string;
  ready: boolean;
  neutral?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-800/80 py-2.5 last:border-b-0">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <span className={`flex min-w-0 items-center gap-1.5 text-right text-[11px] font-medium ${ready ? "text-emerald-300" : neutral ? "text-zinc-300" : "text-amber-300"}`}>
        {ready ? <CheckCircle2 size={12} aria-hidden="true" /> : neutral ? <Circle size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
        <span className="truncate">{value}</span>
      </span>
    </div>
  );
}

function DiagnosticGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/65 p-3">
      <h3 className="mb-3 text-xs font-semibold text-zinc-200">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function DiagnosticValue({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean | undefined;
}) {
  return (
    <div className="min-w-0 rounded-md bg-zinc-900/80 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-zinc-300">
        {value === undefined || value === "" ? "Not available" : String(value)}
      </div>
    </div>
  );
}

function IdRow({
  label,
  value,
  hint,
  status,
}: {
  label: string;
  value?: string;
  hint: string;
  status: "match" | "different" | "unknown" | "missing";
}) {
  const badge =
    status === "match"
      ? { text: "Match", className: "text-[11px] text-emerald-300" }
      : status === "different"
        ? { text: "Different", className: "text-[11px] text-amber-300" }
        : status === "unknown"
          ? { text: "Unknown", className: "text-[11px] text-sky-300" }
          : { text: "Missing", className: "text-[11px] text-gray-400" };
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium text-zinc-300">{label}</div>
        <span className={badge.className}>{badge.text}</span>
      </div>
      <div className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-100">
        {value || "Not available"}
      </div>
      <div className="mt-1 break-all text-[10px] leading-4 text-zinc-500">{hint}</div>
    </div>
  );
}
