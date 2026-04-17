import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Folder, Plug, Bell, Radar, Power } from "lucide-react";

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

interface WelcomeSetupModalProps {
  isOpen: boolean;
  initialSettings: AppSettings | null;
  onSave: (settings: AppSettings) => Promise<void>;
}

export function WelcomeSetupModal({
  isOpen,
  initialSettings,
  onSave,
}: WelcomeSetupModalProps) {
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSettings(initialSettings);
    setError("");
    setSaving(false);
  }, [initialSettings, isOpen]);

  if (!settings) {
    return null;
  }

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleContinue = async () => {
    if (!settings) return;
    setSaving(true);
    setError("");
    try {
      await onSave({
        ...settings,
        onboarding_completed: true,
      });
    } catch (err) {
      setError(String((err as Error)?.message || err || "Failed to save preferences."));
      setSaving(false);
    }
  };

  const handleUseDefaults = async () => {
    if (!initialSettings) return;
    setSaving(true);
    setError("");
    try {
      await onSave({
        ...initialSettings,
        onboarding_completed: true,
      });
    } catch (err) {
      setError(String((err as Error)?.message || err || "Failed to save defaults."));
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 24 }}
            className="relative z-10 my-6 flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111111] shadow-2xl"
          >
            <div className="border-b border-white/8 bg-[radial-gradient(circle_at_top,#1d1d1d_0%,#111111_62%)] px-8 py-7">
              <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                <Download size={20} className="text-zinc-100" />
              </div>
              <h2 className="text-2xl font-semibold tracking-[0.04em] text-zinc-100">
                Finish Setup
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
                Pick the defaults VelocityDL should use on this machine. These can be changed later in Settings.
              </p>
            </div>

            <div className="space-y-5 overflow-y-auto px-8 py-7">
              <SettingBlock
                icon={<Folder size={16} />}
                label="Default Download Folder"
                description="New downloads will go here unless you choose a different location."
              >
                <input
                  value={settings.default_download_path}
                  onChange={(e) => updateSetting("default_download_path", e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-white/25"
                />
              </SettingBlock>

              <ToggleBlock
                icon={<Plug size={16} />}
                label="Accept Browser Captures"
                description="Allow the browser extension and native bridge to hand off downloads automatically."
                enabled={settings.accept_browser_download_requests}
                onChange={(value) => updateSetting("accept_browser_download_requests", value)}
              />

              <ToggleBlock
                icon={<Download size={16} />}
                label="Take Over Browser Downloads"
                description="Recommended. Use the browser extension's default handoff mode so standard browser downloads go to VelocityDL."
                enabled={settings.browser_takeover_all_downloads}
                onChange={(value) => updateSetting("browser_takeover_all_downloads", value)}
              />

              <ToggleBlock
                icon={<Radar size={16} />}
                label="Auto-start Captured Streams"
                description="Immediately queue media found through the in-app capture tools."
                enabled={settings.auto_start_sniff_capture}
                onChange={(value) => updateSetting("auto_start_sniff_capture", value)}
              />

              <ToggleBlock
                icon={<Bell size={16} />}
                label="Play Completion Sounds"
                description="Use a short notification sound when downloads finish or fail."
                enabled={settings.play_sound_on_finish || settings.play_sound_on_fail}
                onChange={(value) => {
                  updateSetting("play_sound_on_finish", value);
                  updateSetting("play_sound_on_fail", value);
                }}
              />

              <ToggleBlock
                icon={<Power size={16} />}
                label="Launch On Startup"
                description="Start VelocityDL automatically when you sign in to Windows."
                enabled={settings.launch_on_startup}
                onChange={(value) => updateSetting("launch_on_startup", value)}
              />

              {error && <div className="text-sm text-rose-300">{error}</div>}
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-white/8 bg-white/[0.02] px-8 py-5">
              <p className="text-xs text-zinc-500">
                Installer-ready defaults for this device. You can revisit them at any time.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleUseDefaults}
                  disabled={saving}
                  className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Use Defaults
                </button>
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={saving}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Continue"}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function SettingBlock({
  icon,
  label,
  description,
  children,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="mt-0.5 text-zinc-300">{icon}</div>
        <div>
          <div className="text-sm font-medium text-zinc-100">{label}</div>
          <div className="mt-1 text-xs leading-5 text-zinc-500">{description}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function ToggleBlock({
  icon,
  label,
  description,
  enabled,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingBlock icon={icon} label={label} description={description}>
      <button
        type="button"
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          enabled ? "bg-white" : "bg-zinc-700"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-black transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </SettingBlock>
  );
}
