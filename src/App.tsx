import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Download, CheckCircle, Film, Music, FileText, LayoutGrid, Settings, Plus, Maximize2, Minimize2, X, Search, Puzzle } from "lucide-react";
import { DownloadCard } from "./components/DownloadCard";
import { DownloadAttemptDialog } from "./components/DownloadAttemptDialog";
import { WelcomeSetupModal } from "./components/WelcomeSetupModal";
import { shouldOpenPickerForBrowserCapture } from "./lib/browser-capture-routing";
import { shouldRevealAppForBrowserHandoff } from "./lib/browser-handoff-ux";
import { copyAppDiagnosticsToClipboard, installConsoleDiagnostics } from "./lib/diagnostics";
import type { DownloadQualityBadgeInput } from "./lib/download-quality";
import { shouldAutoRefreshDownload, type DownloadRefreshRuntimeState, isZeroLikeSpeed } from "./lib/download-refresh";
import "./styles/tailwind.css";

const appWindow = getCurrentWindow();
const FINISHED_STORAGE_KEY = "velocitydl.finished.v1";
const RESUME_STORAGE_KEY = "velocitydl.resume.v1";
const ATTEMPT_HISTORY_STORAGE_KEY = "velocitydl.attempt-history.v1";
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const AddUrlModal = lazy(() =>
  import("./components/AddUrlModal").then((m) => ({ default: m.AddUrlModal }))
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal }))
);
const ExtensionSetupModal = lazy(() =>
  import("./components/ExtensionSetupModal").then((m) => ({ default: m.ExtensionSetupModal }))
);

interface DownloadItem {
  id: string;
  title: string;
  url: string;
  audio_url?: string;
  output_path: string;
  total_size: number;
  audio_size?: number;
  progress: number;
  speed: string;
  stream_speed_factor?: string;
  indeterminate_progress?: boolean;
  eta: string;
  status: 'active' | 'processing' | 'finished' | 'paused' | 'error';
  error?: string;
  headers?: Record<string, string>;
  audio_headers?: Record<string, string>;
  download_strategy?: string;
  segments?: { id: number; state: 'idle' | 'downloading' | 'finished' }[];
  category?: DownloadCategory;
  completed_at?: number;
  recovered?: boolean;
  attempt_session_id?: string;
  download_origin?: string;
  browser_source?: string;
  browser_confidence?: string;
  browser_request_id?: string;
  original_url?: string;
  referrer?: string;
  quality_label?: string;
  bitrate_kbps?: number;
}

type DownloadCategory = 'video' | 'audio' | 'image' | 'document' | 'archive' | 'file';
type DownloadStatus = DownloadItem["status"];

interface PersistedFinishedDownload {
  id: string;
  title: string;
  url: string;
  output_path: string;
  total_size: number;
  category: DownloadCategory;
  completed_at: number;
  download_strategy?: string;
  attempt_session_id?: string;
  download_origin?: string;
  browser_source?: string;
  browser_confidence?: string;
  browser_request_id?: string;
  original_url?: string;
  referrer?: string;
  quality_label?: string;
  bitrate_kbps?: number;
}

interface PersistedResumableDownload {
  id: string;
  title: string;
  url: string;
  audio_url?: string;
  output_path: string;
  total_size: number;
  audio_size?: number;
  headers?: Record<string, string>;
  audio_headers?: Record<string, string>;
  download_strategy?: string;
  category: DownloadCategory;
  progress: number;
  status: 'paused' | 'active' | 'processing';
  completed_at?: number;
  saved_at: number;
  attempt_session_id?: string;
  download_origin?: string;
  browser_source?: string;
  browser_confidence?: string;
  browser_request_id?: string;
  original_url?: string;
  referrer?: string;
  quality_label?: string;
  bitrate_kbps?: number;
}

interface AppSettings {
  default_download_path: string;
  play_sound_on_finish: boolean;
  play_sound_on_fail: boolean;
  launch_on_startup: boolean;
  auto_start_sniff_capture: boolean;
  accept_browser_download_requests: boolean;
  browser_takeover_all_downloads: boolean;
  developer_mode: boolean;
  auto_check_tool_updates: boolean;
  onboarding_completed: boolean;
  max_threads: number;
  speed_limit_mb: number;
}

interface ToolStatusResponse {
  name: string;
  installed: boolean;
  source: string;
  path?: string;
  current_version?: string;
  latest_version?: string;
  update_available: boolean;
  update_supported: boolean;
  last_error?: string;
}

interface ToolingStatusResponse {
  ytdlp: ToolStatusResponse;
  ffmpeg: ToolStatusResponse;
}

interface ExternalDownloadRequest {
  action?: string;
  url: string;
  filename?: string;
  mime?: string;
  referrer?: string;
  source?: string;
  scan_auto_open_quality_picker?: boolean;
  scan_capture_mode?: "quality_picker" | "current_stream";
  capture_type?: "page_url" | "direct_media_url" | "blob_backed_media";
  raw_media_url?: string;
  headers?: Record<string, string>;
  request_id?: string;
  wait_for_ack?: boolean;
  original_url?: string;
  browser_confidence?: "strong_direct" | "strong_manifest" | "ambiguous_media" | "page";
}

interface ExtensionHealth {
  install_url: string;
  setup_url: string;
  last_heartbeat_at_ms?: number;
  last_seen_browser?: string;
  last_seen_extension_version?: string;
  last_seen_runtime_id?: string;
  status: "connected" | "stale" | "inactive" | "not_detected";
  status_label: string;
}

interface ExtensionHealthEvent {
  heartbeat_at_ms: number;
  browser?: string;
  extension_version?: string;
  runtime_id?: string;
}

interface DownloadAttemptEvent {
  session_id: string;
  step_id: string;
  label: string;
  status: "running" | "succeeded" | "failed";
  detail?: string;
}

interface AttemptStep {
  stepId: string;
  label: string;
  status: "running" | "succeeded" | "failed";
  detail?: string;
  updatedAt: number;
}

interface AttemptSession {
  id: string;
  title: string;
  url: string;
  status: "running" | "succeeded" | "failed";
  summary?: string;
  steps: AttemptStep[];
  updatedAt: number;
}

interface DeleteDialogState {
  id: string;
  title: string;
  output_path: string;
  audio_url?: string;
  status: DownloadStatus;
}

type AddUrlLaunchSource = "manual" | "browser_capture" | "media_detected";
type BrowserConfidence = NonNullable<ExternalDownloadRequest["browser_confidence"]>;
type BrowserRouteClass =
  | "auto_start_direct"
  | "auto_start_manifest"
  | "confirm_start"
  | "rejected_invalid_url"
  | "rejected_duplicate"
  | "rejected_disabled"
  | "capture_processing_failed";

interface BrowserDownloadContext {
  strategyHint?: "direct_file" | "hls_manifest" | "dash_manifest";
  downloadOrigin?: "browser_takeover" | "manual" | "sniff_capture";
  browserSource?: string;
  browserConfidence?: BrowserConfidence;
  browserRequestId?: string;
  originalUrl?: string;
  referrer?: string;
  routeClass?: string;
}

type CaptureType = "page_url" | "direct_media_url" | "blob_backed_media";
type CaptureDecision =
  | "opened_metadata_modal"
  | "auto_started_direct"
  | "auto_started_manifest"
  | "ignored_invalid_url"
  | "ignored_by_setting"
  | "ignored_duplicate"
  | "capture_processing_failed";

interface CaptureDebugEntry {
  id: string;
  at: number;
  source: string;
  captureType: CaptureType;
  decision: CaptureDecision;
  url: string;
  headers?: Record<string, string>;
}

const DIRECT_MEDIA_EXT_RE = /\.(mp4|mkv|webm|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd|ts|m4s|weba)(?:$|[?#])/i;
const DIRECT_FILE_EXT_RE =
  /\.(exe|msi|msix|msixbundle|appx|appxbundle|zip|rar|7z|tar|gz|bz2|xz|iso|img|dmg|pkg|deb|rpm|apk|ipa|jar|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|json|xml|txt|rtf|epub)(?:$|[?#])/i;
const AUTO_CAPTURE_DEDUPE_WINDOW_MS = 90_000;
const DEFAULT_THREAD_COUNT = 16;
const REFRESH_RESUME_DELAY_MS = 900;
const ACTIVE_DOWNLOAD_STATUSES: DownloadStatus[] = ["active", "paused", "processing"];
const RUNNING_DOWNLOAD_STATUSES: DownloadStatus[] = ["active", "processing"];

const inferCategory = (titleOrUrl: string): DownloadCategory => {
  const clean = titleOrUrl.split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  if (!ext) return 'file';
  if (['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts'].includes(ext)) return 'video';
  if (['mp3', 'aac', 'flac', 'wav', 'm4a', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff'].includes(ext)) return 'image';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].includes(ext)) return 'archive';
  if (['txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'xml'].includes(ext)) return 'document';
  return 'file';
};

const isDocumentBucketCategory = (category?: DownloadCategory) =>
  category === 'document' || category === 'archive' || category === 'image' || category === 'file';

const isWithinTenDays = (completedAt?: number) => {
  if (!completedAt) return false;
  return Date.now() - completedAt <= TEN_DAYS_MS;
};

const inferCaptureType = (payload: ExternalDownloadRequest): CaptureType => {
  if (payload.capture_type) return payload.capture_type;
  if ((payload.raw_media_url || "").startsWith("blob:")) return "blob_backed_media";
  if (
    payload.source === "chromium-downloads-api" ||
    /^video\//i.test(payload.mime || "") ||
    /^audio\//i.test(payload.mime || "") ||
    /^application\/octet-stream$/i.test(payload.mime || "") ||
    DIRECT_MEDIA_EXT_RE.test(payload.url) ||
    DIRECT_FILE_EXT_RE.test(payload.url)
  ) {
    return "direct_media_url";
  }
  return "page_url";
};

const isHttpUrl = (value?: string) => typeof value === "string" && /^https?:\/\//i.test(value);

const isClearlyDirectMedia = (url?: string) =>
  !!(
    url &&
    (DIRECT_MEDIA_EXT_RE.test(url) ||
      DIRECT_FILE_EXT_RE.test(url) ||
      /(?:googlevideo\.com|videoplayback|\.m3u8(?:$|[?#])|\.mpd(?:$|[?#]))/i.test(url))
  );

const isManifestLikeUrl = (url?: string) =>
  !!url && /(?:\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|master\.m3u8|playlist\.m3u8|manifest)/i.test(url);

const isYouTubePageUrl = (url?: string) => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "youtube-nocookie.com" ||
      host === "www.youtube-nocookie.com"
    );
  } catch {
    return false;
  }
};

const extractFilenameFromUrl = (url?: string) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const leaf = parsed.pathname.split("/").pop() || "";
    const decoded = decodeURIComponent(leaf).trim();
    return decoded || null;
  } catch {
    return null;
  }
};

const pickBrowserConfidence = (
  payload: ExternalDownloadRequest,
  effectiveUrl: string,
  preferredManifestUrl: string | null,
  referrerUrl: string
): BrowserConfidence => {
  if (payload.browser_confidence) return payload.browser_confidence;
  if (isYouTubePageUrl(referrerUrl)) return "ambiguous_media";
  if (preferredManifestUrl || isManifestLikeUrl(effectiveUrl)) return "strong_manifest";
  if (isClearlyDirectMedia(effectiveUrl)) return "strong_direct";
  if (payload.capture_type === "page_url" || payload.source === "chromium-context-page") return "page";
  return "ambiguous_media";
};

const normalizeComparableUrl = (url?: string) => {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
};

const captureDedupeKey = (url: string, source?: string) => {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    // Scan captures can vary query params while representing the same media endpoint.
    const base =
      source === "chromium-scan-overlay"
        ? `${parsed.origin}${parsed.pathname}`
        : parsed.toString();
    return `${source || "unknown"}|${base}`;
  } catch {
    return `${source || "unknown"}|${url}`;
  }
};

const createIdleSegments = (count: number) =>
  Array.from({ length: Math.max(1, count) }, (_, i) => ({
    id: i,
    state: "idle" as const,
  }));

const parseSpeedToBytes = (value: string) => {
  const match = value.trim().match(/^([\d.]+)\s*(B|KB|MB)\/s$/i);
  if (!match) return 0;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;

  switch (match[2].toUpperCase()) {
    case "KB":
      return amount * 1024;
    case "MB":
      return amount * 1024 * 1024;
    default:
      return amount;
  }
};

const formatAggregateSpeed = (bytesPerSecond: number) => {
  if (bytesPerSecond <= 0) return "0 B/s";
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(1)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
};

function App() {
  const [activeTab, setActiveTab] = useState("active");
  const [activeCategory, setActiveCategory] = useState("all");
  const [isAddUrlOpen, setIsAddUrlOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isExtensionSetupOpen, setIsExtensionSetupOpen] = useState(false);
  const [initialUrl, setInitialUrl] = useState("");
  const [initialHeaders, setInitialHeaders] = useState<Record<string, string> | undefined>(undefined);
  const [initialAttemptSessionId, setInitialAttemptSessionId] = useState<string | undefined>(undefined);
  const [initialDownloadContext, setInitialDownloadContext] = useState<BrowserDownloadContext | undefined>(undefined);
  const [addUrlLaunchSource, setAddUrlLaunchSource] = useState<AddUrlLaunchSource>("manual");
  const [searchTerm, setSearchTerm] = useState("");
  const [developerModeEnabled, setDeveloperModeEnabled] = useState(false);
  const [showCaptureDebug, setShowCaptureDebug] = useState(false);
  const [captureDebugEntries, setCaptureDebugEntries] = useState<CaptureDebugEntry[]>([]);
  const [maxThreads, setMaxThreads] = useState(DEFAULT_THREAD_COUNT);
  const [diagnosticStatus, setDiagnosticStatus] = useState("");
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [showWelcomeSetup, setShowWelcomeSetup] = useState(false);
  const [extensionHealth, setExtensionHealth] = useState<ExtensionHealth | null>(null);
  const [extensionStatusMessage, setExtensionStatusMessage] = useState("");
  const [attemptSessions, setAttemptSessions] = useState<Record<string, AttemptSession>>({});
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [deleteFromDisk, setDeleteFromDisk] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const downloadsRef = useRef<DownloadItem[]>([]);
  const refreshStateRef = useRef<Record<string, DownloadRefreshRuntimeState>>({});
  const recentAutoCapturesRef = useRef<Map<string, number>>(new Map());
  const attemptCloseTimersRef = useRef<Map<string, number>>(new Map());
  const deferredSearchTerm = useDeferredValue(searchTerm.trim().toLowerCase());

  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  useEffect(() => {
    const now = Date.now();
    const nextState: Record<string, DownloadRefreshRuntimeState> = {};

    for (const download of downloads) {
      const previous = refreshStateRef.current[download.id];
      const observedAt = now;
      const lastProgressAt =
        previous && download.progress <= previous.lastProgressValue
          ? previous.lastProgressAt
          : observedAt;
      const lastNonZeroSpeedAt =
        previous && isZeroLikeSpeed(download.speed)
          ? previous.lastNonZeroSpeedAt
          : observedAt;

      nextState[download.id] = {
        lastObservedAt: observedAt,
        lastProgressValue: download.progress,
        lastProgressAt,
        lastNonZeroSpeedAt,
        autoRefreshCount: previous?.autoRefreshCount ?? 0,
        refreshInFlight:
          previous?.refreshInFlight === true &&
          download.status !== "paused" &&
          download.status !== "error",
        lastRefreshAt: previous?.lastRefreshAt,
      };
    }

    refreshStateRef.current = nextState;
  }, [downloads]);

  const beginAttemptSession = useCallback((title: string, url: string) => {
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setAttemptSessions((prev) => ({
      ...prev,
      [sessionId]: {
        id: sessionId,
        title,
        url,
        status: "running",
        steps: [],
        updatedAt: Date.now(),
      },
    }));
    setActiveAttemptId(sessionId);
    return sessionId;
  }, []);

  const pushAttemptStep = useCallback(
    (
      sessionId: string,
      stepId: string,
      label: string,
      status: AttemptStep["status"],
      detail?: string
    ) => {
      setAttemptSessions((prev) => {
        const current = prev[sessionId];
        if (!current) return prev;
        const nextStep: AttemptStep = {
          stepId,
          label,
          status,
          detail,
          updatedAt: Date.now(),
        };
        const existingIndex = current.steps.findIndex((step) => step.stepId === stepId);
        const nextSteps =
          existingIndex >= 0
            ? current.steps.map((step, index) => (index === existingIndex ? nextStep : step))
            : [...current.steps, nextStep];
        return {
          ...prev,
          [sessionId]: {
            ...current,
            status:
              status === "failed"
                ? "failed"
                : current.status === "failed"
                  ? current.status
                  : "running",
            steps: nextSteps,
            updatedAt: Date.now(),
          },
        };
      });
    },
    []
  );

  const finalizeAttemptSession = useCallback(
    (sessionId: string, status: AttemptSession["status"], summary?: string, autoCloseMs?: number) => {
      setAttemptSessions((prev) => {
        const current = prev[sessionId];
        if (!current) return prev;
        return {
          ...prev,
          [sessionId]: {
            ...current,
            status,
            summary: summary ?? current.summary,
            updatedAt: Date.now(),
          },
        };
      });

      const existing = attemptCloseTimersRef.current.get(sessionId);
      if (existing) {
        window.clearTimeout(existing);
        attemptCloseTimersRef.current.delete(sessionId);
      }

      if (autoCloseMs) {
        const timer = window.setTimeout(() => {
          setActiveAttemptId((current) => (current === sessionId ? null : current));
          attemptCloseTimersRef.current.delete(sessionId);
        }, autoCloseMs);
        attemptCloseTimersRef.current.set(sessionId, timer);
      }
    },
    []
  );

  const closeAttemptDialog = useCallback(() => {
    if (!activeAttemptId) return;
    const timer = attemptCloseTimersRef.current.get(activeAttemptId);
    if (timer) {
      window.clearTimeout(timer);
      attemptCloseTimersRef.current.delete(activeAttemptId);
    }
    setActiveAttemptId(null);
  }, [activeAttemptId]);

  useEffect(() => {
    installConsoleDiagnostics();
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of attemptCloseTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      attemptCloseTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((settings) => {
        setAppSettings(settings);
        setMaxThreads(settings.max_threads || DEFAULT_THREAD_COUNT);
        const enabled = !!settings.developer_mode;
        setDeveloperModeEnabled(enabled);
        setShowWelcomeSetup(!settings.onboarding_completed);
        if (!enabled) {
          setShowCaptureDebug(false);
        }
      })
      .catch(console.error);
  }, [isSettingsOpen]);

  const refreshExtensionHealth = useCallback(async (messageOnRefresh?: string) => {
    try {
      const health = await invoke<ExtensionHealth>("get_extension_health");
      setExtensionHealth(health);
      if (messageOnRefresh) {
        setExtensionStatusMessage(messageOnRefresh);
        window.setTimeout(() => setExtensionStatusMessage(""), 1800);
      }
      return health;
    } catch (error) {
      console.error("Failed to fetch extension health", error);
      setExtensionStatusMessage("Extension status check failed");
      window.setTimeout(() => setExtensionStatusMessage(""), 2200);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshExtensionHealth().catch(console.error);
  }, [refreshExtensionHealth]);

  useEffect(() => {
    if (!appSettings?.auto_check_tool_updates) return;
    const timer = window.setTimeout(() => {
      invoke<ToolingStatusResponse>("get_tooling_status", { includeRemote: true })
        .then((status) => {
          if (status.ytdlp.update_available) {
            setDiagnosticStatus("yt-dlp update available in Settings");
            window.setTimeout(() => setDiagnosticStatus(""), 3000);
          }
        })
        .catch((error) => {
          console.error("Delayed tool update check failed", error);
        });
    }, 12000);

    return () => window.clearTimeout(timer);
  }, [appSettings?.auto_check_tool_updates]);

  useEffect(() => {
    try {
      const finishedRaw = localStorage.getItem(FINISHED_STORAGE_KEY);
      const resumableRaw = localStorage.getItem(RESUME_STORAGE_KEY);
      const attemptsRaw = localStorage.getItem(ATTEMPT_HISTORY_STORAGE_KEY);

      const restoredFinished: DownloadItem[] = finishedRaw
        ? (JSON.parse(finishedRaw) as PersistedFinishedDownload[])
            .filter(item => isWithinTenDays(item.completed_at))
            .map(item => ({
              id: item.id,
              title: item.title,
              url: item.url,
              output_path: item.output_path,
              total_size: item.total_size,
              progress: 100,
              speed: "0 B/s",
              stream_speed_factor: undefined,
              indeterminate_progress: false,
              eta: "Finished",
              status: "finished" as const,
              segments: [],
              category: item.category || inferCategory(item.title || item.url),
              completed_at: item.completed_at,
              recovered: false,
              download_strategy: item.download_strategy,
              attempt_session_id: item.attempt_session_id,
              download_origin: item.download_origin,
              browser_source: item.browser_source,
              browser_confidence: item.browser_confidence,
              browser_request_id: item.browser_request_id,
              original_url: item.original_url,
              referrer: item.referrer,
              quality_label: item.quality_label,
              bitrate_kbps: item.bitrate_kbps,
            }))
        : [];

      // Restore interrupted jobs as paused so user can safely resume from partials.
      const restoredResumables: DownloadItem[] = resumableRaw
        ? (JSON.parse(resumableRaw) as PersistedResumableDownload[])
            .filter(item => isWithinTenDays(item.saved_at || item.completed_at))
            .map(item => ({
              id: item.id,
              title: item.title,
              url: item.url,
              audio_url: item.audio_url,
              output_path: item.output_path,
              total_size: item.total_size,
              audio_size: item.audio_size,
              headers: item.headers,
              audio_headers: item.audio_headers,
              progress: Math.max(0, Math.min(99, item.progress || 0)),
              speed: "Recovered",
              stream_speed_factor: undefined,
              indeterminate_progress: false,
              eta: "Ready to resume",
              status: "paused" as const,
              segments: createIdleSegments(maxThreads),
              category: item.category || inferCategory(item.title || item.url),
              completed_at: item.completed_at,
              recovered: true,
              download_strategy: item.download_strategy,
              attempt_session_id: item.attempt_session_id,
              download_origin: item.download_origin,
              browser_source: item.browser_source,
              browser_confidence: item.browser_confidence,
              browser_request_id: item.browser_request_id,
              original_url: item.original_url,
              referrer: item.referrer,
              quality_label: item.quality_label,
              bitrate_kbps: item.bitrate_kbps,
            }))
        : [];

      const restoredAttempts = attemptsRaw
        ? (JSON.parse(attemptsRaw) as Record<string, AttemptSession>)
        : {};

      const merged: DownloadItem[] = [...restoredFinished];
      for (const resumable of restoredResumables) {
        if (!merged.some(item => item.id === resumable.id)) {
          merged.push(resumable);
        }
      }

      setDownloads(merged);
      setAttemptSessions(restoredAttempts);
    } catch (error) {
      console.error("Failed to restore downloads from persistence", error);
    } finally {
      setHydrated(true);
    }

    const unlistenMedia = listen<any>("media_detected", (event) => {
      const capture = event.payload;
      const url = typeof capture === 'string' ? capture : capture.url;
      setInitialHeaders(undefined);
      setInitialUrl(url);
      setInitialAttemptSessionId(undefined);
      setInitialDownloadContext(undefined);
      setAddUrlLaunchSource("media_detected");
      setIsAddUrlOpen(true);
    });
    const unlistenExternal = listen<ExternalDownloadRequest>("external_download_request", async (event) => {
      const payload = event.payload;
      const requestId = payload.request_id;
      let ackSent = false;
      const ackRequest = async (
        accepted: boolean,
        message: string,
        routeClass?: BrowserRouteClass
      ) => {
        if (!requestId || ackSent) return;
        ackSent = true;
        try {
          await invoke("ack_external_capture_request", {
            requestId,
            accepted,
            message,
            routeClass,
          });
        } catch (ackError) {
          console.error("Failed to acknowledge external capture request", ackError);
        }
      };
      const captureType = inferCaptureType(payload);
      const rawHttpMediaUrl = isHttpUrl(payload.raw_media_url) ? payload.raw_media_url! : null;
      const referrerUrl = payload.referrer || "";
      const payloadUrl = payload.url || "";
      const isLikelyDirectFromUrlMismatch =
        isHttpUrl(payloadUrl) &&
        isHttpUrl(referrerUrl) &&
        normalizeComparableUrl(payloadUrl) !== normalizeComparableUrl(referrerUrl);
      const preferredManifestUrl =
        (isManifestLikeUrl(payloadUrl) && payloadUrl) ||
        (isManifestLikeUrl(rawHttpMediaUrl || undefined) ? rawHttpMediaUrl : null);
      const scanDirectCandidateUrl =
        preferredManifestUrl ||
        rawHttpMediaUrl ||
        (isLikelyDirectFromUrlMismatch ? payloadUrl : null);
      const effectiveUrl = preferredManifestUrl || scanDirectCandidateUrl || payload.url;
      const browserConfidence = pickBrowserConfidence(
        payload,
        effectiveUrl || "",
        preferredManifestUrl,
        referrerUrl
      );
      const recordCapture = (decision: CaptureDecision) => {
        setCaptureDebugEntries((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            at: Date.now(),
            source: payload?.source || "unknown",
            captureType,
            decision,
            url: effectiveUrl || "",
            headers: payload?.headers,
          },
          ...prev,
        ].slice(0, 40));
      };

      if (!effectiveUrl?.startsWith("http")) {
        recordCapture("ignored_invalid_url");
        await ackRequest(false, "Invalid capture URL", "rejected_invalid_url");
        return;
      }

      const dedupeKey = captureDedupeKey(effectiveUrl, payload.source);
      const now = Date.now();
      for (const [key, ts] of recentAutoCapturesRef.current.entries()) {
        if (now - ts > AUTO_CAPTURE_DEDUPE_WINDOW_MS) {
          recentAutoCapturesRef.current.delete(key);
        }
      }
      const seenAt = recentAutoCapturesRef.current.get(dedupeKey);
      if (seenAt && now - seenAt < AUTO_CAPTURE_DEDUPE_WINDOW_MS) {
        recordCapture("ignored_duplicate");
        await ackRequest(false, "Duplicate capture ignored", "rejected_duplicate");
        return;
      }

      const hasActiveSameUrl = downloadsRef.current.some((d) => {
        if (!(d.status === "active" || d.status === "paused" || d.status === "processing")) {
          return false;
        }
        return normalizeComparableUrl(d.url) === normalizeComparableUrl(effectiveUrl);
      });
      if (hasActiveSameUrl) {
        recentAutoCapturesRef.current.set(dedupeKey, now);
        recordCapture("ignored_duplicate");
        await ackRequest(false, "Matching active download already exists", "rejected_duplicate");
        return;
      }

      try {
        const settings = await invoke<AppSettings>("get_settings");
        if (!settings.accept_browser_download_requests) {
          recordCapture("ignored_by_setting");
          await ackRequest(false, "Browser captures disabled in app settings", "rejected_disabled");
          return;
        }
        const sessionTitle =
          payload.filename ||
          extractFilenameFromUrl(effectiveUrl) ||
          extractFilenameFromUrl(payload.original_url || payload.url) ||
          "browser_capture";
        const attemptSessionId = beginAttemptSession(sessionTitle, effectiveUrl);
        pushAttemptStep(
          attemptSessionId,
          "browser_handoff_received",
          "Receive browser handoff",
          "succeeded",
          `${payload.source || "unknown"} | confidence=${browserConfidence}`
        );

        const baseContext: BrowserDownloadContext = {
          downloadOrigin: "browser_takeover",
          browserSource: payload.source,
          browserConfidence,
          browserRequestId: requestId,
          originalUrl: payload.original_url || payload.url,
          referrer: payload.referrer,
        };
        const openMetadataModal = (
          modalUrl: string,
          routeClass: BrowserRouteClass = "confirm_start"
        ) => {
          setInitialHeaders(isYouTubePageUrl(modalUrl) ? undefined : payload.headers);
          setInitialUrl(modalUrl);
          setInitialAttemptSessionId(attemptSessionId);
          setInitialDownloadContext({
            ...baseContext,
            routeClass,
            strategyHint:
              browserConfidence === "strong_manifest"
                ? preferredManifestUrl?.toLowerCase().includes(".mpd")
                  ? "dash_manifest"
                  : "hls_manifest"
                : undefined,
          });
          setAddUrlLaunchSource("browser_capture");
          setIsAddUrlOpen(true);
          pushAttemptStep(
            attemptSessionId,
            "route_selected",
            "Select browser takeover route",
            "succeeded",
            routeClass
          );
          recordCapture("opened_metadata_modal");
        };

        const shouldPreferPicker =
          shouldOpenPickerForBrowserCapture({
            source: payload.source,
            browserConfidence,
            scanCaptureMode: payload.scan_capture_mode,
            scanAutoOpenQualityPicker: payload.scan_auto_open_quality_picker,
          });

        const autoStart = async (
          routeClass: BrowserRouteClass,
          strategyHint: NonNullable<BrowserDownloadContext["strategyHint"]>
        ) => {
          pushAttemptStep(
            attemptSessionId,
            "route_selected",
            "Select browser takeover route",
            "succeeded",
            routeClass
          );
          const queued = await handleAddDownload(
            effectiveUrl,
            settings.default_download_path,
            payload.filename || undefined,
            undefined,
            payload.headers,
            undefined,
            undefined,
            undefined,
            attemptSessionId,
            undefined,
            {
              ...baseContext,
              routeClass,
              strategyHint,
            }
          );
          if (!queued) {
            openMetadataModal(effectiveUrl, "confirm_start");
            await ackRequest(
              true,
              "Direct auto-start failed. Review and start from VelocityDL.",
              "confirm_start"
            );
            return;
          }
          if (
            shouldRevealAppForBrowserHandoff({
              source: payload.source,
              routeClass,
            })
          ) {
            invoke("reveal_main_window").catch((error) => {
              console.error("Failed to reveal main window for browser handoff", error);
            });
          }
          recentAutoCapturesRef.current.set(dedupeKey, now);
          recordCapture(
            routeClass === "auto_start_manifest"
              ? "auto_started_manifest"
              : "auto_started_direct"
          );
          await ackRequest(true, "Download started in VelocityDL.", routeClass);
        };

        if (browserConfidence === "strong_direct") {
          if (shouldPreferPicker) {
            openMetadataModal(referrerUrl || payload.original_url || payload.url, "confirm_start");
            recentAutoCapturesRef.current.set(dedupeKey, now);
            await ackRequest(
              true,
              "Capture received. Review quality in VelocityDL before starting.",
              "confirm_start"
            );
            return;
          }
          await autoStart("auto_start_direct", "direct_file");
          return;
        }

        if (browserConfidence === "strong_manifest") {
          const strategyHint =
            preferredManifestUrl?.toLowerCase().includes(".mpd") ? "dash_manifest" : "hls_manifest";
          await autoStart("auto_start_manifest", strategyHint);
          return;
        }

        if (browserConfidence === "ambiguous_media") {
          openMetadataModal(referrerUrl || effectiveUrl, "confirm_start");
          recentAutoCapturesRef.current.set(dedupeKey, now);
          await ackRequest(true, "Capture received. Start Download in VelocityDL to continue.", "confirm_start");
          return;
        }

        openMetadataModal(scanDirectCandidateUrl || payload.url, "confirm_start");
        recentAutoCapturesRef.current.set(dedupeKey, now);
        await ackRequest(true, "Capture received. Start Download in VelocityDL to continue.", "confirm_start");
      } catch (e) {
        console.error("Failed to process browser extension capture", e);
        recordCapture("capture_processing_failed");
        await ackRequest(false, "App capture processing failed", "capture_processing_failed");
      }
    });

    const unlistenProgress = listen<any>("download_progress", (event) => {
      setDownloads(prev => prev.map(d => {
        if (d.id !== event.payload.id) return d;
        const next = { ...d, ...event.payload } as DownloadItem;
        if (next.status !== 'paused' && next.recovered) {
          next.recovered = false;
        }
        if (event.payload.status === 'finished' && !next.completed_at) {
          next.completed_at = Date.now();
          if (!next.category) {
            next.category = inferCategory(next.title || next.url);
          }
        }
        return next;
      }));
    });
    const unlistenAttempt = listen<DownloadAttemptEvent>("download_attempt", (event) => {
      const payload = event.payload;
      setAttemptSessions((prev) => {
        const current = prev[payload.session_id];
        if (!current) return prev;
        const existingIndex = current.steps.findIndex((step) => step.stepId === payload.step_id);
        const nextStep: AttemptStep = {
          stepId: payload.step_id,
          label: payload.label,
          status: payload.status,
          detail: payload.detail,
          updatedAt: Date.now(),
        };
        const nextSteps =
          existingIndex >= 0
            ? current.steps.map((step, index) => (index === existingIndex ? nextStep : step))
            : [...current.steps, nextStep];
        return {
          ...prev,
          [payload.session_id]: {
            ...current,
            status:
              payload.status === "failed"
                ? "failed"
                : current.status === "failed"
                  ? current.status
                  : "running",
            steps: nextSteps,
            updatedAt: Date.now(),
          },
        };
      });
    });
    const unlistenExtensionHealth = listen<ExtensionHealthEvent>("extension_health_changed", (event) => {
      setExtensionHealth((prev) => {
        if (!prev) {
          return {
            install_url: "https://github.com/notvikke/velocity-dl/tree/main/chromium-extension",
            setup_url: "https://github.com/notvikke/velocity-dl/blob/main/BROWSER_INTEGRATION_SETUP.md",
            status: "connected",
            status_label: "Extension Connected",
            last_heartbeat_at_ms: event.payload.heartbeat_at_ms,
            last_seen_browser: event.payload.browser,
            last_seen_extension_version: event.payload.extension_version,
            last_seen_runtime_id: event.payload.runtime_id,
          };
        }
        return {
          ...prev,
          status: "connected",
          status_label: "Extension Connected",
          last_heartbeat_at_ms: event.payload.heartbeat_at_ms,
          last_seen_browser: event.payload.browser || prev.last_seen_browser,
          last_seen_extension_version:
            event.payload.extension_version || prev.last_seen_extension_version,
          last_seen_runtime_id: event.payload.runtime_id || prev.last_seen_runtime_id,
        };
      });
    });
    invoke("set_external_capture_listener_ready").catch(console.error);

    return () => {
      unlistenMedia.then(f => f());
      unlistenExternal.then(f => f());
      unlistenProgress.then(f => f());
      unlistenAttempt.then(f => f());
      unlistenExtensionHealth.then(f => f());
    };
  }, [maxThreads]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const finishedToPersist: PersistedFinishedDownload[] = downloads
        .filter(d => d.status === "finished" && isWithinTenDays(d.completed_at))
        .map(d => ({
          id: d.id,
          title: d.title,
          url: d.url,
          output_path: d.output_path,
          total_size: d.total_size,
          category: d.category || inferCategory(d.title || d.url),
          completed_at: d.completed_at as number,
          download_strategy: d.download_strategy,
          attempt_session_id: d.attempt_session_id,
          download_origin: d.download_origin,
          browser_source: d.browser_source,
          browser_confidence: d.browser_confidence,
          browser_request_id: d.browser_request_id,
          original_url: d.original_url,
          referrer: d.referrer,
          quality_label: d.quality_label,
          bitrate_kbps: d.bitrate_kbps,
        }));
      localStorage.setItem(FINISHED_STORAGE_KEY, JSON.stringify(finishedToPersist));

      const resumableToPersist: PersistedResumableDownload[] = downloads
        .filter(d =>
          d.status === "paused" || d.status === "active" || d.status === "processing"
        )
        .map(d => ({
          id: d.id,
          title: d.title,
          url: d.url,
          audio_url: d.audio_url,
          output_path: d.output_path,
          total_size: d.total_size,
          audio_size: d.audio_size,
          headers: d.headers,
          audio_headers: d.audio_headers,
          download_strategy: d.download_strategy,
          category: d.category || inferCategory(d.title || d.url),
          progress: d.progress || 0,
          status: d.status === "paused" ? "paused" : "active",
          completed_at: d.completed_at,
          saved_at: Date.now(),
          attempt_session_id: d.attempt_session_id,
          download_origin: d.download_origin,
          browser_source: d.browser_source,
          browser_confidence: d.browser_confidence,
          browser_request_id: d.browser_request_id,
          original_url: d.original_url,
          referrer: d.referrer,
          quality_label: d.quality_label,
          bitrate_kbps: d.bitrate_kbps,
        }));
      localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(resumableToPersist));
      localStorage.setItem(ATTEMPT_HISTORY_STORAGE_KEY, JSON.stringify(attemptSessions));
    } catch (error) {
      console.error("Failed to persist downloads", error);
    }
  }, [downloads, hydrated, attemptSessions]);

  useEffect(() => {
    setDownloads((prev) =>
      prev.map((download) =>
        download.recovered
          ? { ...download, segments: createIdleSegments(maxThreads) }
          : download
      )
    );
  }, [maxThreads]);

  const handleAddDownload = useCallback(async (
    url: string, 
    path: string, 
    title?: string, 
    size?: number, 
    headers?: Record<string, string>,
    audioUrl?: string,
    audioSize?: number,
    audioHeaders?: Record<string, string>,
    attemptSessionId?: string,
    qualityMetadata?: DownloadQualityBadgeInput,
    downloadContext?: BrowserDownloadContext
  ) => {
    const sessionId = attemptSessionId || beginAttemptSession(title || "Preparing download", url);
    try {
      const newDownload = await invoke<DownloadItem>("add_download", { 
        url, 
        audioUrl,
        outputPath: path,
        title,
        totalSize: size,
        audioSize,
        headers,
        audioHeaders,
        attemptSessionId: sessionId,
        strategyHint: downloadContext?.strategyHint,
        downloadOrigin: downloadContext?.downloadOrigin,
        browserSource: downloadContext?.browserSource,
        browserConfidence: downloadContext?.browserConfidence,
        browserRequestId: downloadContext?.browserRequestId,
        originalUrl: downloadContext?.originalUrl,
        referrer: downloadContext?.referrer,
      });
      newDownload.category = inferCategory(title || url);
      newDownload.segments = createIdleSegments(maxThreads);
      newDownload.attempt_session_id = sessionId;
      newDownload.download_origin = downloadContext?.downloadOrigin;
      newDownload.browser_source = downloadContext?.browserSource;
      newDownload.browser_confidence = downloadContext?.browserConfidence;
      newDownload.browser_request_id = downloadContext?.browserRequestId;
      newDownload.original_url = downloadContext?.originalUrl;
      newDownload.referrer = downloadContext?.referrer;
      newDownload.quality_label = qualityMetadata?.qualityLabel;
      newDownload.bitrate_kbps = qualityMetadata?.bitrateKbps;
      setDownloads(prev => [...prev, newDownload]);
      finalizeAttemptSession(sessionId, "succeeded", `Queued ${newDownload.title}`, 1400);
      return true;
    } catch (error) {
      console.error("Failed to add download:", error);
      const message = error instanceof Error ? error.message : String(error);
      finalizeAttemptSession(sessionId, "failed", message);
      return false;
    }
  }, [beginAttemptSession, finalizeAttemptSession, maxThreads]);

  const handlePause = useCallback(async (id: string) => {
    try {
      await invoke("pause_download", { id });
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'paused', speed: '0 B/s' } : d));
    } catch (e) { console.error(e); }
  }, []);

  const resumeDownloadFromSnapshot = useCallback(async (
    paused: DownloadItem,
    attemptTitle: string
  ) => {
    let attemptSessionId: string | null = null;
    try {
      attemptSessionId = beginAttemptSession(paused.title || attemptTitle, paused.url);

      const restarted = await invoke<DownloadItem>("add_download", {
        existingId: paused.id,
        url: paused.url,
        audioUrl: paused.audio_url ?? null,
        outputPath: paused.output_path,
        title: paused.title,
        totalSize: paused.total_size,
        audioSize: paused.audio_size ?? null,
        headers: paused.headers ?? null,
        audioHeaders: paused.audio_headers ?? null,
        attemptSessionId,
        strategyHint: paused.download_strategy ?? null,
        downloadOrigin: paused.download_origin ?? null,
        browserSource: paused.browser_source ?? null,
        browserConfidence: paused.browser_confidence ?? null,
        browserRequestId: paused.browser_request_id ?? null,
        originalUrl: paused.original_url ?? null,
        referrer: paused.referrer ?? null,
      });

      restarted.category = paused.category || inferCategory(paused.title || paused.url);
      restarted.segments = paused.segments?.length ? paused.segments : createIdleSegments(maxThreads);
      restarted.attempt_session_id = attemptSessionId;
      restarted.download_origin = paused.download_origin;
      restarted.browser_source = paused.browser_source;
      restarted.browser_confidence = paused.browser_confidence;
      restarted.browser_request_id = paused.browser_request_id;
      restarted.original_url = paused.original_url;
      restarted.referrer = paused.referrer;
      restarted.quality_label = paused.quality_label;
      restarted.bitrate_kbps = paused.bitrate_kbps;
      setDownloads(prev => prev.map(d => d.id === paused.id ? { ...d, ...restarted, status: 'active', progress: d.progress, recovered: false } : d));
      finalizeAttemptSession(attemptSessionId, "succeeded", `Queued ${restarted.title}`, 1400);
      return true;
    } catch (e) {
      console.error(e);
      if (attemptSessionId) {
        const message = e instanceof Error ? e.message : String(e);
        finalizeAttemptSession(attemptSessionId, "failed", message);
      }
      return false;
    }
  }, [beginAttemptSession, finalizeAttemptSession, maxThreads]);

  const handleResume = useCallback(async (id: string) => {
    const paused = downloadsRef.current.find(d => d.id === id);
    if (!paused) return;
    await resumeDownloadFromSnapshot(paused, "Resume download");
  }, [resumeDownloadFromSnapshot]);

  const handleRefreshDownload = useCallback(async (id: string, automatic = false) => {
    const target = downloadsRef.current.find(d => d.id === id);
    if (!target || (target.status !== "active" && target.status !== "paused")) {
      return;
    }

    const previous = refreshStateRef.current[id];
    if (previous?.refreshInFlight) {
      return;
    }

    const now = Date.now();
    refreshStateRef.current[id] = {
      lastObservedAt: now,
      lastProgressValue: target.progress,
      lastProgressAt: now,
      lastNonZeroSpeedAt: now,
      autoRefreshCount: automatic ? (previous?.autoRefreshCount ?? 0) + 1 : (previous?.autoRefreshCount ?? 0),
      refreshInFlight: true,
      lastRefreshAt: now,
    };

    if (automatic) {
      setDiagnosticStatus(`Refreshing stalled download: ${target.title}`);
    }

    try {
      if (target.status === "active") {
        await invoke("pause_download", { id });
        setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: "paused", speed: "0 B/s" } : d));
        await new Promise((resolve) => window.setTimeout(resolve, REFRESH_RESUME_DELAY_MS));
      }

      await resumeDownloadFromSnapshot(
        { ...target, status: "paused", speed: "0 B/s" },
        automatic ? "Auto-refresh stalled download" : "Refresh download"
      );
    } catch (error) {
      console.error("Failed to refresh download", error);
    } finally {
      const latest = refreshStateRef.current[id];
      if (latest) {
        refreshStateRef.current[id] = {
          ...latest,
          refreshInFlight: false,
          lastObservedAt: Date.now(),
          lastProgressAt: Date.now(),
          lastNonZeroSpeedAt: Date.now(),
        };
      }
      if (automatic) {
        window.setTimeout(() => setDiagnosticStatus(""), 1800);
      }
    }
  }, [resumeDownloadFromSnapshot]);

  const handleOpenFolder = useCallback(async (id: string) => {
    const download = downloads.find(d => d.id === id);
    if (download) {
      try {
        const basePath = download.output_path.replace(/[\\/]+$/, "");
        const sep = basePath.includes("\\") ? "\\" : "/";
        const fullPath = `${basePath}${sep}${download.title}`;
        await invoke("open_folder", { path: fullPath });
      } catch (e) { console.error(e); }
    }
  }, [downloads]);

  const handleDelete = useCallback((id: string) => {
    const target = downloadsRef.current.find(d => d.id === id);
    if (!target) return;
    setDeleteDialog({
      id: target.id,
      title: target.title,
      output_path: target.output_path,
      audio_url: target.audio_url,
      status: target.status,
    });
    setDeleteFromDisk(false);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    if (deleteBusy) return;
    setDeleteDialog(null);
    setDeleteFromDisk(false);
  }, [deleteBusy]);

  const confirmDelete = useCallback(async () => {
    if (!deleteDialog) return;
    const id = deleteDialog.id;
    const target = downloads.find(d => d.id === id);
    if (target && (target.status === "active" || target.status === "paused" || target.status === "processing")) {
      try {
        await invoke("pause_download", { id });
      } catch (e) {
        console.error("Failed to stop download before removing", e);
      }
    }
    setDeleteBusy(true);
    try {
      if (deleteFromDisk) {
        await invoke("delete_download_artifacts", {
          outputPath: deleteDialog.output_path,
          title: deleteDialog.title,
          hasAudioTrack: !!deleteDialog.audio_url,
        });
      }
    if (target?.attempt_session_id) {
      setAttemptSessions(prev => {
        const next = { ...prev };
        delete next[target.attempt_session_id as string];
        return next;
      });
    }
    setDownloads(prev => prev.filter(d => d.id !== id));
      setDeleteDialog(null);
      setDeleteFromDisk(false);
    } catch (error) {
      console.error("Failed to delete download", error);
      setDiagnosticStatus("Failed to remove download files");
      window.setTimeout(() => setDiagnosticStatus(""), 2200);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteDialog, deleteFromDisk, downloads]);

  const handleShowAttemptDetails = useCallback((sessionId?: string) => {
    if (!sessionId) return;
    setActiveAttemptId(sessionId);
  }, []);

  const clearFinished = useCallback(() => {
    setDownloads(prev => {
      const finishedSessionIds = prev
        .filter(d => d.status === 'finished')
        .map(d => d.attempt_session_id)
        .filter((id): id is string => !!id);

      if (finishedSessionIds.length) {
        setAttemptSessions(current => {
          const next = { ...current };
          for (const sessionId of finishedSessionIds) {
            delete next[sessionId];
          }
          return next;
        });
      }

      return prev.filter(d => d.status !== 'finished');
    });
  }, []);

  const handleCopyDiagnostics = useCallback(async (context?: string) => {
    try {
      await copyAppDiagnosticsToClipboard(context);
      setDiagnosticStatus("Diagnostics copied");
      window.setTimeout(() => setDiagnosticStatus(""), 1800);
    } catch (error) {
      console.error("Failed to copy diagnostics", error);
      setDiagnosticStatus("Failed to copy diagnostics");
      window.setTimeout(() => setDiagnosticStatus(""), 2200);
    }
  }, []);

  const handleSaveAppSettings = useCallback(async (settings: AppSettings) => {
    await invoke("save_settings", { settings });
    setAppSettings(settings);
    setMaxThreads(settings.max_threads || DEFAULT_THREAD_COUNT);
    setDeveloperModeEnabled(!!settings.developer_mode);
    if (!settings.developer_mode) {
      setShowCaptureDebug(false);
    }
    setShowWelcomeSetup(!settings.onboarding_completed);
  }, []);

  const handleOpenExtensionLink = useCallback(async (kind: "install" | "setup") => {
    const health = extensionHealth ?? (await refreshExtensionHealth());
    if (!health) return;
    if (kind === "install") {
      setIsExtensionSetupOpen(true);
      return;
    }
    const url = health.setup_url;
    try {
      await invoke("open_extension_setup_link", { url });
    } catch (error) {
      console.error("Failed to open extension link", error);
      setExtensionStatusMessage("Failed to open extension link");
      window.setTimeout(() => setExtensionStatusMessage(""), 2200);
    }
  }, [extensionHealth, refreshExtensionHealth]);

  const handleCheckExtension = useCallback(async () => {
    const health = await refreshExtensionHealth();
    if (!health) return;
    const label =
      health.status === "connected"
        ? "Extension connected"
        : health.status === "stale"
          ? "Extension seen recently"
          : "Extension not detected";
    setExtensionStatusMessage(label);
    window.setTimeout(() => setExtensionStatusMessage(""), 2200);
  }, [refreshExtensionHealth]);

  useEffect(() => {
    if (!hydrated) return;

    const timer = window.setInterval(() => {
      const now = Date.now();
      const stalled = downloadsRef.current.find((download) =>
        shouldAutoRefreshDownload(download, refreshStateRef.current[download.id], now)
      );
      if (!stalled) return;
      void handleRefreshDownload(stalled.id, true);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [handleRefreshDownload, hydrated]);

  const filteredDownloads = useMemo(() => {
    const normalizedSearch = deferredSearchTerm;

    return downloads.filter(d => {
      const matchesTab = activeTab === "active"
        ? ACTIVE_DOWNLOAD_STATUSES.includes(d.status)
        : activeTab === "finished"
        ? d.status === "finished" && isWithinTenDays(d.completed_at)
        : d.status === activeTab;
      const matchesCategory =
        activeCategory === "all" ||
        (activeCategory === "file" ? isDocumentBucketCategory(d.category) : d.category === activeCategory);
      const matchesSearch =
        !normalizedSearch ||
        d.title.toLowerCase().includes(normalizedSearch) ||
        d.url.toLowerCase().includes(normalizedSearch);
      return matchesTab && matchesCategory && matchesSearch;
    });
  }, [downloads, activeTab, activeCategory, deferredSearchTerm]);

  const downloadStats = useMemo(() => {
    return downloads.reduce(
      (acc, download) => {
        if (ACTIVE_DOWNLOAD_STATUSES.includes(download.status)) {
          acc.activeCount += 1;
        }
        if (RUNNING_DOWNLOAD_STATUSES.includes(download.status)) {
          acc.runningCount += 1;
          acc.totalSpeedBytes += parseSpeedToBytes(download.speed);
        }
        if (download.status === "finished" && isWithinTenDays(download.completed_at)) {
          acc.finishedCount += 1;
        }
        return acc;
      },
      { activeCount: 0, runningCount: 0, finishedCount: 0, totalSpeedBytes: 0 }
    );
  }, [downloads]);
  const activeAttemptSession = activeAttemptId ? attemptSessions[activeAttemptId] ?? null : null;

  return (
    <div className="flex h-screen bg-background text-white select-none overflow-hidden font-sans text-[13px] border border-border">
      {/* Modals */}
      <DownloadAttemptDialog session={activeAttemptSession} onClose={closeAttemptDialog} />
      {deleteDialog && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close delete dialog"
            onClick={closeDeleteDialog}
            className="absolute inset-0 bg-black/65 backdrop-blur-sm"
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface shadow-2xl">
            <div className="border-b border-border px-5 py-4">
              <div className="text-sm font-semibold text-gray-100">Remove Download</div>
              <div className="mt-1 truncate text-xs text-gray-400">{deleteDialog.title}</div>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="text-sm leading-6 text-gray-300">
                Remove this item from VelocityDL. You can also delete the downloaded file and known temporary parts from disk.
              </div>
              <label className="flex items-start gap-3 rounded border border-border bg-background/40 px-3 py-3 text-sm text-gray-200">
                <input
                  type="checkbox"
                  checked={deleteFromDisk}
                  onChange={(e) => setDeleteFromDisk(e.target.checked)}
                  className="mt-0.5"
                  disabled={deleteBusy}
                />
                <span>
                  Delete downloaded file from disk too
                  <span className="mt-1 block text-[11px] text-gray-500">
                    This also removes known VelocityDL temporary parts for this item when present.
                  </span>
                </span>
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <button
                type="button"
                onClick={closeDeleteDialog}
                className="rounded border border-border px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
                disabled={deleteBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="rounded bg-error/90 px-3 py-1.5 text-sm text-white hover:bg-error"
                disabled={deleteBusy}
              >
                {deleteBusy ? "Removing..." : deleteFromDisk ? "Delete From Disk" : "Remove From List"}
              </button>
            </div>
          </div>
        </div>
      )}
      {isAddUrlOpen && (
        <Suspense fallback={null}>
          <AddUrlModal 
            isOpen={isAddUrlOpen} 
            initialUrl={initialUrl}
            initialHeaders={initialHeaders}
            initialAttemptSessionId={initialAttemptSessionId}
            initialDownloadContext={initialDownloadContext}
            launchSource={addUrlLaunchSource}
            onAttemptStart={beginAttemptSession}
            onAttemptFinish={finalizeAttemptSession}
            onClose={() => {
              setIsAddUrlOpen(false);
              setInitialUrl("");
              setInitialHeaders(undefined);
              setInitialAttemptSessionId(undefined);
              setInitialDownloadContext(undefined);
              setAddUrlLaunchSource("manual");
            }}
            onAdd={handleAddDownload}
          />
        </Suspense>
      )}
      {isSettingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal 
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
          />
        </Suspense>
      )}
      {isExtensionSetupOpen && (
        <Suspense fallback={null}>
          <ExtensionSetupModal
            isOpen={isExtensionSetupOpen}
            initialChromeId={
              extensionHealth?.last_seen_browser?.toLowerCase().includes("chrome")
                ? extensionHealth.last_seen_runtime_id
                : undefined
            }
            initialEdgeId={
              extensionHealth?.last_seen_browser?.toLowerCase().includes("edge")
                ? extensionHealth.last_seen_runtime_id
                : undefined
            }
            onClose={() => setIsExtensionSetupOpen(false)}
            onInstalled={async () => {
              await refreshExtensionHealth("Browser integration installed");
            }}
          />
        </Suspense>
      )}
      <WelcomeSetupModal
        isOpen={showWelcomeSetup}
        initialSettings={appSettings}
        onSave={handleSaveAppSettings}
      />

      {/* Sidebar */}
      <div className="w-56 bg-surface border-r border-border flex flex-col pt-4 relative">
        <div data-tauri-drag-region className="absolute inset-0 z-0 h-14" />
        <div className="px-4 mb-6 relative z-10">
          <div className="mb-8 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-zinc-100">
            <img src="/favicon.png" alt="VelocityDL" className="w-6 h-6 rounded-md" />
            <span
              className="text-[15px]"
              style={{ fontFamily: '"Inter", "Segoe UI", sans-serif' }}
            >
              VelocityDL
            </span>
          </div>
          
          <div className="space-y-1">
            <SidebarItem icon={<Download size={16}/>} label="Active" count={downloadStats.activeCount} active={activeTab === "active"} onClick={() => setActiveTab("active")} />
            <SidebarItem icon={<CheckCircle size={16}/>} label="Finished" count={downloadStats.finishedCount || undefined} active={activeTab === "finished"} onClick={() => setActiveTab("finished")} />
            <div className="flex items-center justify-between group">
               <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-4 mb-2 ml-3">Categories</span>
               {downloadStats.finishedCount > 0 && (
                 <button onClick={clearFinished} className="mt-4 mb-2 text-[10px] text-gray-600 hover:text-error transition-colors mr-2">Clear Finished</button>
               )}
            </div>
            <SidebarItem icon={<LayoutGrid size={16}/>} label="All Files" active={activeCategory === "all"} onClick={() => setActiveCategory("all")} />
            <SidebarItem icon={<Film size={16}/>} label="Videos" active={activeCategory === "video"} onClick={() => setActiveCategory("video")} />
            <SidebarItem icon={<Music size={16}/>} label="Audio" active={activeCategory === "audio"} onClick={() => setActiveCategory("audio")} />
            <SidebarItem icon={<FileText size={16}/>} label="Documents" active={activeCategory === "file"} onClick={() => setActiveCategory("file")} />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Custom Titlebar */}
        <div className="h-14 border-b border-border flex items-center justify-between px-4 bg-surface/50 relative">
          {/* Drag region covering empty spaces */}
          <div data-tauri-drag-region className="absolute inset-0 z-0" />
          
          <div className="flex items-center gap-3 relative z-10">
            <button 
              onClick={() => {
                setInitialUrl("");
                setInitialHeaders(undefined);
                setInitialAttemptSessionId(undefined);
                setInitialDownloadContext(undefined);
                setAddUrlLaunchSource("manual");
                setIsAddUrlOpen(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent/80 text-white rounded font-medium transition-colors whitespace-nowrap"
            >
              <Plus size={16} />
              <span>Add URL</span>
            </button>
            <div className="h-4 w-px bg-border mx-1" />
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors whitespace-nowrap"
            >
              <Settings size={16} />
              <span>Settings</span>
            </button>
            {developerModeEnabled && (
              <button
                onClick={() => setShowCaptureDebug((v) => !v)}
                className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors whitespace-nowrap"
              >
                <FileText size={16} />
                <span>Capture Debug</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-4 flex-1 justify-end ml-8 relative z-10">
             {diagnosticStatus && (
               <div className="text-[11px] text-gray-400">{diagnosticStatus}</div>
             )}
             <div className="relative max-w-xs w-full">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" size={14} />
                <input 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search downloads..." 
                  className="w-full bg-background border border-border rounded py-1.5 pl-9 pr-3 outline-none focus:border-accent/50 transition-colors"
                />
             </div>
             <div className="flex items-center gap-0.5">
               <WindowButton onClick={() => appWindow.minimize().catch(console.error)} icon={<Minimize2 size={14}/>} />
               <WindowButton onClick={() => appWindow.toggleMaximize().catch(console.error)} icon={<Maximize2 size={14}/>} />
               <WindowButton onClick={() => appWindow.close().catch(console.error)} icon={<X size={14}/>} className="hover:bg-error/80" />
             </div>
          </div>
        </div>

        {/* Download List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#0c0c0c]">
          {developerModeEnabled && showCaptureDebug && (
            <div className="mb-4 rounded-md border border-border bg-surface/70 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[12px] font-semibold text-gray-200">Capture Debug</div>
                <button
                  onClick={() => setCaptureDebugEntries([])}
                  className="text-[11px] text-gray-400 hover:text-white"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-48 space-y-2 overflow-y-auto">
                {captureDebugEntries.length === 0 ? (
                  <div className="text-[11px] text-gray-500">No capture events yet.</div>
                ) : (
                  captureDebugEntries.map((entry) => (
                    <div key={entry.id} className="rounded border border-border/70 bg-background/60 px-2 py-1.5 text-[11px]">
                      <div className="text-gray-300">
                        {new Date(entry.at).toLocaleTimeString()} | {entry.captureType} | {entry.decision}
                      </div>
                      <div className="truncate text-gray-500">{entry.url}</div>
                      <div className="truncate text-gray-600">source: {entry.source}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          {filteredDownloads.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-4">
               <Download size={48} className="opacity-20" />
               <p>{searchTerm ? "No downloads match your search." : "No downloads in this category."}</p>
            </div>
          ) : (
            filteredDownloads.map(download => (
              <DownloadCard 
                key={download.id}
                {...download}
                segments={download.segments || []}
                developerModeEnabled={developerModeEnabled}
                onCopyDiagnostics={handleCopyDiagnostics}
                onShowAttemptDetails={handleShowAttemptDetails}
                onPause={handlePause}
                onResume={handleResume}
                onRefresh={handleRefreshDownload}
                onDelete={handleDelete}
                onOpenFolder={handleOpenFolder}
              />
            ))
          )}
        </div>

        {/* Status Bar */}
        <div className="h-6 border-t border-border bg-surface px-3 flex items-center justify-between gap-3 overflow-hidden text-[11px] text-gray-500">
          <div className="flex gap-4">
             <span>Total Speed: {formatAggregateSpeed(downloadStats.totalSpeedBytes)}</span>
             <span>Active: {downloadStats.runningCount}</span>
             <span>Threads: {maxThreads}</span>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 items-center gap-2 truncate">
              <Puzzle size={12} className="text-gray-400" />
              <span className="truncate">{extensionHealth?.status_label || "Checking extension..."}</span>
              <button
                onClick={() => handleOpenExtensionLink("install")}
                className="rounded-full bg-accent/12 px-2 py-0.5 text-accent hover:bg-accent/18 hover:text-accent transition-colors"
              >
                Setup
              </button>
              <button
                onClick={handleCheckExtension}
                className="text-gray-400 hover:text-white transition-colors"
              >
                Check
              </button>
              <button
                onClick={() => handleOpenExtensionLink("setup")}
                className="text-gray-400 hover:text-white transition-colors"
              >
                Docs
              </button>
            </div>
            {extensionStatusMessage && <div className="truncate text-gray-400">{extensionStatusMessage}</div>}
            <div className="shrink-0">v0.1.0-beta.2</div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SidebarItemProps {
  icon: ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}

function SidebarItem({ icon, label, count, active = false, onClick }: SidebarItemProps) {
  return (
    <div 
      onClick={onClick}
      className={`flex items-center justify-between px-3 py-2 rounded-md cursor-pointer transition-colors ${
        active ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-white/5 text-gray-400'
      }`}
    >
      <div className="flex items-center gap-3">
        {icon}
        <span>{label}</span>
      </div>
      {count !== undefined && <span className="text-[10px] bg-accent/20 text-accent px-1.5 rounded-full">{count}</span>}
    </div>
  );
}

interface WindowButtonProps {
  icon: ReactNode;
  onClick: () => void;
  className?: string;
}

function WindowButton({ icon, onClick, className = "" }: WindowButtonProps) {
  return (
    <div 
      onClick={onClick}
      className={`p-2.5 hover:bg-white/10 rounded cursor-pointer transition-colors ${className}`}
    >
      {icon}
    </div>
  );
}

export default App;
