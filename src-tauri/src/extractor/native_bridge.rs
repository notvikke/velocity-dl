use serde::{Deserialize, Serialize};
use std::io::SeekFrom;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};
use tokio::time::{sleep, Duration};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NativeDownloadRequest {
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
                    match serde_json::from_str::<NativeDownloadRequest>(&line) {
                        Ok(req) => {
                            if req.url.starts_with("http://") || req.url.starts_with("https://") {
                                if let Err(e) = app.emit("external_download_request", req) {
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
