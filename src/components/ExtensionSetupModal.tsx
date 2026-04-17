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
    setBusy(true);
    saveIdsLocally();
    try {
      const result = await invoke<BrowserIntegrationInstallResult>(
        "install_browser_integration",
        {
          chromeExtensionId: chromeId.trim() || null,
          edgeExtensionId: edgeId.trim() || null,
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
                  <div className="mb-2 text-sm font-semibold text-gray-100">Step 1</div>
                  <div className="mb-3 text-xs text-gray-500">
                    Open your browser&apos;s extensions page, enable Developer mode, then load the unpacked extension folder.
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
                    Copy the extension ID shown on the extensions page and paste it here. Chrome and Edge IDs can be different.
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
                </section>

                <section className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="mb-2 text-sm font-semibold text-gray-100">Step 3</div>
                  <div className="mb-3 text-xs text-gray-500">
                    Install the native bridge so the browser extension can hand downloads to VelocityDL without using PowerShell.
                  </div>
                  <button
                    type="button"
                    onClick={installIntegration}
                    disabled={busy || !status?.native_host_path || !status?.extension_directory}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-gray-500"
                  >
                    {busy ? "Installing..." : "Install Native Browser Integration"}
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
                      detail={status?.extension_directory || "Not found in this build"}
                    />
                    <StatusLine
                      label="Native host binary"
                      ok={!!status?.native_host_path}
                      detail={status?.native_host_path || "Not found in this build"}
                    />
                    <StatusLine
                      label="Chrome manifest"
                      ok={!!status?.chrome_manifest_installed}
                      detail={status?.chrome_manifest_installed ? "Installed" : "Not installed yet"}
                    />
                    <StatusLine
                      label="Edge manifest"
                      ok={!!status?.edge_manifest_installed}
                      detail={status?.edge_manifest_installed ? "Installed" : "Not installed yet"}
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

function StatusLine({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-black/10 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-gray-300">{label}</span>
        <span className={ok ? "text-emerald-400" : "text-amber-300"}>
          {ok ? "Ready" : "Missing"}
        </span>
      </div>
      <div className="mt-1 break-all text-[11px] text-gray-500">{detail}</div>
    </div>
  );
}
