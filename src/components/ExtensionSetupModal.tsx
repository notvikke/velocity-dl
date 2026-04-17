import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, FolderOpen, Puzzle, ShieldCheck, X } from "lucide-react";

interface BrowserIntegrationStatus {
  extension_directory?: string;
  native_host_path?: string;
  chrome_available: boolean;
  edge_available: boolean;
  chrome_manifest_installed: boolean;
  edge_manifest_installed: boolean;
  chrome_manifest_path?: string;
  edge_manifest_path?: string;
  chrome_manifest_extension_id?: string;
  edge_manifest_extension_id?: string;
  last_seen_runtime_id?: string;
  last_seen_browser?: string;
  last_heartbeat_at_ms?: number;
  chrome_runtime_matches_manifest: boolean;
  edge_runtime_matches_manifest: boolean;
  chrome_manifest_id_readable: boolean;
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

  const openBrowserPage = async (browser: "chrome" | "edge") => {
    try {
      await invoke("open_browser_extensions_page", { browser });
      setMessage(
        browser === "chrome"
          ? "Opened Chrome extensions page"
          : "Opened Edge extensions page"
      );
    } catch (error) {
      console.error(`Failed to open ${browser} extensions page`, error);
      setMessage(
        browser === "chrome"
          ? "Could not open Chrome extensions page"
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
    const trimmedChromeId = chromeId.trim();
    const trimmedEdgeId = edgeId.trim();
    const fallbackChromeId =
      trimmedChromeId ||
      status?.chrome_manifest_extension_id ||
      (
        (status?.last_seen_browser || "").toLowerCase().includes("chrom") &&
        status?.last_seen_runtime_id
          ? status.last_seen_runtime_id
          : ""
      );
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
      chromeExtensionId: fallbackChromeId || null,
      edgeExtensionId: fallbackEdgeId || null,
    });
  };

  const installStateLabel = useMemo(() => {
    if (!status) return "Checking bundled browser integration files...";
    if (!status.native_host_path) {
      return "This build is missing the native host binary.";
    }
    if (!status.extension_directory) {
      return "This build is missing the bundled Chromium extension files.";
    }
    return "Use the steps below once per browser profile.";
  }, [status]);

  const activeBrowser = useMemo(() => {
    const browser = (status?.last_seen_browser || "").toLowerCase();
    if (browser.includes("edge")) return "edge";
    if (browser.includes("chrome") || browser.includes("chromium")) return "chrome";
    return null;
  }, [status?.last_seen_browser]);

  const runtimeMatchLabel = useMemo(() => {
    if (!status?.last_seen_runtime_id) {
      return "No extension heartbeat detected by the app yet.";
    }
    if (
      activeBrowser === "chrome" &&
      status.chrome_manifest_installed &&
      !status.chrome_manifest_id_readable
    ) {
      return "Chrome is connected, but the setup screen could not read the target ID back from the installed manifest.";
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

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/65 backdrop-blur-sm"
          />
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 18 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 18 }}
            className="relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-accent/10 p-2 text-accent">
                  <Puzzle size={18} />
                </div>
                <div>
                  <div className="font-semibold text-gray-100">Browser Setup Assistant</div>
                  <div className="text-xs text-gray-500">{installStateLabel}</div>
                </div>
              </div>
              <button onClick={onClose} className="text-gray-500 hover:text-white">
                <X size={20} />
              </button>
            </div>

            <div className="grid gap-6 overflow-y-auto px-6 py-5 md:grid-cols-[1.2fr_0.8fr]">
              <div className="space-y-5">
                <section className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="mb-2 text-sm font-semibold text-gray-100">Connection Check</div>
                  <div className="mb-4 text-xs text-gray-500">
                    Match the extension ID shown in your browser with the ID stored in the installed native messaging manifest.
                  </div>
                  <div className="mb-4 rounded-lg border border-border/70 bg-black/10 px-3 py-2 text-[11px] text-gray-400">
                    VelocityDL matches by extension ID, not by the folder path Chrome loaded. If multiple unpacked copies are enabled, Chrome may keep using the older one until you disable it.
                  </div>
                  <div className="rounded-xl border border-border/70 bg-black/10 p-3">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-medium text-gray-200">Current app detection</div>
                        <div className="mt-1 text-[11px] text-gray-500">
                          Last heartbeat: {heartbeatTimeLabel}
                        </div>
                      </div>
                      <span
                        className={connectionBadge.className}
                      >
                        {connectionBadge.text}
                      </span>
                    </div>
                    <div className="grid gap-3">
                      <IdRow
                        label="Detected by app"
                        value={status?.last_seen_runtime_id}
                        hint={status?.last_seen_browser ? `Browser: ${status.last_seen_browser}` : "No heartbeat detected yet"}
                        status={status?.last_seen_runtime_id ? "unknown" : "missing"}
                      />
                      <IdRow
                        label="Chrome manifest target"
                        value={status?.chrome_manifest_extension_id}
                        hint={status?.chrome_manifest_path || "Chrome manifest not installed yet"}
                        status={
                          !status?.chrome_manifest_installed
                            ? "missing"
                            : !status.chrome_manifest_id_readable
                              ? "unknown"
                              : status.chrome_runtime_matches_manifest
                                ? "match"
                                : "different"
                        }
                      />
                      <IdRow
                        label="Edge manifest target"
                        value={status?.edge_manifest_extension_id}
                        hint={status?.edge_manifest_path || "Edge manifest not installed yet"}
                        status={
                          !status?.edge_manifest_installed
                            ? "missing"
                            : !status.edge_manifest_id_readable
                              ? "unknown"
                              : status.edge_runtime_matches_manifest
                                ? "match"
                                : "different"
                        }
                      />
                    </div>
                    <div className="mt-3 text-[11px] text-gray-400">{runtimeMatchLabel}</div>
                  </div>
                </section>

                <section className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="mb-2 text-sm font-semibold text-gray-100">Step 1</div>
                  <div className="mb-3 text-xs text-gray-500">
                    Open your browser&apos;s extensions page, enable Developer mode, then load the unpacked extension folder shown below.
                  </div>
                  <div className="mb-3 rounded-lg border border-border/70 bg-black/10 px-3 py-2 text-[11px] text-gray-400">
                    <div className="mb-1 font-medium text-gray-200">Folder to load</div>
                    <div className="break-all">{status?.extension_directory || "Bundled extension folder not found"}</div>
                  </div>
                  <div className="mb-3 text-[11px] text-gray-500">
                    Production builds use a stable app-managed folder. Development runs may still show a workspace path until the bridge is installed or repaired once.
                  </div>
                  <div className="mb-3 text-[11px] text-gray-500">
                    For installed builds, disable older unpacked copies in Chrome before testing this folder, otherwise Chrome can keep sending heartbeats from the older enabled extension.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => openBrowserPage("chrome")}
                      disabled={!status?.chrome_available}
                      className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-gray-500"
                    >
                      Open Chrome Extensions
                    </button>
                    <button
                      type="button"
                      onClick={() => openBrowserPage("edge")}
                      disabled={!status?.edge_available}
                      className="rounded-lg bg-white/8 px-3 py-2 text-xs font-semibold text-gray-200 hover:bg-white/12 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-gray-500"
                    >
                      Open Edge Extensions
                    </button>
                    <button
                      type="button"
                      onClick={openExtensionFolder}
                      className="rounded-lg bg-white/8 px-3 py-2 text-xs font-semibold text-gray-200 hover:bg-white/12"
                    >
                      <span className="inline-flex items-center gap-2">
                        <FolderOpen size={14} />
                        Open Extension Folder
                      </span>
                    </button>
                  </div>
                </section>

                <section className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="mb-2 text-sm font-semibold text-gray-100">Step 2</div>
                  <div className="mb-4 text-xs text-gray-500">
                    Copy the extension ID shown on the extensions page and paste it here. Use Update IDs to rewrite the browser manifest for the extension you actually loaded.
                  </div>
                  <div className="space-y-3">
                    <label className="block">
                      <div className="mb-1 text-xs font-medium text-gray-300">Chrome extension ID</div>
                      <input
                        value={chromeId}
                        onChange={(event) => setChromeId(event.target.value)}
                        placeholder="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-gray-200 outline-none transition-colors focus:border-accent/50"
                      />
                    </label>
                    <label className="block">
                      <div className="mb-1 text-xs font-medium text-gray-300">Edge extension ID</div>
                      <input
                        value={edgeId}
                        onChange={(event) => setEdgeId(event.target.value)}
                        placeholder="Optional if you only use Chrome"
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-gray-200 outline-none transition-colors focus:border-accent/50"
                      />
                    </label>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={installIntegration}
                      disabled={busy || (!chromeId.trim() && !edgeId.trim())}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-gray-500"
                    >
                      {busy ? "Working..." : "Update Browser IDs"}
                    </button>
                    <div className="self-center text-[11px] text-gray-500">
                      This updates the native messaging manifest to the IDs entered above.
                    </div>
                  </div>
                </section>

                <section className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="mb-2 text-sm font-semibold text-gray-100">Step 3</div>
                  <div className="mb-3 text-xs text-gray-500">
                    Install or repair the native bridge files. If the fields above are blank, this will reuse the detected runtime ID or existing manifest IDs when possible.
                  </div>
                  <button
                    type="button"
                    onClick={repairIntegration}
                    disabled={busy || !status?.native_host_path || !status?.extension_directory}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-gray-500"
                  >
                    {busy ? "Working..." : "Install or Repair Browser Bridge"}
                  </button>
                </section>
              </div>

              <div className="space-y-4">
                <section className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-100">
                    <ShieldCheck size={16} className="text-accent" />
                    Readiness
                  </div>
                  <div className="space-y-2 text-xs text-gray-400">
                    <StatusLine
                      label="Bundled extension files"
                      ok={!!status?.extension_directory}
                      okLabel="Installed"
                      detail={status?.extension_directory || "Not found in this build"}
                    />
                    <StatusLine
                      label="Native host binary"
                      ok={!!status?.native_host_path}
                      okLabel="Installed"
                      detail={status?.native_host_path || "Not found in this build"}
                    />
                    <StatusLine
                      label="Chrome manifest"
                      ok={!!status?.chrome_manifest_installed}
                      okLabel="Installed"
                      detail={
                        status?.chrome_manifest_installed
                          ? `Installed${status.chrome_manifest_extension_id ? ` for ${status.chrome_manifest_extension_id}` : ""}`
                          : "Not installed yet"
                      }
                    />
                    <StatusLine
                      label="Edge manifest"
                      ok={!!status?.edge_manifest_installed}
                      okLabel="Installed"
                      detail={
                        status?.edge_manifest_installed
                          ? `Installed${status.edge_manifest_extension_id ? ` for ${status.edge_manifest_extension_id}` : ""}`
                          : "Not installed yet"
                      }
                    />
                  </div>
                </section>

                <section className="rounded-xl border border-border bg-background/40 p-4 text-xs text-gray-400">
                  <div className="mb-2 font-semibold text-gray-100">Fallback</div>
                  <div className="mb-3">
                    If a browser build or policy blocks the assisted path, the manual guide is still available.
                  </div>
                  <button
                    type="button"
                    onClick={openDocs}
                    className="rounded-lg bg-white/8 px-3 py-2 text-xs font-semibold text-gray-200 hover:bg-white/12"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ExternalLink size={14} />
                      Open Setup Guide
                    </span>
                  </button>
                </section>

                {message && (
                  <div className="rounded-xl border border-border bg-background/50 px-4 py-3 text-xs text-gray-300">
                    {message}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function StatusLine({
  label,
  ok,
  detail,
  okLabel = "Ready",
}: {
  label: string;
  ok: boolean;
  detail: string;
  okLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-black/10 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-gray-300">{label}</span>
        <span className={ok ? "text-emerald-400" : "text-amber-300"}>
          {ok ? okLabel : "Missing"}
        </span>
      </div>
      <div className="mt-1 break-all text-[11px] text-gray-500">{detail}</div>
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
    <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium text-gray-300">{label}</div>
        <span className={badge.className}>{badge.text}</span>
      </div>
      <div className="break-all font-mono text-[12px] text-gray-100">
        {value || "Not available"}
      </div>
      <div className="mt-1 break-all text-[11px] text-gray-500">{hint}</div>
    </div>
  );
}
