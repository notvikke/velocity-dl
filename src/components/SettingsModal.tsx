import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Settings, Cpu, HardDrive, Bell, Folder, Plug } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { copyAppDiagnosticsToClipboard } from "../lib/diagnostics";

interface AppSettings {
  default_download_path: string;
  play_sound_on_finish: boolean;
  play_sound_on_fail: boolean;
  auto_start_sniff_capture: boolean;
  accept_browser_download_requests: boolean;
  developer_mode: boolean;
  onboarding_completed: boolean;
  max_threads: number;
  speed_limit_mb: number;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState("engine");
  const [diagnosticStatus, setDiagnosticStatus] = useState("");
  const [settings, setSettings] = useState<AppSettings>({
    default_download_path: "",
    play_sound_on_finish: true,
    play_sound_on_fail: true,
    auto_start_sniff_capture: false,
    accept_browser_download_requests: true,
    developer_mode: false,
    onboarding_completed: false,
    max_threads: 16,
    speed_limit_mb: 0
  });

  useEffect(() => {
    if (isOpen) {
      invoke<AppSettings>("get_settings")
        .then(setSettings)
        .catch(console.error);
    }
  }, [isOpen]);

  const handleSave = async () => {
    try {
      await invoke("save_settings", { settings });
      onClose();
    } catch (e) {
      console.error(e);
    }
  };

  const updateSetting = (key: keyof AppSettings, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleCopyDiagnostics = async () => {
    try {
      await copyAppDiagnosticsToClipboard("settings_modal");
      setDiagnosticStatus("Copied app diagnostics");
      window.setTimeout(() => setDiagnosticStatus(""), 1600);
    } catch (e) {
      console.error(e);
      setDiagnosticStatus("Failed to copy diagnostics");
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
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
            className="relative w-full max-w-2xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex min-h-[400px]"
          >
            {/* Sidebar */}
            <div className="w-48 bg-background/50 border-r border-border p-4 space-y-2">
              <SidebarItem 
                icon={<Cpu size={16}/>} 
                label="Engine" 
                active={activeTab === "engine"} 
                onClick={() => setActiveTab("engine")}
              />
              <SidebarItem 
                icon={<HardDrive size={16}/>} 
                label="Storage" 
                active={activeTab === "storage"} 
                onClick={() => setActiveTab("storage")}
              />
              <SidebarItem 
                icon={<Bell size={16}/>} 
                label="Notifications" 
                active={activeTab === "notifications"} 
                onClick={() => setActiveTab("notifications")}
              />
              <SidebarItem
                icon={<Plug size={16} />}
                label="Capture"
                active={activeTab === "capture"}
                onClick={() => setActiveTab("capture")}
              />
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col bg-surface">
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <div className="flex items-center gap-2 font-bold text-gray-200">
                        <Settings size={18} />
                        <span>Settings</span>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <div className="p-6 space-y-6 max-h-[500px] overflow-y-auto flex-1">
                    {activeTab === "engine" && (
                        <section className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-200">
                            <h3 className="text-sm font-bold text-accent uppercase tracking-widest">Download Engine</h3>
                            <div className="space-y-4">
                                <SettingRow 
                                    label="Max Concurrent Threads" 
                                    description="Segments per file (Default: 16)"
                                >
                                    <select 
                                        value={settings.max_threads}
                                        onChange={(e) => updateSetting('max_threads', parseInt(e.target.value))}
                                        className="bg-background border border-border rounded px-2 py-1 text-sm outline-none"
                                    >
                                        <option value={8}>8</option>
                                        <option value={16}>16</option>
                                        <option value={32}>32</option>
                                    </select>
                                </SettingRow>

                                <SettingRow 
                                    label="Global Speed Limit" 
                                    description="Zero for unlimited"
                                >
                                    <div className="flex items-center gap-2">
                                        <input 
                                            value={settings.speed_limit_mb}
                                            onChange={(e) => updateSetting('speed_limit_mb', parseInt(e.target.value) || 0)}
                                            className="w-20 bg-background border border-border rounded px-2 py-1 text-sm outline-none text-right" 
                                            placeholder="0" 
                                        />
                                        <span className="text-xs text-gray-500">MB/s</span>
                                    </div>
                                </SettingRow>
                            </div>
                        </section>
                    )}

                    {activeTab === "storage" && (
                        <section className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-200">
                            <h3 className="text-sm font-bold text-accent uppercase tracking-widest">Storage & Paths</h3>
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-gray-200">Default Download Path</label>
                                    <div className="relative">
                                        <Folder className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
                                        <input 
                                            value={settings.default_download_path}
                                            onChange={(e) => updateSetting('default_download_path', e.target.value)}
                                            className="w-full bg-background border border-border rounded-lg py-2 pl-10 pr-4 outline-none text-sm text-gray-300 focus:border-accent/50"
                                        />
                                    </div>
                                    <p className="text-[11px] text-gray-500">New downloads will be saved here by default.</p>
                                </div>
                            </div>
                        </section>
                    )}

                    {activeTab === "notifications" && (
                        <section className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-200">
                            <h3 className="text-sm font-bold text-accent uppercase tracking-widest">Notifications</h3>
                            <div className="space-y-4">
                                <ToggleRow 
                                    label="Play sound on finish" 
                                    description="Alert when a download completes successfully"
                                    enabled={settings.play_sound_on_finish}
                                    onChange={(v: boolean) => updateSetting('play_sound_on_finish', v)}
                                />
                                <ToggleRow 
                                    label="Play sound on failure" 
                                    description="Alert when a download encounters an error"
                                    enabled={settings.play_sound_on_fail}
                                    onChange={(v: boolean) => updateSetting('play_sound_on_fail', v)}
                                />
                            </div>
                        </section>
                    )}

                    {activeTab === "capture" && (
                        <section className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-200">
                            <h3 className="text-sm font-bold text-accent uppercase tracking-widest">Capture & Debug</h3>
                            <div className="space-y-4">
                                <ToggleRow
                                    label="Auto-start on sniff capture"
                                    description="Immediately queue captured media from Deep Sniff"
                                    enabled={settings.auto_start_sniff_capture}
                                    onChange={(v: boolean) => updateSetting('auto_start_sniff_capture', v)}
                                />
                                <ToggleRow
                                    label="Accept browser extension captures"
                                    description="Allow Chromium extension/native bridge to auto-queue downloads"
                                    enabled={settings.accept_browser_download_requests}
                                    onChange={(v: boolean) => updateSetting('accept_browser_download_requests', v)}
                                />
                                <ToggleRow
                                    label="Developer mode"
                                    description="Show debug tools and capture routing diagnostics"
                                    enabled={settings.developer_mode}
                                    onChange={(v: boolean) => updateSetting('developer_mode', v)}
                                />
                                <SettingRow
                                    label="Copy App Diagnostics"
                                    description="Copies settings, binary status, and recent strategy telemetry"
                                >
                                    <button
                                        type="button"
                                        onClick={handleCopyDiagnostics}
                                        className="rounded bg-white/5 px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                                    >
                                        Copy
                                    </button>
                                </SettingRow>
                                {diagnosticStatus && (
                                    <div className="text-[11px] text-gray-400">{diagnosticStatus}</div>
                                )}
                            </div>
                        </section>
                    )}
                </div>

                <div className="mt-auto p-4 border-t border-border flex justify-end gap-3 bg-surface/50">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={handleSave} className="px-6 py-2 text-sm bg-accent hover:bg-accent/80 text-white rounded font-bold transition-all shadow-lg shadow-accent/20">Save Changes</button>
                </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function SidebarItem({ icon, label, active = false, onClick }: any) {
    return (
      <div 
        onClick={onClick}
        className={`flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors ${
            active ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-white/5 text-gray-500'
        }`}
      >
        {icon}
        <span className="text-sm">{label}</span>
      </div>
    );
}

function SettingRow({ label, description, children }: any) {
    return (
        <div className="flex items-center justify-between py-2">
            <div>
                <div className="font-medium text-gray-200">{label}</div>
                <div className="text-xs text-gray-500">{description}</div>
            </div>
            {children}
        </div>
    );
}

function ToggleRow({ label, description, enabled, onChange }: any) {
    return (
        <div className="flex items-center justify-between py-2">
            <div>
                <div className="font-medium text-gray-200">{label}</div>
                <div className="text-xs text-gray-500">{description}</div>
            </div>
            <div 
                onClick={() => onChange(!enabled)}
                className={`w-10 h-5 rounded-full relative cursor-pointer transition-colors ${enabled ? 'bg-accent' : 'bg-gray-700'}`}
            >
                <motion.div 
                    animate={{ x: enabled ? 22 : 4 }}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    className="absolute top-1 w-3 h-3 bg-white rounded-full shadow-sm" 
                />
            </div>
        </div>
    );
}
