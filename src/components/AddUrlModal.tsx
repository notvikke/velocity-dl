import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Globe, Folder, Download, Clipboard, Loader2, Music, Video, Info, Radar, Zap } from "lucide-react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { copyAppDiagnosticsToClipboard } from "../lib/diagnostics";

interface YtFormat {
  format_id: string;
  url: string;
  ext: string;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  resolution?: string;
  height?: number;
  format_note?: string;
  fps?: number;
  tbr?: number;
  vbr?: number;
  abr?: number;
  http_headers?: Record<string, string>;
}

interface YtMetadata {
  title: string;
  ext: string;
  thumbnail?: string;
  formats: YtFormat[];
  http_headers?: Record<string, string>;
  channel?: string;
  uploader?: string;
}

// A quality tier groups a video-only track with the best audio track
interface QualityTier {
  label: string;         // e.g., "1080p", "720p", "Audio Only"
  videoFormat?: YtFormat; // The video-only (or combined) format
  audioFormat?: YtFormat; // The best audio track to pair with
  isVideoOnly: boolean;
  isAudioOnly: boolean;
  isCombined: boolean;    // Whether this format already has both A+V
  totalSize: number;
  fps?: number;
  codec?: string;
}

interface AddUrlModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (
    url: string, 
    path: string, 
    title?: string, 
    size?: number, 
    headers?: Record<string, string>,
    audioUrl?: string,
    audioSize?: number,
    audioHeaders?: Record<string, string>,
    attemptSessionId?: string,
    qualityMetadata?: {
      qualityLabel?: string;
      bitrateKbps?: number;
    },
    downloadContext?: {
      strategyHint?: "direct_file" | "hls_manifest" | "dash_manifest";
      downloadOrigin?: "browser_takeover" | "manual" | "sniff_capture";
      browserSource?: string;
      browserConfidence?: "strong_direct" | "strong_manifest" | "ambiguous_media" | "page";
      browserRequestId?: string;
      originalUrl?: string;
      referrer?: string;
      routeClass?: string;
    }
  ) => void;
  onAttemptStart: (title: string, url: string) => string;
  onAttemptFinish: (
    sessionId: string,
    status: "running" | "succeeded" | "failed",
    summary?: string,
    autoCloseMs?: number
  ) => void;
  initialUrl?: string;
  initialHeaders?: Record<string, string>;
  initialAttemptSessionId?: string;
  initialDownloadContext?: {
    strategyHint?: "direct_file" | "hls_manifest" | "dash_manifest";
    downloadOrigin?: "browser_takeover" | "manual" | "sniff_capture";
    browserSource?: string;
    browserConfidence?: "strong_direct" | "strong_manifest" | "ambiguous_media" | "page";
    browserRequestId?: string;
    originalUrl?: string;
    referrer?: string;
    routeClass?: string;
  };
  launchSource?: "manual" | "browser_capture" | "media_detected";
}

interface AppSettings {
  default_download_path: string;
  auto_start_sniff_capture: boolean;
  accept_browser_download_requests?: boolean;
}

interface SnifferCaptureEvent {
  url: string;
  headers?: Record<string, string>;
  content_type?: string;
}

export function AddUrlModal({
  isOpen,
  onClose,
  onAdd,
  onAttemptStart,
  onAttemptFinish,
  initialUrl,
  initialHeaders,
  initialAttemptSessionId,
  initialDownloadContext,
  launchSource = "manual",
}: AddUrlModalProps) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [isSniffing, setIsSniffing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<YtMetadata | null>(null);
  const [selectedTier, setSelectedTier] = useState<QualityTier | null>(null);
  const [capturedHeaders, setCapturedHeaders] = useState<Record<string, string> | undefined>(undefined);
  const [capturedDownloadContext, setCapturedDownloadContext] = useState<
    AddUrlModalProps["initialDownloadContext"]
  >(undefined);

  const [isDirectUrl, setIsDirectUrl] = useState(false);
  const [autoStartSniffCapture, setAutoStartSniffCapture] = useState(false);
  const [diagnosticStatus, setDiagnosticStatus] = useState("");
  const [currentAttemptSessionId, setCurrentAttemptSessionId] = useState<string | null>(null);

  // Build quality tiers from raw formats
  const qualityTiers = useMemo((): QualityTier[] => {
    if (!metadata) return [];

    const formats = metadata.formats.filter(f =>
      !f.vcodec?.includes('storyboard') &&
      f.ext !== 'html' &&
      f.ext !== 'mhtml' &&
      f.ext !== 'm3u8' &&
      f.url.startsWith('http')
    );

    // Separate into video-only, audio-only, and combined
    const videoOnly = formats.filter(f =>
      f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')
    );
    const audioOnly = formats.filter(f =>
      (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none'
    );
    const combined = formats.filter(f =>
      f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'
    );

    // Find the best audio track (highest bitrate / largest size)
    const bestAudio = [...audioOnly].sort((a, b) => {
      const aScore = (a.abr || 0) + ((a.filesize || a.filesize_approx || 0) / 1_000_000);
      const bScore = (b.abr || 0) + ((b.filesize || b.filesize_approx || 0) / 1_000_000);
      return bScore - aScore;
    })[0];

    const tiers: QualityTier[] = [];

    // Group video-only tracks by height, pick the best codec per height
    const heightMap = new Map<number, YtFormat[]>();
    for (const f of videoOnly) {
      const h = f.height || parseInt(f.resolution?.split('x')[1] || '0') || 0;
      if (h === 0) continue;
      if (!heightMap.has(h)) heightMap.set(h, []);
      heightMap.get(h)!.push(f);
    }

    // For each height, pick the best format (prefer higher bitrate / better codec)
    for (const [height, fmts] of [...heightMap.entries()].sort((a, b) => b[0] - a[0])) {
      const best = [...fmts].sort((a, b) => {
        const aBr = a.vbr || a.tbr || 0;
        const bBr = b.vbr || b.tbr || 0;
        return bBr - aBr;
      })[0];

      const videoSize = best.filesize || best.filesize_approx || 0;
      const audioSize = bestAudio?.filesize || bestAudio?.filesize_approx || 0;

      tiers.push({
        label: `${height}p`,
        videoFormat: best,
        audioFormat: bestAudio,
        isVideoOnly: true,
        isAudioOnly: false,
        isCombined: false,
        totalSize: videoSize + audioSize,
        fps: best.fps,
        codec: best.vcodec?.split('.')[0],
      });
    }

    // Add combined formats (legacy) that aren't represented
    for (const f of combined) {
      const h = f.height || parseInt(f.resolution?.split('x')[1] || '0') || 0;
      const alreadyHas = tiers.some(t => t.label === `${h}p`);
      if (!alreadyHas && h > 0) {
        tiers.push({
          label: `${h}p`,
          videoFormat: f,
          isVideoOnly: false,
          isAudioOnly: false,
          isCombined: true,
          totalSize: f.filesize || f.filesize_approx || 0,
          fps: f.fps,
          codec: f.vcodec?.split('.')[0],
        });
      }
    }

    // Sort tiers by resolution (highest first)
    tiers.sort((a, b) => {
      const aH = parseInt(a.label) || 0;
      const bH = parseInt(b.label) || 0;
      return bH - aH;
    });

    // Add audio-only options
    if (audioOnly.length > 0) {
      const highAudio = [...audioOnly].filter(a => (a.abr || 0) >= 128 || (a.filesize || a.filesize_approx || 0) > 5_000_000);
      const bestAudioFormat = highAudio[0] || audioOnly[0];
      
      tiers.push({
        label: `Audio Only (${bestAudioFormat.ext.toUpperCase()})`,
        audioFormat: bestAudioFormat,
        isVideoOnly: false,
        isAudioOnly: true,
        isCombined: false,
        totalSize: bestAudioFormat.filesize || bestAudioFormat.filesize_approx || 0,
      });
    }

    // If no tiers were built (direct/non-YouTube link), add raw formats
    if (tiers.length === 0 && formats.length > 0) {
      for (const f of formats) {
        tiers.push({
          label: f.resolution || f.format_note || f.format_id,
          videoFormat: f,
          isVideoOnly: false,
          isAudioOnly: false,
          isCombined: true,
          totalSize: f.filesize || f.filesize_approx || 0,
        });
      }
    }

    return tiers;
  }, [metadata]);

  // Auto-select the best tier when tiers change
  useEffect(() => {
    if (qualityTiers.length > 0 && !selectedTier) {
      // Prefer 1080p, then highest available
      const tier1080 = qualityTiers.find(t => t.label === '1080p');
      setSelectedTier(tier1080 || qualityTiers[0]);
    }
  }, [qualityTiers]);

  const handleStartDownload = () => {
    if (!selectedTier && !isDirectUrl) return;
    const effectiveDownloadContext = capturedDownloadContext || initialDownloadContext;

    if (isDirectUrl && !metadata) {
      // Direct URL download without metadata
      const sessionId =
        currentAttemptSessionId ||
        initialAttemptSessionId ||
        onAttemptStart(url.split('/').pop()?.split('?')[0] || "downloaded_media", url);
      onAdd(
        url,
        path,
        url.split('/').pop()?.split('?')[0] || "downloaded_media",
        undefined,
        capturedHeaders || initialHeaders,
        undefined,
        undefined,
        undefined,
        sessionId,
        undefined,
        effectiveDownloadContext
      );
      onClose();
      return;
    }

    if (!selectedTier) return;

    const title = metadata ? `${metadata.title}.${selectedTier.videoFormat?.ext || selectedTier.audioFormat?.ext || metadata.ext}` : undefined;
    const qualityMetadata = {
      qualityLabel: selectedTier.label || undefined,
      bitrateKbps:
        selectedTier.videoFormat?.vbr ||
        selectedTier.videoFormat?.tbr ||
        selectedTier.audioFormat?.abr ||
        selectedTier.audioFormat?.tbr ||
        undefined,
    };

    if (selectedTier.isAudioOnly) {
      // Audio-only download
      onAdd(
        selectedTier.audioFormat!.url,
        path,
        metadata ? `${metadata.title}.${selectedTier.audioFormat!.ext}` : undefined,
        selectedTier.audioFormat!.filesize || selectedTier.audioFormat!.filesize_approx,
        selectedTier.audioFormat!.http_headers || metadata?.http_headers,
        undefined,
        undefined,
        undefined,
        currentAttemptSessionId || initialAttemptSessionId || undefined,
        qualityMetadata,
        effectiveDownloadContext,
      );
    } else if (selectedTier.isCombined) {
      // Single combined download
      onAdd(
        selectedTier.videoFormat!.url,
        path,
        title,
        selectedTier.videoFormat!.filesize || selectedTier.videoFormat!.filesize_approx,
        selectedTier.videoFormat!.http_headers || metadata?.http_headers,
        undefined,
        undefined,
        undefined,
        currentAttemptSessionId || initialAttemptSessionId || undefined,
        qualityMetadata,
        effectiveDownloadContext,
      );
    } else {
      // Multi-track: video + audio (the key fix!)
      onAdd(
        selectedTier.videoFormat!.url,
        path,
        title,
        selectedTier.videoFormat!.filesize || selectedTier.videoFormat!.filesize_approx,
        selectedTier.videoFormat!.http_headers || metadata?.http_headers,
        selectedTier.audioFormat?.url,
        selectedTier.audioFormat?.filesize || selectedTier.audioFormat?.filesize_approx,
        selectedTier.audioFormat?.http_headers || metadata?.http_headers,
        currentAttemptSessionId || initialAttemptSessionId || undefined,
        qualityMetadata,
        effectiveDownloadContext,
      );
    }
    
    onClose();
  };

  const checkIsDirectUrl = (input: string) => {
    return input.match(/\.(mp4|mkv|webm|m3u8|mp3|aac|flac|wav|m4a|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|txt|csv|json|xml|pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|webp|svg|bmp|tif|tiff|exe|msi|iso)(\?|$)/i) || 
           input.includes("googlevideo.com") || 
           input.includes("videoplayback");
  };

  useEffect(() => {
    const unlisten = listen<SnifferCaptureEvent | string>("media_detected", (event) => {
      if (isSniffing) {
          const capture = event.payload;
          const mediaUrl = typeof capture === 'string' ? capture : capture.url;
          const headers = typeof capture === 'string' ? undefined : capture.headers;
          const contentType = typeof capture === 'string' ? undefined : capture.content_type;
          const lowerMediaUrl = mediaUrl.toLowerCase();
          const isDash = lowerMediaUrl.includes('.mpd') || contentType?.includes('dash');
          const isHls = lowerMediaUrl.includes('.m3u8') || contentType?.includes('mpegurl');
          const referrer = headers?.Referer || headers?.referer;
          const sniffDownloadContext: NonNullable<AddUrlModalProps["initialDownloadContext"]> = {
            strategyHint: isDash ? "dash_manifest" : isHls ? "hls_manifest" : "direct_file",
            downloadOrigin: "sniff_capture",
            browserSource: "tauri-deep-sniff",
            browserConfidence: isDash || isHls ? "strong_manifest" : "strong_direct",
            originalUrl: referrer,
            referrer,
          };
          console.info("[Deep Sniff] Capture received by the main download flow");
          setCapturedHeaders(headers);
          setCapturedDownloadContext(sniffDownloadContext);
          setUrl(mediaUrl);
          setIsDirectUrl(true);
          setIsSniffing(false);
          if (autoStartSniffCapture) {
            const effectivePath = path?.trim();
            if (effectivePath) {
              const guessedTitle = mediaUrl.split('/').pop()?.split('?')[0] || "captured_stream.mp4";
              onAdd(mediaUrl, effectivePath, guessedTitle, undefined, headers, undefined, undefined, undefined, currentAttemptSessionId || initialAttemptSessionId || undefined, undefined, sniffDownloadContext);
              onClose();
              return;
            }
          }
          fetchInfo(mediaUrl, headers, true, sniffDownloadContext);
      }
    });
    return () => { unlisten.then(f => f()); };
  }, [autoStartSniffCapture, currentAttemptSessionId, initialAttemptSessionId, isSniffing, onAdd, onClose, path]);

  useEffect(() => {
    const unlisten = listen<string>("sniffer_error", (event) => {
      if (!isSniffing) return;
      const message = event.payload || "Deep Sniff could not submit this media URL.";
      console.error("[Deep Sniff] Native handoff failed:", message);
      setError(message);
      setIsSniffing(false);
    });
    return () => { unlisten.then(f => f()); };
  }, [isSniffing]);

  useEffect(() => {
    const unlisten = listen<{ window_id: string; captured: boolean }>("sniffer_closed", (event) => {
      if (!isSniffing) return;
      setIsSniffing(false);
      if (!event.payload?.captured) {
        setError("Deep Sniff window was closed before any media request was captured. Start playback in that window first, then wait for capture or use the in-page button there.");
      }
    });
    return () => { unlisten.then(f => f()); };
  }, [isSniffing]);

  useEffect(() => {
    if (!isSniffing) return;
    const t = setTimeout(() => {
      setError("Deep Sniff is still waiting for media requests. Start playback in the sniff window, or try direct metadata fetch first.");
    }, 15000);
    return () => clearTimeout(t);
  }, [isSniffing]);

  const handleDeepSniff = async () => {
    if (!url || !url.startsWith('http')) return;
    setIsSniffing(true);
    setError(null);
    setCapturedDownloadContext(undefined);
    try {
        await invoke("start_sniffing", { url });
    } catch (e: any) {
        setIsSniffing(false);
        setError("Failed to start sniffer: " + e.message);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setIsSniffing(false);
      setSelectedTier(null);
      setCapturedHeaders(undefined);
      setCapturedDownloadContext(undefined);
      setCurrentAttemptSessionId(initialAttemptSessionId || null);
      invoke<AppSettings>("get_settings").then(s => {
        if (!path) setPath(s.default_download_path);
        setAutoStartSniffCapture(!!s.auto_start_sniff_capture);
      });
    }
  }, [initialAttemptSessionId, isOpen]);

  useEffect(() => {
    if (initialUrl) {
      setUrl(initialUrl);
      setSelectedTier(null);
      fetchInfo(initialUrl, initialHeaders);
    }
  }, [initialUrl, initialHeaders]);

  const fetchInfo = async (
    overrideUrl?: string,
    overrideHeaders?: Record<string, string>,
    fromSniffCapture: boolean = false,
    downloadContextOverride?: AddUrlModalProps["initialDownloadContext"]
  ) => {
    const targetUrl = overrideUrl || url;
    if (!targetUrl || !targetUrl.startsWith('http')) return;

    setIsFetching(true);
    setMetadata(null);
    setSelectedTier(null);
    setError(null);
    const attemptSessionId =
      currentAttemptSessionId ||
      initialAttemptSessionId ||
      onAttemptStart("Inspect URL", targetUrl);
    setCurrentAttemptSessionId(attemptSessionId);
    try {
      setIsDirectUrl(!!checkIsDirectUrl(targetUrl));
      const effectiveHeaders = overrideHeaders || capturedHeaders;
      const data = await invoke<YtMetadata>("fetch_metadata", {
        url: targetUrl,
        headers: effectiveHeaders,
        attemptSessionId,
      });
      if (!data.formats || data.formats.length === 0) {
          throw new Error("No formats found for this URL.");
      }
      setMetadata(data);
      onAttemptFinish(attemptSessionId, "succeeded", `Loaded ${data.title}`, 1200);
    } catch (e: any) {
      console.error("Fetch metadata failed", e);
      const msg = typeof e === 'string' ? e : e.message || "Failed to fetch media info.";
      setError(msg);
      onAttemptFinish(attemptSessionId, "failed", msg);

      // If this came from an explicit deep-sniff capture, fall back to direct queueing.
      if (fromSniffCapture && path) {
        const fallbackHeaders = overrideHeaders || capturedHeaders;
        const guessedTitle = targetUrl.split('/').pop()?.split('?')[0] || "captured_stream.mp4";
        onAdd(targetUrl, path, guessedTitle, undefined, fallbackHeaders, undefined, undefined, undefined, attemptSessionId, undefined, downloadContextOverride || capturedDownloadContext || initialDownloadContext);
        onClose();
      }
    } finally {
      setIsFetching(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await readText();
      if (text) {
        setUrl(text);
        fetchInfo(text);
      }
    } catch (e) {
      console.error("Failed to read clipboard", e);
    }
  };

  const inferFailureHint = () => {
    const lowerUrl = url.toLowerCase();
    const lowerError = (error || "").toLowerCase();

    if (/\/videos\/|\/watch\/|\/embed\//.test(lowerUrl)) {
      return "Some sites need browser cookies or the currently playing stream. Start playback in the browser, then use Deep Sniff or the extension scan overlay. If it still fails, copy diagnostics from here so the yt-dlp attempt details and frontend errors are included.";
    }

    if (lowerError.includes("403")) {
      return "The site denied direct metadata access. Try Deep Sniff after playback or retry from the browser extension capture path.";
    }

    return "If the page is playable in the browser but metadata fetch fails here, try Deep Sniff after playback and copy diagnostics from this dialog.";
  };

  const handleCopyDiagnostics = async () => {
    try {
      await copyAppDiagnosticsToClipboard(`add_url_modal | url=${url}`);
      setDiagnosticStatus("Diagnostics copied");
      window.setTimeout(() => setDiagnosticStatus(""), 1800);
    } catch (copyError) {
      console.error("Failed to copy diagnostics", copyError);
      setDiagnosticStatus("Failed to copy diagnostics");
      window.setTimeout(() => setDiagnosticStatus(""), 2200);
    }
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: path
      });
      if (selected && typeof selected === 'string') {
        setPath(selected);
      }
    } catch (e) {
      console.error("Failed to open dialog", e);
    }
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return "Unknown size";
    const mb = bytes / (1024 * 1024);
    return mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(2)} MB`;
  };

  const getTierBadge = (tier: QualityTier) => {
    if (tier.isAudioOnly) return null;
    if (tier.isCombined) return <span className="ml-2 text-[9px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">A+V</span>;
    if (tier.isVideoOnly && tier.audioFormat) return <span className="ml-2 text-[9px] bg-accent/20 text-accent px-1.5 py-0.5 rounded flex items-center gap-0.5"><Zap size={8}/>MULTI-TRACK</span>;
    return <span className="ml-2 text-[9px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">VIDEO ONLY</span>;
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto p-4">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div 
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            className="relative mx-auto my-4 flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface/50">
              <div className="flex items-center gap-2 font-bold text-accent">
                <Download size={18} />
                <span>Add New Download</span>
              </div>
              <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="space-y-5 overflow-y-auto p-6">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">URL / Media Link</label>
                <div className="flex gap-2">
                    <div className="relative flex-1">
                        <Globe className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
                        <input 
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            onBlur={() => fetchInfo()}
                            placeholder="https://example.com/video.mp4"
                            className="w-full bg-background border border-border rounded-lg py-2.5 pl-10 pr-24 outline-none focus:border-accent/50 transition-colors"
                        />
                        <button 
                            onClick={handlePaste}
                            className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-[11px] text-gray-300 transition-colors"
                        >
                            <Clipboard size={12} />
                            <span>Paste</span>
                        </button>
                    </div>
                    <button 
                        onClick={() => fetchInfo()}
                        disabled={isFetching}
                        className="px-4 bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50"
                    >
                        {isFetching ? <Loader2 className="animate-spin" size={18} /> : <Info size={18} />}
                    </button>
                </div>
              </div>

              {error && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-3 bg-error/10 border border-error/30 rounded-lg text-error text-xs space-y-3"
                  >
                      <div className="flex items-start gap-2">
                        <X size={14} className="mt-0.5 flex-shrink-0" />
                        <span>{error}</span>
                      </div>
                      <div className="rounded border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-gray-300">
                        {inferFailureHint()}
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={handleCopyDiagnostics}
                          className="rounded bg-white/8 px-3 py-1.5 text-[11px] text-gray-100 hover:bg-white/12"
                        >
                          Copy Diagnostics
                        </button>
                        {diagnosticStatus && <span className="text-[11px] text-gray-300">{diagnosticStatus}</span>}
                      </div>
                  </motion.div>
              )}

              {launchSource === "browser_capture" && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-lg border border-accent/30 bg-accent/8 px-3 py-2 text-[11px] text-accent/90"
                >
                  Browser handoff succeeded. Review the captured stream or page details, then click <span className="font-semibold text-white">Start Download</span> to queue it in VelocityDL.
                </motion.div>
              )}

              {metadata && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 bg-background/50 border border-border rounded-lg space-y-4"
                  >
                      <div className="flex gap-4">
                          {metadata.thumbnail && (
                              <img src={metadata.thumbnail} className="w-32 h-20 object-cover rounded border border-white/5" alt="Preview" />
                          )}
                          <div className="flex-1 min-w-0">
                              <div className="font-bold text-gray-200 truncate">{metadata.title}</div>
                              {(metadata.channel || metadata.uploader) && (
                                <div className="text-[11px] text-gray-500 mt-0.5">{metadata.channel || metadata.uploader}</div>
                              )}
                              <div className="text-xs text-gray-500 mt-1">
                                {qualityTiers.length} quality options available
                              </div>
                          </div>
                      </div>

                      <div className="space-y-2">
                          <label className="text-[10px] font-bold text-gray-500 uppercase">Select Quality</label>
                          <div className="grid grid-cols-1 gap-1.5 max-h-52 overflow-y-auto pr-2 custom-scrollbar">
                              {qualityTiers.map((tier, idx) => (
                                <div 
                                  key={idx}
                                  onClick={() => setSelectedTier(tier)}
                                  className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all ${
                                      selectedTier === tier 
                                          ? 'bg-accent/10 border-accent/50 text-accent' 
                                          : 'bg-white/5 border-transparent text-gray-400 hover:bg-white/10'
                                  }`}
                                >
                                    <div className="flex items-center gap-3">
                                        {tier.isAudioOnly ? <Music size={14}/> : <Video size={14}/>}
                                        <div className="text-sm font-medium flex items-center">
                                            <span>{tier.label}</span>
                                            {tier.fps && tier.fps > 30 && (
                                              <span className="ml-1.5 text-[9px] bg-white/10 px-1 rounded text-gray-400">{Math.round(tier.fps)}fps</span>
                                            )}
                                            {tier.codec && (
                                              <span className="ml-1.5 text-[9px] opacity-40">{tier.codec}</span>
                                            )}
                                            {getTierBadge(tier)}
                                        </div>
                                    </div>
                                    <div className="text-[11px] font-bold">
                                        {formatSize(tier.totalSize)}
                                    </div>
                                </div>
                              ))}
                          </div>
                      </div>

                      {/* Multi-track info banner */}
                      {selectedTier && selectedTier.isVideoOnly && selectedTier.audioFormat && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className="p-2.5 bg-accent/5 border border-accent/20 rounded-lg"
                        >
                          <div className="text-[10px] text-accent/80 flex items-center gap-1.5">
                            <Zap size={10} />
                            <span>Multi-track: Video + Audio will download simultaneously, then merge with FFmpeg.</span>
                          </div>
                        </motion.div>
                      )}
                  </motion.div>
              )}

              {error && isDirectUrl && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 bg-accent/5 border border-accent/30 rounded-lg space-y-3"
                  >
                      <div className="flex items-center gap-2 text-accent font-bold text-[10px] uppercase tracking-wider">
                          <Radar size={14} />
                          <span>Direct File/Media Link Detected</span>
                      </div>
                      <div className="text-[11px] text-gray-400 break-all bg-black/20 p-2 rounded border border-white/5 font-mono">
                          {url}
                      </div>
                      <p className="text-[10px] text-gray-500 italic">
                          Metadata fetch failed, but we captured the stream URL.
                      </p>
                  </motion.div>
              )}

              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Save To</label>
                <div className="relative">
                  <Folder className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
                  <input 
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    className="w-full bg-background border border-border rounded-lg py-2.5 pl-10 pr-24 outline-none text-gray-300 focus:border-accent/50 transition-colors text-sm"
                  />
                  <button 
                    onClick={handleBrowse}
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-[11px] text-gray-300 transition-colors"
                  >
                    <span>Browse</span>
                  </button>
                </div>
              </div>

              <div className="pt-2 flex gap-3">
                <button 
                   onClick={handleDeepSniff}
                   disabled={isSniffing || !url}
                   className={`flex-1 py-3 rounded-lg font-bold transition-all flex items-center justify-center gap-2 border ${
                       isSniffing ? 'bg-accent/20 border-accent/50 text-accent' : 'bg-white/5 border-border hover:bg-white/10 text-gray-300'
                   }`}
                >
                   {isSniffing ? <Radar className="animate-pulse" size={18} /> : <Radar size={18} />}
                   <span>{isSniffing ? 'Sniffing...' : 'Deep Sniff'}</span>
                </button>
                <button 
                  onClick={handleStartDownload}
                  disabled={isFetching || (!metadata && !isDirectUrl)}
                  className="flex-[2] bg-accent hover:bg-accent/80 text-white font-bold py-3 rounded-lg transition-all shadow-lg shadow-accent/20 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Download size={18} />
                  <span>{isFetching ? 'Fetching info...' : 'Start Download'}</span>
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
