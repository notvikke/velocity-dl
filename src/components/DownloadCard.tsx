import { memo, useState } from "react";
import {
  Film,
  MoreVertical,
  Pause,
  Play,
  Trash2,
  Folder,
  AlertCircle,
  Music,
  Image as ImageIcon,
  FileText,
  Archive,
  File,
} from "lucide-react";
import { SegmentVisualizer } from "./SegmentVisualizer";

interface Props {
  id: string;
  title: string;
  speed: string;
  stream_speed_factor?: string;
  indeterminate_progress?: boolean;
  eta: string;
  progress: number;
  segments: Segment[];
  status: "active" | "paused" | "processing" | "finished" | "error";
  category?: "video" | "audio" | "image" | "document" | "archive" | "file";
  error?: string;
  recovered?: boolean;
  developerModeEnabled?: boolean;
  headers?: Record<string, string>;
  audio_headers?: Record<string, string>;
  audio_url?: string;
  download_strategy?: string;
  onCopyDiagnostics?: (context?: string) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onDelete?: (id: string) => void;
  onOpenFolder?: (id: string) => void;
}

interface Segment {
  id: number;
  state: "idle" | "downloading" | "finished";
}

export const DownloadCard = memo(function DownloadCard({
  id,
  title,
  speed,
  stream_speed_factor,
  indeterminate_progress,
  eta,
  progress,
  segments,
  status,
  category,
  error,
  recovered,
  developerModeEnabled,
  headers,
  audio_headers,
  audio_url,
  download_strategy,
  onCopyDiagnostics,
  onPause,
  onResume,
  onDelete,
  onOpenFolder,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const mainHeaderCount = headers ? Object.keys(headers).length : 0;
  const audioHeaderCount = audio_headers ? Object.keys(audio_headers).length : 0;
  const strategyLabel = download_strategy || "unknown";

  const Icon =
    status === "error"
      ? AlertCircle
      : category === "audio"
      ? Music
      : category === "image"
      ? ImageIcon
      : category === "document"
      ? FileText
      : category === "archive"
      ? Archive
      : category === "file"
      ? File
      : Film;

  return (
    <div
      className={`bg-surface border p-3 rounded-md transition-all group relative overflow-hidden ${
        status === "error"
          ? "border-error/40 shadow-[0_0_15px_rgba(255,76,76,0.1)]"
          : "border-border hover:border-accent/40"
      }`}
    >
      <div
        className={`absolute inset-0 transition-all duration-500 pointer-events-none ${
          status === "error" ? "bg-error/5" : "bg-accent/5"
        }`}
        style={{ width: `${progress}%` }}
      />

      <div className="relative z-10">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-10 h-10 rounded flex-shrink-0 flex items-center justify-center transition-colors ${
                status === "finished"
                  ? "bg-white/10 text-gray-200"
                  : status === "processing"
                  ? "bg-yellow-500/10 text-yellow-400"
                  : status === "error"
                  ? "bg-error/10 text-error"
                  : "bg-accent/10 text-accent"
              }`}
            >
              <Icon size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate text-[14px] text-gray-100">{title}</div>
              <div className="text-gray-400 text-xs mt-0.5 flex items-center gap-2">
                <span
                  className={`font-bold ${
                    status === "finished"
                      ? "text-success"
                      : status === "processing"
                      ? "text-yellow-400"
                      : status === "error"
                      ? "text-error"
                      : "text-accent"
                  }`}
                >
                  {status === "finished"
                    ? "COMPLETED"
                    : status === "processing"
                    ? "PROCESSING"
                    : status === "error"
                    ? "ERROR"
                    : `${progress}%`}
                </span>
                {status !== "finished" && (
                  <>
                    <span className="opacity-30">|</span>
                    <span>{status === "error" ? error : speed}</span>
                  </>
                )}
                {status === "active" && (
                  <>
                    <span className="opacity-30">|</span>
                    <span>ETA: {eta}</span>
                  </>
                )}
                {status === "processing" && (
                  <>
                    <span className="opacity-30">|</span>
                    <span>{eta}</span>
                  </>
                )}
                {recovered && status === "paused" && (
                  <>
                    <span className="opacity-30">|</span>
                    <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 text-[10px]">
                      Recovered after restart
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="relative flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {(status === "active" || status === "paused") && (
              <button
                type="button"
                onClick={() => (status === "active" ? onPause?.(id) : onResume?.(id))}
                className="p-1.5 hover:bg-white/10 rounded text-gray-300 transition-colors"
                title={status === "active" ? "Pause" : "Resume"}
              >
                {status === "active" ? <Pause size={14} /> : <Play size={14} />}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenFolder?.(id)}
              className="p-1.5 hover:bg-white/10 rounded text-gray-300 transition-colors"
              title="Open Folder"
            >
              <Folder size={14} />
            </button>
            <button
              type="button"
              onClick={() => onDelete?.(id)}
              className="p-1.5 hover:bg-error/20 hover:text-error rounded text-gray-400 transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="p-1.5 hover:bg-white/10 rounded text-gray-400"
              title="More"
            >
              <MoreVertical size={14} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-9 z-20 w-36 rounded-md border border-border bg-surface shadow-xl">
                {status === "error" && (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10"
                    onClick={() => {
                      onCopyDiagnostics?.(`download_error | title=${title} | strategy=${strategyLabel}`);
                      setMenuOpen(false);
                    }}
                  >
                    Copy Diagnostics
                  </button>
                )}
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10"
                  onClick={() => {
                    onOpenFolder?.(id);
                    setMenuOpen(false);
                  }}
                >
                  Open Folder
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-xs text-error hover:bg-error/10"
                  onClick={() => {
                    onDelete?.(id);
                    setMenuOpen(false);
                  }}
                >
                  Remove from List
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="h-1.5 bg-background/50 rounded-full overflow-hidden mb-3 border border-white/5">
          <div
            className={`h-full transition-all duration-300 ${
              status === "finished"
                ? "bg-success shadow-[0_0_8px_rgba(61,220,132,0.3)]"
                : status === "processing"
                ? "bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.3)]"
                : status === "error"
                ? "bg-error"
                : "bg-accent shadow-[0_0_8px_rgba(79,158,255,0.3)]"
            }`}
            style={{
              width: `${progress}%`,
              ...(indeterminate_progress
                ? {
                    minWidth: "18%",
                    backgroundImage:
                      "linear-gradient(90deg, rgba(79,158,255,0.25), rgba(79,158,255,1), rgba(79,158,255,0.25))",
                  }
                : {}),
            }}
          />
        </div>

        {developerModeEnabled && (
          <div className="mb-2 flex flex-wrap gap-1.5 text-[10px] leading-none">
            <span className="rounded border border-border bg-background/70 px-2 py-1 text-gray-400">
              strategy: <span className="text-gray-200">{strategyLabel}</span>
            </span>
            {stream_speed_factor && (
              <span className="rounded border border-border bg-background/70 px-2 py-1 text-gray-400">
                ffmpeg: <span className="text-gray-200">{stream_speed_factor}</span>
              </span>
            )}
            {mainHeaderCount > 0 && (
              <span className="rounded border border-border bg-background/70 px-2 py-1 text-gray-400">
                headers: <span className="text-gray-200">{mainHeaderCount}</span>
              </span>
            )}
            {audio_url && (
              <span className="rounded border border-border bg-background/70 px-2 py-1 text-gray-400">
                audio: <span className="text-gray-200">yes</span>
              </span>
            )}
            {audioHeaderCount > 0 && (
              <span className="rounded border border-border bg-background/70 px-2 py-1 text-gray-400">
                audio hdrs: <span className="text-gray-200">{audioHeaderCount}</span>
              </span>
            )}
            {recovered && (
              <span className="rounded border border-yellow-500/20 bg-yellow-500/10 px-2 py-1 text-yellow-300">
                recovered
              </span>
            )}
          </div>
        )}

        {status !== "finished" && <SegmentVisualizer segments={segments} />}

        {status === "error" && (
          <div className="mt-3 flex items-center justify-between rounded border border-error/20 bg-error/5 px-3 py-2 text-[11px]">
            <span className="truncate pr-3 text-gray-300">{error || "Download failed"}</span>
            <button
              type="button"
              onClick={() => onCopyDiagnostics?.(`download_error | title=${title} | strategy=${strategyLabel}`)}
              className="shrink-0 rounded bg-white/8 px-2.5 py-1 text-gray-100 hover:bg-white/12"
            >
              Copy Diagnostics
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

DownloadCard.displayName = "DownloadCard";
