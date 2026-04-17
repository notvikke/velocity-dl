use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub default_download_path: PathBuf,
    pub play_sound_on_finish: bool,
    pub play_sound_on_fail: bool,
    #[serde(default)]
    pub auto_start_sniff_capture: bool,
    #[serde(default = "default_true")]
    pub accept_browser_download_requests: bool,
    #[serde(default)]
    pub developer_mode: bool,
    #[serde(default)]
    pub onboarding_completed: bool,
    pub max_threads: u32,
    pub speed_limit_mb: u32,
}

fn default_true() -> bool {
    true
}

async fn migrate_legacy_settings_if_needed(config_dir: &PathBuf) {
    let new_config_path = config_dir.join("settings.json");
    if new_config_path.exists() {
        return;
    }

    let legacy_root = std::env::var("APPDATA")
        .ok()
        .map(PathBuf::from)
        .map(|root| root.join("com.velocitydl.app"));
    let Some(legacy_dir) = legacy_root else {
        return;
    };

    let legacy_settings = legacy_dir.join("settings.json");
    if !legacy_settings.exists() {
        return;
    }

    if !config_dir.exists() {
        let _ = fs::create_dir_all(config_dir).await;
    }
    let _ = fs::copy(&legacy_settings, &new_config_path).await;
}

impl Default for AppSettings {
    fn default() -> Self {
        let download_dir = dirs::download_dir().unwrap_or_else(|| PathBuf::from("C:\\Downloads"));
        Self {
            default_download_path: download_dir.join("VelocityDL"),
            play_sound_on_finish: true,
            play_sound_on_fail: true,
            auto_start_sniff_capture: false,
            accept_browser_download_requests: true,
            developer_mode: false,
            onboarding_completed: false,
            max_threads: 16,
            speed_limit_mb: 0,
        }
    }
}

impl AppSettings {
    pub async fn load(config_dir: PathBuf) -> Self {
        migrate_legacy_settings_if_needed(&config_dir).await;
        let config_path = config_dir.join("settings.json");
        if let Ok(content) = fs::read_to_string(&config_path).await {
            if let Ok(settings) = serde_json::from_str(&content) {
                return settings;
            }
        }
        let default = Self::default();
        let _ = default.save(config_dir).await;
        default
    }

    pub async fn save(&self, config_dir: PathBuf) -> Result<()> {
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir).await?;
        }
        let config_path = config_dir.join("settings.json");
        let content = serde_json::to_string_pretty(self)?;
        fs::write(config_path, content).await?;
        Ok(())
    }
}
