use serde::{Deserialize, Serialize};
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::fs;
use tokio::sync::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};
use tokio::time::{sleep, Duration};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NativeInboxEvent {
    pub action: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub scan_auto_open_quality_picker: Option<bool>,
    #[serde(default)]
    pub capture_type: Option<String>,
    #[serde(default)]
    pub raw_media_url: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub browser: Option<String>,
    #[serde(default)]
    pub extension_version: Option<String>,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub sent_at_ms: Option<u64>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub wait_for_ack: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ExtensionHealthSnapshot {
    #[serde(default)]
    pub last_heartbeat_at_ms: Option<u64>,
    #[serde(default)]
    pub last_seen_browser: Option<String>,
    #[serde(default)]
    pub last_seen_extension_version: Option<String>,
    #[serde(default)]
    pub last_seen_runtime_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtensionHealthEvent {
    pub heartbeat_at_ms: u64,
    pub browser: Option<String>,
    pub extension_version: Option<String>,
    pub runtime_id: Option<String>,
}

pub struct ExtensionHealthState {
    inner: Arc<Mutex<ExtensionHealthSnapshot>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CaptureAckPayload {
    pub request_id: String,
    pub accepted: bool,
    pub message: String,
}

impl Default for ExtensionHealthState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ExtensionHealthSnapshot::default())),
        }
    }
}

impl ExtensionHealthState {
    pub async fn snapshot(&self) -> ExtensionHealthSnapshot {
        self.inner.lock().await.clone()
    }

    async fn replace(&self, next: ExtensionHealthSnapshot) {
        *self.inner.lock().await = next;
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn health_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("extension_health.json")
}

fn capture_ack_dir(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("native_capture_acks")
}

fn capture_ack_path(config_dir: &PathBuf, request_id: &str) -> PathBuf {
    capture_ack_dir(config_dir).join(format!("{request_id}.json"))
}

async fn load_health(config_dir: &PathBuf) -> ExtensionHealthSnapshot {
    let path = health_path(config_dir);
    match fs::read_to_string(path).await {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ExtensionHealthSnapshot::default(),
    }
}

async fn save_health(config_dir: &PathBuf, snapshot: &ExtensionHealthSnapshot) {
    let path = health_path(config_dir);
    if let Ok(raw) = serde_json::to_string_pretty(snapshot) {
        let _ = fs::write(path, raw).await;
    }
}

pub async fn write_capture_ack(config_dir: &PathBuf, payload: &CaptureAckPayload) -> Result<(), String> {
    let ack_dir = capture_ack_dir(config_dir);
    if !ack_dir.exists() {
        fs::create_dir_all(&ack_dir)
            .await
            .map_err(|e| format!("Failed to create ack dir '{}': {}", ack_dir.display(), e))?;
    }
    let ack_path = capture_ack_path(config_dir, &payload.request_id);
    let raw = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    fs::write(&ack_path, raw)
        .await
        .map_err(|e| format!("Failed to write capture ack '{}': {}", ack_path.display(), e))
}

async fn handle_extension_heartbeat<R: Runtime>(
    app: &AppHandle<R>,
    config_dir: &PathBuf,
    event: NativeInboxEvent,
) {
    let heartbeat_at_ms = event.sent_at_ms.unwrap_or_else(current_time_ms);
    let state = app.state::<ExtensionHealthState>();
    let mut snapshot = state.snapshot().await;
    snapshot.last_heartbeat_at_ms = Some(heartbeat_at_ms);
    snapshot.last_seen_browser = event.browser.clone();
    snapshot.last_seen_extension_version = event.extension_version.clone();
    snapshot.last_seen_runtime_id = event.runtime_id.clone();
    state.replace(snapshot.clone()).await;
    save_health(config_dir, &snapshot).await;

    let emitted = ExtensionHealthEvent {
        heartbeat_at_ms,
        browser: event.browser,
        extension_version: event.extension_version,
        runtime_id: event.runtime_id,
    };
    if let Err(e) = app.emit("extension_health_changed", emitted) {
        log::error!("Failed to emit extension_health_changed: {}", e);
    }
}

async fn read_new_lines(path: &PathBuf, offset: &mut u64) -> Vec<String> {
    let file = match fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let metadata = match file.metadata().await {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    if metadata.len() < *offset {
        *offset = 0;
    }

    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(*offset)).await.is_err() {
        return Vec::new();
    }

    let mut lines = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    lines.push(trimmed.to_string());
                }
            }
            Err(_) => break,
        }
    }

    if let Ok(pos) = reader.stream_position().await {
        *offset = pos;
    }

    lines
}

async fn load_offset(cursor_path: &PathBuf) -> Option<u64> {
    match fs::read_to_string(cursor_path).await {
        Ok(raw) => Some(raw.trim().parse::<u64>().unwrap_or(0)),
        Err(_) => None,
    }
}

async fn save_offset(cursor_path: &PathBuf, offset: u64) {
    let _ = fs::write(cursor_path, offset.to_string()).await;
}

pub async fn start_native_inbox_polling<R: Runtime>(app: AppHandle<R>) {
    let config_dir = match app.path().app_config_dir() {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to resolve app config dir for native inbox: {}", e);
            return;
        }
    };
    let inbox_path = config_dir.join("native_inbox.jsonl");
    let cursor_path = config_dir.join("native_inbox.offset");
    let initial_health = load_health(&config_dir).await;
    app.state::<ExtensionHealthState>()
        .replace(initial_health)
        .await;
    let mut offset = match load_offset(&cursor_path).await {
        Some(saved) => saved,
        None => match fs::metadata(&inbox_path).await {
            Ok(meta) => {
                // No cursor yet: avoid replaying old backlog on startup.
                let len = meta.len();
                save_offset(&cursor_path, len).await;
                len
            }
            Err(_) => 0,
        },
    };

    tokio::spawn(async move {
        loop {
            if inbox_path.exists() {
                let lines = read_new_lines(&inbox_path, &mut offset).await;
                for line in lines {
                    match serde_json::from_str::<NativeInboxEvent>(&line) {
                        Ok(event) => {
                            if event.action == "heartbeat" {
                                handle_extension_heartbeat(&app, &config_dir, event).await;
                                continue;
                            }

                            if event.action == "capture"
                                && (event.url.starts_with("http://")
                                    || event.url.starts_with("https://"))
                            {
                                if let Err(e) = app.emit("external_download_request", event) {
                                    log::error!("Failed to emit external_download_request: {}", e);
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("Invalid native inbox JSON line: {}", e);
                        }
                    }
                }
                save_offset(&cursor_path, offset).await;
            }
            sleep(Duration::from_millis(1500)).await;
        }
    });
}
