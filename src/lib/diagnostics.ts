import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

const DIAGNOSTICS_STORAGE_KEY = "velocitydl.frontend-diagnostics.v1";
const MAX_ENTRIES = 60;

type DiagnosticLevel = "error" | "warn";

interface FrontendDiagnosticEntry {
  at: number;
  level: DiagnosticLevel;
  message: string;
}

declare global {
  interface Window {
    __VDL_CONSOLE_DIAGNOSTICS_INSTALLED__?: boolean;
  }
}

const normalizePart = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const loadEntries = (): FrontendDiagnosticEntry[] => {
  try {
    const raw = localStorage.getItem(DIAGNOSTICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveEntries = (entries: FrontendDiagnosticEntry[]) => {
  try {
    localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Best-effort only.
  }
};

export const recordFrontendDiagnostic = (level: DiagnosticLevel, ...parts: unknown[]) => {
  const message = parts.map(normalizePart).join(" | ").trim();
  if (!message) return;

  const next = loadEntries();
  next.push({
    at: Date.now(),
    level,
    message,
  });
  saveEntries(next);
};

export const installConsoleDiagnostics = () => {
  if (typeof window === "undefined" || window.__VDL_CONSOLE_DIAGNOSTICS_INSTALLED__) {
    return;
  }
  window.__VDL_CONSOLE_DIAGNOSTICS_INSTALLED__ = true;

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    recordFrontendDiagnostic("error", ...args);
    originalError(...args);
  };

  console.warn = (...args: unknown[]) => {
    recordFrontendDiagnostic("warn", ...args);
    originalWarn(...args);
  };
};

export const buildFrontendDiagnosticsText = () => {
  const entries = loadEntries();
  if (!entries.length) {
    return "Frontend Diagnostics\n(no recent console warnings/errors)";
  }

  return [
    "Frontend Diagnostics",
    ...entries.map(
      (entry) =>
        `${new Date(entry.at).toISOString()} [${entry.level.toUpperCase()}] ${entry.message}`
    ),
  ].join("\n");
};

const buildBackendDiagnosticsText = async () => {
  try {
    return await invoke<string>("get_app_diagnostics");
  } catch (error) {
    const message = normalizePart(error);
    recordFrontendDiagnostic("error", "backend diagnostics unavailable", message);
    return [
      "VelocityDL Diagnostics",
      `backend_diagnostics_error: ${message}`,
    ].join("\n");
  }
};

export const buildCombinedDiagnosticsText = async (context?: string) => {
  const backend = await buildBackendDiagnosticsText();
  const frontend = buildFrontendDiagnosticsText();
  return [backend, "", context ? `context: ${context}` : null, frontend]
    .filter(Boolean)
    .join("\n");
};

const copyTextWithFallbacks = async (text: string) => {
  let pluginError: unknown = null;
  try {
    await writeText(text);
    return;
  } catch (error) {
    pluginError = error;
    recordFrontendDiagnostic("warn", "clipboard plugin write failed", normalizePart(error));
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (error) {
    recordFrontendDiagnostic("warn", "navigator clipboard write failed", normalizePart(error));
    throw error instanceof Error && pluginError
      ? new Error(
          `clipboard plugin failed: ${normalizePart(pluginError)} | navigator clipboard failed: ${normalizePart(error)}`
        )
      : error;
  }

  throw pluginError ?? new Error("No clipboard write method available");
};

export const copyAppDiagnosticsToClipboard = async (context?: string) => {
  const diagnostics = await buildCombinedDiagnosticsText(context);
  await copyTextWithFallbacks(diagnostics);
  return diagnostics;
};
