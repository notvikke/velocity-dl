import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Download, CheckCircle, Film, Music, FileText, LayoutGrid, Settings, Plus, Maximize2, Minimize2, X, Search, Puzzle } from "lucide-react";
import { DownloadCard } from "./components/DownloadCard";
import { WelcomeSetupModal } from "./components/WelcomeSetupModal";
import { copyAppDiagnosticsToClipboard, installConsoleDiagnostics } from "./lib/diagnostics";
import "./styles/tailwind.css";

const appWindow = getCurrentWindow();
const FINISHED_STORAGE_KEY = "velocitydl.finished.v1";
const RESUME_STORAGE_KEY = "velocitydl.resume.v1";
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const AddUrlModal = lazy(() =>
  import("./components/AddUrlModal").then((m) => ({ default: m.AddUrlModal }))
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal }))
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
  onboarding_completed: boolean;
  max_threads: number;
  speed_limit_mb: number;
}

interface ExternalDownloadRequest {
  action?: string;
  url: string;
  filename?: string;
  mime?: string;
  referrer?: string;
  source?: string;
  scan_auto_open_quality_picker?: boolean;
  capture_type?: "page_url" | "direct_media_url" | "blob_backed_media";
  raw_media_url?: string;
  headers?: Record<string, string>;
  request_id?: string;
  wait_for_ack?: boolean;
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

type CaptureType = "page_url" | "direct_media_url" | "blob_backed_media";
type CaptureDecision =
  | "opened_metadata_modal"
  | "opened_metadata_modal_after_auto_queue_failure"
  | "auto_queued_direct"
  | "ignored_invalid_url"
  | "ignored_by_setting"
  | "ignored_duplicate"
  | "auto_queue_failed";

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

const extractFilenameFromUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const leaf = parsed.pathname.split("/").pop() || "";
    const decoded = decodeURIComponent(leaf).trim();
    return decoded || null;
  } catch {
    return null;
  }
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
  const [initialUrl, setInitialUrl] = useState("");
  const [initialHeaders, setInitialHeaders] = useState<Record<string, string> | undefined>(undefined);
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

  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const downloadsRef = useRef<DownloadItem[]>([]);
  const recentAutoCapturesRef = useRef<Map<string, number>>(new Map());
  const deferredSearchTerm = useDeferredValue(searchTerm.trim().toLowerCase());

  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  useEffect(() => {
    installConsoleDiagnostics();
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
    try {
      const finishedRaw = localStorage.getItem(FINISHED_STORAGE_KEY);
      const resumableRaw = localStorage.getItem(RESUME_STORAGE_KEY);

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
            }))
        : [];

      const merged: DownloadItem[] = [...restoredFinished];
      for (const resumable of restoredResumables) {
        if (!merged.some(item => item.id === resumable.id)) {
          merged.push(resumable);
        }
      }

      setDownloads(merged);
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
      setIsAddUrlOpen(true);
    });
    const unlistenExternal = listen<ExternalDownloadRequest>("external_download_request", async (event) => {
      const payload = event.payload;
      const requestId = payload.request_id;
      let ackSent = false;
      const ackRequest = async (accepted: boolean, message: string) => {
        if (!requestId || ackSent) return;
        ackSent = true;
        try {
          await invoke("ack_external_capture_request", {
            requestId,
            accepted,
            message,
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
        await ackRequest(false, "Invalid capture URL");
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
        await ackRequest(false, "Duplicate capture ignored");
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
        await ackRequest(false, "Matching active download already exists");
        return;
      }

      try {
        const settings = await invoke<AppSettings>("get_settings");
        if (!settings.accept_browser_download_requests) {
          recordCapture("ignored_by_setting");
          await ackRequest(false, "Browser captures disabled in app settings");
          return;
        }

        const isScanCapture = payload.source === "chromium-scan-overlay";
        const isDownloadsApiCapture = payload.source === "chromium-downloads-api";
        const scanAutoOpenQualityPicker = payload.scan_auto_open_quality_picker !== false;
        const shouldPreferYouTubeMetadata =
          isYouTubePageUrl(referrerUrl) ||
          isYouTubePageUrl(payloadUrl) ||
          ((payloadUrl.includes("googlevideo.com") || payloadUrl.includes("videoplayback")) &&
            isYouTubePageUrl(referrerUrl));
        const hasConcreteDirectStream =
          (!!rawHttpMediaUrl && !preferredManifestUrl) ||
          isLikelyDirectFromUrlMismatch ||
          (isClearlyDirectMedia(effectiveUrl) && !isManifestLikeUrl(effectiveUrl));
        const prefersCurrentStreamDirectQueue =
          isScanCapture &&
          !preferredManifestUrl &&
          hasConcreteDirectStream;
        const openMetadataModal = (
          modalUrl: string,
          decision: CaptureDecision = "opened_metadata_modal"
        ) => {
          setInitialHeaders(isYouTubePageUrl(modalUrl) ? undefined : payload.headers);
          setInitialUrl(modalUrl);
          setIsAddUrlOpen(true);
          recordCapture(decision);
        };

        const tryAutoQueueDirect = async (targetUrl: string) => {
          const fallbackTitle =
            payload.filename ||
            extractFilenameFromUrl(targetUrl) ||
            extractFilenameFromUrl(payload.url) ||
            "browser_capture";
          const queued = await handleAddDownload(
            targetUrl,
            settings.default_download_path,
            fallbackTitle,
            undefined,
            payload.headers
          );
          if (queued) {
            recentAutoCapturesRef.current.set(dedupeKey, now);
            recordCapture("auto_queued_direct");
            await ackRequest(true, "Download accepted by app");
            return true;
          }
          recordCapture("auto_queue_failed");
          await ackRequest(false, "App failed to queue download");
          return false;
        };

        // Methodical flow for extension capture:
        // 1) Scan-overlay captures should prefer the exact currently playing stream.
        // 2) Page/blob captures open metadata modal unless we already resolved a direct stream.
        // 3) If direct queueing fails, fall back to metadata modal.
        // 4) Otherwise treat as direct candidate -> direct queue, fallback to modal.
        if (shouldPreferYouTubeMetadata) {
          openMetadataModal(referrerUrl || payloadUrl, "opened_metadata_modal");
          await ackRequest(false, "Opened metadata flow instead of direct takeover");
          return;
        }

        if (prefersCurrentStreamDirectQueue) {
          const queued = await tryAutoQueueDirect(effectiveUrl);
          if (!queued) {
            openMetadataModal(
              effectiveUrl,
              "opened_metadata_modal_after_auto_queue_failure"
            );
          }
          return;
        }

        if (isDownloadsApiCapture) {
          const queued = await tryAutoQueueDirect(effectiveUrl);
          if (!queued) {
            openMetadataModal(effectiveUrl, "opened_metadata_modal_after_auto_queue_failure");
          }
          return;
        }

        if (captureType === "page_url" || captureType === "blob_backed_media") {
          openMetadataModal(scanDirectCandidateUrl || payload.url, "opened_metadata_modal");
          await ackRequest(false, "Opened metadata flow instead of direct takeover");
          return;
        }

        if (isScanCapture && scanAutoOpenQualityPicker && !isClearlyDirectMedia(effectiveUrl)) {
          openMetadataModal(scanDirectCandidateUrl || payload.url, "opened_metadata_modal");
          await ackRequest(false, "Opened metadata flow instead of direct takeover");
          return;
        }

        const queued = await tryAutoQueueDirect(effectiveUrl);
        if (!queued) {
          openMetadataModal(effectiveUrl, "opened_metadata_modal_after_auto_queue_failure");
        }
      } catch (e) {
        console.error("Failed to process browser extension capture", e);
        recordCapture("auto_queue_failed");
        await ackRequest(false, "App capture processing failed");
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

    return () => {
      unlistenMedia.then(f => f());
      unlistenExternal.then(f => f());
      unlistenProgress.then(f => f());
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
        }));
      localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(resumableToPersist));
    } catch (error) {
      console.error("Failed to persist downloads", error);
    }
  }, [downloads, hydrated]);

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
    audioHeaders?: Record<string, string>
  ) => {
    try {
      const newDownload = await invoke<DownloadItem>("add_download", { 
        url, 
        audioUrl,
        outputPath: path,
        title,
        totalSize: size,
        audioSize,
        headers,
        audioHeaders
      });
      newDownload.category = inferCategory(title || url);
      newDownload.segments = createIdleSegments(maxThreads);
      setDownloads(prev => [...prev, newDownload]);
      return true;
    } catch (error) {
      console.error("Failed to add download:", error);
      return false;
    }
  }, [maxThreads]);

  const handlePause = useCallback(async (id: string) => {
    try {
      await invoke("pause_download", { id });
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'paused', speed: '0 B/s' } : d));
    } catch (e) { console.error(e); }
  }, []);

  const handleResume = useCallback(async (id: string) => {
    try {
      const paused = downloads.find(d => d.id === id);
      if (!paused) return;

      const restarted = await invoke<DownloadItem>("add_download", {
        existingId: id,
        url: paused.url,
        audioUrl: paused.audio_url ?? null,
        outputPath: paused.output_path,
        title: paused.title,
        totalSize: paused.total_size,
        audioSize: paused.audio_size ?? null,
        headers: paused.headers ?? null,
        audioHeaders: paused.audio_headers ?? null,
      });

      restarted.category = paused.category || inferCategory(paused.title || paused.url);
      restarted.segments = paused.segments?.length ? paused.segments : createIdleSegments(maxThreads);
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, ...restarted, status: 'active', progress: d.progress, recovered: false } : d));
    } catch (e) { console.error(e); }
  }, [downloads, maxThreads]);

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

  const handleDelete = useCallback(async (id: string) => {
    const target = downloads.find(d => d.id === id);
    if (target && (target.status === "active" || target.status === "paused" || target.status === "processing")) {
      try {
        await invoke("pause_download", { id });
      } catch (e) {
        console.error("Failed to stop download before removing", e);
      }
    }
    setDownloads(prev => prev.filter(d => d.id !== id));
  }, [downloads]);

  const clearFinished = useCallback(() => {
    setDownloads(prev => prev.filter(d => d.status !== 'finished'));
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
    const url = kind === "install" ? health.install_url : health.setup_url;
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

  const extensionMetaLabel = useMemo(() => {
    if (!extensionHealth) return "Checking extension...";
    const details = [
      extensionHealth.last_seen_browser,
      extensionHealth.last_seen_extension_version
        ? `v${extensionHealth.last_seen_extension_version}`
        : null,
    ].filter(Boolean);
    if (extensionHealth.last_heartbeat_at_ms) {
      const when = new Date(extensionHealth.last_heartbeat_at_ms).toLocaleTimeString();
      details.push(`seen ${when}`);
    }
    return details.length ? details.join(" | ") : "Recommended for better capture reliability";
  }, [extensionHealth]);

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

  return (
    <div className="flex h-screen bg-background text-white select-none overflow-hidden font-sans text-[13px] border border-border">
      {/* Modals */}
      {isAddUrlOpen && (
        <Suspense fallback={null}>
          <AddUrlModal 
            isOpen={isAddUrlOpen} 
            initialUrl={initialUrl}
            initialHeaders={initialHeaders}
            onClose={() => {
              setIsAddUrlOpen(false);
              setInitialUrl("");
              setInitialHeaders(undefined);
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
              onClick={() => setIsAddUrlOpen(true)}
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
                onPause={handlePause}
                onResume={handleResume}
                onDelete={handleDelete}
                onOpenFolder={handleOpenFolder}
              />
            ))
          )}
        </div>

        {/* Status Bar */}
        <div className="h-6 border-t border-border bg-surface px-3 flex items-center justify-between text-[11px] text-gray-500">
          <div className="flex gap-4">
             <span>Total Speed: {formatAggregateSpeed(downloadStats.totalSpeedBytes)}</span>
             <span>Active: {downloadStats.runningCount}</span>
             <span>Threads: {maxThreads}</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Puzzle size={12} className="text-gray-400" />
              <span>{extensionHealth?.status_label || "Checking extension..."}</span>
              <button
                onClick={handleCheckExtension}
                className="text-gray-400 hover:text-white transition-colors"
              >
                Check
              </button>
              <button
                onClick={() => handleOpenExtensionLink("install")}
                className="text-accent hover:text-accent/80 transition-colors"
              >
                Install
              </button>
              <button
                onClick={() => handleOpenExtensionLink("setup")}
                className="text-gray-400 hover:text-white transition-colors"
              >
                Setup
              </button>
            </div>
            <div className="hidden text-gray-600 md:block">{extensionMetaLabel}</div>
            {extensionStatusMessage && <div className="text-gray-400">{extensionStatusMessage}</div>}
            <div>VelocityDL v0.1.0-alpha.2</div>
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
