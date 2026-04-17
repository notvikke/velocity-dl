use crate::engine::manager::DownloadManager;
use crate::engine::settings::AppSettings;
use crate::extractor::{binaries, webview, ytdlp};
use crate::protocols::strategy::{classify_media_strategy, MediaStrategy};
use reqwest::header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, RANGE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub audio_url: Option<String>,
    pub output_path: String,
    pub total_size: u64,
    pub audio_size: Option<u64>,
    pub progress: f32,
    pub speed: String,
    pub eta: String,
    pub status: String,
    pub headers: Option<HashMap<String, String>>,
    pub audio_headers: Option<HashMap<String, String>>,
    pub download_strategy: Option<String>,
}

fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        let safe = match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        };
        out.push(safe);
    }
    let trimmed = out.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "downloaded_media".to_string()
    } else {
        trimmed.to_string()
    }
}

fn extension_from_content_type(content_type: &str) -> Option<&'static str> {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("video/mp4") {
        Some("mp4")
    } else if ct.contains("video/webm") {
        Some("webm")
    } else if ct.contains("video/x-matroska") {
        Some("mkv")
    } else if ct.contains("video/quicktime") {
        Some("mov")
    } else if ct.contains("audio/mpeg") {
        Some("mp3")
    } else if ct.contains("audio/mp4") {
        Some("m4a")
    } else if ct.contains("audio/aac") {
        Some("aac")
    } else if ct.contains("audio/flac") {
        Some("flac")
    } else if ct.contains("audio/wav") {
        Some("wav")
    } else if ct.contains("application/vnd.apple.mpegurl")
        || ct.contains("application/x-mpegurl")
    {
        Some("m3u8")
    } else if ct.contains("application/dash+xml") {
        Some("mpd")
    } else if ct.contains("video/mp2t") {
        Some("ts")
    } else {
        None
    }
}

fn extension_from_path_like(value: &str) -> Option<String> {
    let candidate = value
        .split('/')
        .next_back()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .trim();
    let ext = Path::new(candidate)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext {
        Some(ref e) if !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()) => {
            Some(e.clone())
        }
        _ => None,
    }
}

fn is_likely_direct_media_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    if lower.contains("googlevideo.com") || lower.contains("videoplayback") {
        return true;
    }
    matches!(
        extension_from_path_like(url).as_deref(),
        Some(
            "mp4"
                | "mkv"
                | "webm"
                | "mov"
                | "m4v"
                | "mp3"
                | "m4a"
                | "aac"
                | "flac"
                | "wav"
                | "ogg"
                | "opus"
                | "m3u8"
                | "mpd"
                | "ts"
                | "m4s"
                | "weba"
        )
    )
}

fn is_media_content_type(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.starts_with("video/")
        || ct.starts_with("audio/")
        || ct.contains("application/vnd.apple.mpegurl")
        || ct.contains("application/x-mpegurl")
        || ct.contains("application/dash+xml")
}

fn filename_from_content_disposition(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let key = "filename=";
    let idx = lower.find(key)?;
    let raw = value[idx + key.len()..].trim();
    let cleaned = raw
        .trim_matches(';')
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

async fn probe_direct_media_metadata(
    url: &str,
    headers: Option<&HashMap<String, String>>,
) -> Option<ytdlp::YtDlpMetadata> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
        .build()
        .ok()?;

    let mut req_headers = HashMap::new();
    req_headers.insert(
        "User-Agent".to_string(),
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36".to_string(),
    );
    if let Some(extra) = headers {
        for (k, v) in extra {
            req_headers.insert(k.clone(), v.clone());
        }
    }

    let mut req = client.get(url).header(RANGE, "bytes=0-0");
    for (k, v) in &req_headers {
        req = req.header(k, v);
    }

    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }

    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let media_by_type = is_media_content_type(&content_type);
    let media_by_url = is_likely_direct_media_url(url);
    if !media_by_type && !media_by_url {
        return None;
    }

    let ext = extension_from_content_type(&content_type)
        .map(|v| v.to_string())
        .or_else(|| extension_from_path_like(url))
        .unwrap_or_else(|| {
            if content_type.starts_with("audio/") {
                "m4a".to_string()
            } else if content_type.contains("dash+xml") {
                "mpd".to_string()
            } else if content_type.contains("mpegurl") {
                "m3u8".to_string()
            } else {
                "mp4".to_string()
            }
        });

    let mut size = resp
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    if size.is_none() {
        size = resp
            .headers()
            .get("content-range")
            .and_then(|h| h.to_str().ok())
            .and_then(|v| v.split('/').next_back())
            .and_then(|v| v.parse::<u64>().ok());
    }

    Some(ytdlp::YtDlpMetadata {
        title: "Detected Media Stream".to_string(),
        ext: ext.clone(),
        duration: None,
        webpage_url: url.to_string(),
        thumbnail: None,
        http_headers: Some(req_headers.clone()),
        channel: None,
        uploader: None,
        formats: vec![ytdlp::YtDlpFormat {
            format_id: "direct".to_string(),
            url: url.to_string(),
            ext,
            vcodec: Some("unknown".to_string()),
            acodec: Some("unknown".to_string()),
            filesize: size,
            filesize_approx: None,
            resolution: Some("Original".to_string()),
            height: None,
            width: None,
            format_note: Some("Direct Stream".to_string()),
            fps: None,
            tbr: None,
            vbr: None,
            abr: None,
            container: None,
            http_headers: Some(req_headers),
        }],
    })
}

async fn detect_remote_file_hints(
    url: &str,
    headers: Option<&HashMap<String, String>>,
) -> (Option<String>, Option<String>, Option<u64>) {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default();

    let apply_headers = |mut req: reqwest::RequestBuilder| {
        if let Some(extra) = headers {
            for (k, v) in extra {
                req = req.header(k, v);
            }
        }
        req
    };

    let mut filename: Option<String> = None;
    let mut ext: Option<String> = None;
    let mut size: Option<u64> = None;

    if let Ok(resp) = apply_headers(client.head(url)).send().await {
        if let Some(disposition) = resp.headers().get(CONTENT_DISPOSITION).and_then(|h| h.to_str().ok()) {
            filename = filename_from_content_disposition(disposition);
        }
        if let Some(ct) = resp.headers().get(CONTENT_TYPE).and_then(|h| h.to_str().ok()) {
            ext = extension_from_content_type(ct).map(|v| v.to_string());
        }
        if let Some(cl) = resp
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
        {
            size = Some(cl);
        }
    }

    if filename.is_none() || ext.is_none() || size.is_none() {
        if let Ok(resp) = apply_headers(client.get(url).header(RANGE, "bytes=0-0")).send().await {
            if filename.is_none() {
                if let Some(disposition) = resp.headers().get(CONTENT_DISPOSITION).and_then(|h| h.to_str().ok()) {
                    filename = filename_from_content_disposition(disposition);
                }
            }
            if ext.is_none() {
                if let Some(ct) = resp.headers().get(CONTENT_TYPE).and_then(|h| h.to_str().ok()) {
                    ext = extension_from_content_type(ct).map(|v| v.to_string());
                }
            }
            if size.is_none() {
                if let Some(content_range) = resp
                    .headers()
                    .get("content-range")
                    .and_then(|h| h.to_str().ok())
                {
                    if let Some(total) = content_range.split('/').next_back().and_then(|s| s.parse::<u64>().ok()) {
                        size = Some(total);
                    }
                }
                if size.is_none() {
                    size = resp
                        .headers()
                        .get(CONTENT_LENGTH)
                        .and_then(|h| h.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());
                }
            }
        }
    }

    (filename, ext, size)
}

async fn resolve_download_hints(
    url: &str,
    provided_title: Option<String>,
    headers: Option<&HashMap<String, String>>,
) -> (String, Option<u64>) {
    let strategy = classify_media_strategy(url);
    let manifest_ext = extension_from_path_like(url).filter(|ext| ext == "m3u8" || ext == "mpd");
    let mut base = sanitize_filename(
        provided_title
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| url.split('/').next_back().unwrap_or("downloaded_media")),
    );

    if let Some(ext) = Path::new(&base)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
    {
        if manifest_ext.is_some() && (ext == "m3u8" || ext == "mpd") {
            let stem = Path::new(&base)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("stream_capture");
            return (format!("{}.mp4", sanitize_filename(stem)), None);
        }
        return (base, None);
    }

    if let Some(ext) = manifest_ext {
        let stem = if base == "browser_capture" || base == "downloaded_media" {
            "stream_capture".to_string()
        } else {
            base
        };
        let output_ext = if ext == "mpd" || matches!(strategy, MediaStrategy::DashManifest) {
            "mp4"
        } else {
            "mp4"
        };
        return (format!("{stem}.{output_ext}"), None);
    }

    if let Some(ext) = extension_from_path_like(url) {
        return (format!("{base}.{ext}"), None);
    }

    let (detected_filename, detected_ext, detected_size) = detect_remote_file_hints(url, headers).await;

    if let Some(filename) = detected_filename {
        let safe = sanitize_filename(&filename);
        if Path::new(&safe).extension().is_some() {
            return (safe, detected_size);
        }
        if base == "browser_capture" || base == "downloaded_media" {
            base = safe;
        }
    }

    if let Some(ext) = detected_ext {
        return (format!("{base}.{ext}"), detected_size);
    }

    (base, detected_size)
}

#[tauri::command]
pub async fn get_settings<R: Runtime>(app: AppHandle<R>) -> Result<AppSettings, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(AppSettings::load(config_dir).await)
}

#[tauri::command]
pub async fn save_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: AppSettings,
) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings.save(config_dir).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_metadata<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<ytdlp::YtDlpMetadata, String> {
    // Step 1: probe direct media first (works for many pasted links even without file extension).
    if let Some(direct) = probe_direct_media_metadata(&url, headers.as_ref()).await {
        return Ok(direct);
    }

    // Step 2: fallback to yt-dlp for page URLs / extractor-supported sites.
    let ytdlp_path = binaries::ensure_ytdlp(&app)
        .await
        .map_err(|e| e.to_string())?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;

    // Run yt-dlp in a blocking task to avoid stalling the async runtime
    let url_clone = url.clone();
    let path_clone = ytdlp_path.clone();
    let config_clone = config_dir.clone();
    let headers_clone = headers.clone();
    let result = tokio::task::spawn_blocking(move || {
        ytdlp::get_metadata(&path_clone, &config_clone, &url_clone, headers_clone)
    })
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(metadata) => Ok(metadata),
        Err(first_err) => {
            // First attempt failed — force-update yt-dlp and retry once
            log::warn!(
                "yt-dlp metadata fetch failed, forcing update and retrying: {}",
                first_err
            );
            if let Ok(()) = binaries::update_ytdlp(&app).await {
                let url_retry = url.clone();
                let path_retry = ytdlp_path.clone();
                let config_retry = config_dir.clone();
                let headers_retry = headers.clone();
                let retry_result = tokio::task::spawn_blocking(move || {
                    ytdlp::get_metadata(&path_retry, &config_retry, &url_retry, headers_retry)
                })
                .await
                .map_err(|e| e.to_string())?;

                match retry_result {
                    Ok(metadata) => Ok(metadata),
                    Err(retry_err) => {
                        // Step 3: final fallback to direct probe in case extractor failed
                        // but URL resolves to media bytes.
                        if let Some(direct) =
                            probe_direct_media_metadata(&url, headers.as_ref()).await
                        {
                            Ok(direct)
                        } else {
                            Err(retry_err.to_string())
                        }
                    }
                }
            } else {
                if let Some(direct) = probe_direct_media_metadata(&url, headers.as_ref()).await {
                    Ok(direct)
                } else {
                    Err(first_err.to_string())
                }
            }
        }
    }
}

#[tauri::command]
pub async fn add_download<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, DownloadManager>,
    existing_id: Option<String>,
    url: String,
    audio_url: Option<String>,
    output_path: String,
    title: Option<String>,
    total_size: Option<u64>,
    audio_size: Option<u64>,
    headers: Option<HashMap<String, String>>,
    audio_headers: Option<HashMap<String, String>>,
) -> Result<DownloadItem, String> {
    let id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let strategy = classify_media_strategy(&url);
    let (final_title, detected_size) = resolve_download_hints(&url, title, headers.as_ref()).await;
    let resolved_total_size = match total_size {
        Some(v) if v > 0 => v,
        _ => detected_size.unwrap_or(0),
    };

    let item = DownloadItem {
        id: id.clone(),
        title: final_title,
        url,
        audio_url,
        output_path,
        total_size: resolved_total_size,
        audio_size,
        progress: 0.0,
        speed: "0 B/s".to_string(),
        eta: "Starting...".to_string(),
        status: "active".to_string(),
        headers,
        audio_headers,
        download_strategy: Some(strategy.as_str().to_string()),
    };

    manager.start_download(app, item.clone()).await;

    Ok(item)
}

#[tauri::command]
pub async fn get_app_diagnostics<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let settings = AppSettings::load(config_dir.clone()).await;
    let binaries_dir = crate::extractor::binaries::get_binaries_dir(&app)
        .await
        .map_err(|e| e.to_string())?;
    let telemetry_path = config_dir.join("strategy_telemetry.jsonl");
    let telemetry_tail = match tokio::fs::read_to_string(&telemetry_path).await {
        Ok(content) => content
            .lines()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n"),
        Err(_) => "(none)".to_string(),
    };

    let ffmpeg_path = binaries_dir.join("ffmpeg.exe");
    let ytdlp_path = binaries_dir.join("yt-dlp.exe");

    Ok(format!(
        "VelocityDL Diagnostics\n\
app_version: {}\n\
config_dir: {}\n\
app_data_dir: {}\n\
binaries_dir: {}\n\
ffmpeg_present: {}\n\
ytdlp_present: {}\n\
settings: {}\n\n\
strategy_telemetry_tail:\n{}",
        env!("CARGO_PKG_VERSION"),
        config_dir.display(),
        app_data_dir.display(),
        binaries_dir.display(),
        ffmpeg_path.exists(),
        ytdlp_path.exists(),
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
        telemetry_tail
    ))
}

#[tauri::command]
pub async fn pause_download(manager: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    manager.pause_download(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn open_folder<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::process::Command;
        let path = std::path::Path::new(&path);
        if path.exists() {
            if path.is_file() {
                // Open parent and select file
                Command::new("explorer")
                    .arg("/select,")
                    .arg(path)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            } else {
                // Open folder directly
                Command::new("explorer")
                    .arg(path)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
    }

    // Default or Non-Windows behavior
    let path_obj = std::path::Path::new(&path);
    if path_obj.exists() {
        app.opener()
            .open_path(path_obj.to_string_lossy().to_string(), None::<String>)
            .map_err(|e| e.to_string())?;
    } else if let Some(parent) = path_obj.parent() {
        if parent.exists() {
            app.opener()
                .open_path(parent.to_string_lossy().to_string(), None::<String>)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_sniffing<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    webview::start_sniffer(app, url)
        .await
        .map_err(|e| e.to_string())
}
