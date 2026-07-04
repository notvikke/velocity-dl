import { deriveAttemptGuidance } from "../lib/attempt-guidance";

interface AttemptStep {
  stepId: string;
  label: string;
  status: "running" | "succeeded" | "failed";
  detail?: string;
  updatedAt?: number;
}

interface AttemptSession {
  id: string;
  title: string;
  url: string;
  status: "running" | "succeeded" | "failed";
  summary?: string;
  steps: AttemptStep[];
  updatedAt?: number;
}

interface Props {
  session: AttemptSession | null;
  onClose: () => void;
}

const statusTone: Record<AttemptStep["status"], string> = {
  running: "border-accent/30 bg-accent/10 text-accent",
  succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  failed: "border-error/30 bg-error/10 text-error",
};

const statusLabel: Record<AttemptStep["status"], string> = {
  running: "RUNNING",
  succeeded: "OK",
  failed: "FAILED",
};

export function DownloadAttemptDialog({ session, onClose }: Props) {
  if (!session) return null;

  const guidance = deriveAttemptGuidance(session);
  const summaryTone =
    session.status === "failed"
      ? "border-error/30 bg-error/10 text-error"
      : session.status === "succeeded"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
        : "border-accent/30 bg-accent/10 text-accent";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close preparation dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
      />
      <div className="relative z-10 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-100">Download Procedure</div>
              <div className="mt-1 truncate text-xs text-gray-400">{session.title}</div>
              <div className="mt-1 truncate text-[11px] text-gray-500">{session.url}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-gray-300 hover:bg-white/5"
            >
              Close
            </button>
          </div>
          {session.summary && (
            <div className={`mt-3 rounded border px-3 py-2 text-[11px] ${summaryTone}`}>
              {session.summary}
            </div>
          )}
          {guidance && (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="rounded border border-border bg-background/60 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                  {session.status === "failed" ? "Failure Reason" : "Outcome"}
                </div>
                <div className="mt-1 text-[12px] leading-5 text-gray-200">{guidance.reason}</div>
                {guidance.sourceStepLabel && (
                  <div className="mt-2 text-[10px] text-gray-500">
                    Source step: {guidance.sourceStepLabel}
                  </div>
                )}
              </div>
              <div className="rounded border border-border bg-background/60 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                  Next Action
                </div>
                <div className="mt-1 text-[12px] leading-5 text-gray-200">{guidance.nextAction}</div>
                {guidance.routeLabel && (
                  <div className="mt-2 text-[10px] text-gray-500">
                    Route used: {guidance.routeLabel}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 py-4">
          {session.steps.length === 0 && (
            <div className="rounded border border-border bg-background/50 px-3 py-3 text-sm text-gray-400">
              Waiting for the first preparation step...
            </div>
          )}
          {session.steps.map((step) => (
            <div
              key={step.stepId}
              className={`rounded-lg border px-3 py-3 ${statusTone[step.status]}`}
            >
              <div className="flex items-center justify-between gap-4 text-xs font-semibold">
                <span className="text-gray-100">{step.label}</span>
                <span>{statusLabel[step.status]}</span>
              </div>
              {step.updatedAt && (
                <div className="mt-1 text-[10px] text-gray-400">
                  {new Date(step.updatedAt).toLocaleTimeString()}
                </div>
              )}
              {step.detail && (
                <div className="mt-1 text-[11px] leading-5 text-gray-300">{step.detail}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
