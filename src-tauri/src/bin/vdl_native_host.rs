use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize, Deserialize)]
struct NativeMessage {
    action: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    scan_auto_open_quality_picker: Option<bool>,
    #[serde(default)]
    capture_type: Option<String>,
    #[serde(default)]
    raw_media_url: Option<String>,
    #[serde(default)]
    headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    browser: Option<String>,
    #[serde(default)]
    extension_version: Option<String>,
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    sent_at_ms: Option<u64>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    wait_for_ack: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct NativeResponse {
    ok: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    accept_browser_download_requests: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_takeover_all_downloads: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    accepted: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AppSettingsSnapshot {
    #[serde(default = "default_true")]
    accept_browser_download_requests: bool,
    #[serde(default = "default_true")]
    browser_takeover_all_downloads: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct CaptureAckPayload {
    request_id: String,
    accepted: bool,
    message: String,
}

fn default_true() -> bool {
    true
}

fn app_config_dir() -> Result<PathBuf, String> {
    let appdata = env::var("APPDATA").map_err(|e| format!("APPDATA not set: {}", e))?;
    Ok(PathBuf::from(appdata).join("com.velocitydl.desktop"))
}

fn write_json_response(resp: &NativeResponse) -> Result<(), String> {
    let bytes = serde_json::to_vec(resp).map_err(|e| e.to_string())?;
    let len = (bytes.len() as u32).to_le_bytes();
    let mut stdout = io::stdout();
    stdout.write_all(&len).map_err(|e| e.to_string())?;
    stdout.write_all(&bytes).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

fn load_settings_snapshot() -> AppSettingsSnapshot {
    let settings_path = match app_config_dir() {
        Ok(dir) => dir.join("settings.json"),
        Err(_) => return AppSettingsSnapshot {
            accept_browser_download_requests: true,
            browser_takeover_all_downloads: true,
        },
    };

    match fs::read_to_string(settings_path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(AppSettingsSnapshot {
            accept_browser_download_requests: true,
            browser_takeover_all_downloads: true,
        }),
        Err(_) => AppSettingsSnapshot {
            accept_browser_download_requests: true,
            browser_takeover_all_downloads: true,
        },
    }
}

fn capture_ack_dir(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("native_capture_acks")
}

fn capture_ack_path(config_dir: &PathBuf, request_id: &str) -> PathBuf {
    capture_ack_dir(config_dir).join(format!("{request_id}.json"))
}

fn wait_for_capture_ack(request_id: &str, timeout: Duration) -> Result<Option<CaptureAckPayload>, String> {
    let config_dir = app_config_dir()?;
    fs::create_dir_all(capture_ack_dir(&config_dir)).map_err(|e| e.to_string())?;
    let ack_path = capture_ack_path(&config_dir, request_id);
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if ack_path.exists() {
            let raw = fs::read_to_string(&ack_path)
                .map_err(|e| format!("Failed to read capture ack '{}': {}", ack_path.display(), e))?;
            let parsed = serde_json::from_str::<CaptureAckPayload>(&raw)
                .map_err(|e| format!("Invalid capture ack JSON '{}': {}", ack_path.display(), e))?;
            let _ = fs::remove_file(&ack_path);
            return Ok(Some(parsed));
        }
        thread::sleep(Duration::from_millis(150));
    }

    Ok(None)
}

fn read_native_message() -> Result<Option<NativeMessage>, String> {
    let mut stdin = io::stdin();
    let mut len_buf = [0u8; 4];
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(format!("Failed to read message length: {}", e)),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > 4 * 1024 * 1024 {
        return Err(format!("Invalid native message length: {}", len));
    }
    let mut data = vec![0u8; len];
    stdin
        .read_exact(&mut data)
        .map_err(|e| format!("Failed to read native message: {}", e))?;
    let parsed = serde_json::from_slice::<NativeMessage>(&data)
        .map_err(|e| format!("Invalid native JSON: {}", e))?;
    Ok(Some(parsed))
}

fn append_to_inbox(msg: &NativeMessage) -> Result<(), String> {
    let config_dir = app_config_dir()?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let inbox = config_dir.join("native_inbox.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&inbox)
        .map_err(|e| format!("Failed to open native inbox '{}': {}", inbox.display(), e))?;
    let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())
}

fn main() -> Result<(), String> {
    loop {
        let message = match read_native_message()? {
            Some(m) => m,
            None => break,
        };

        if message.action == "ping" {
            write_json_response(&NativeResponse {
                ok: true,
                message: "pong".to_string(),
                accept_browser_download_requests: None,
                browser_takeover_all_downloads: None,
                accepted: None,
            })?;
            continue;
        }

        if message.action == "get_preferences" {
            let prefs = load_settings_snapshot();
            write_json_response(&NativeResponse {
                ok: true,
                message: "preferences".to_string(),
                accept_browser_download_requests: Some(prefs.accept_browser_download_requests),
                browser_takeover_all_downloads: Some(prefs.browser_takeover_all_downloads),
                accepted: None,
            })?;
            continue;
        }

        if message.action == "capture" {
            if message
                .url
                .as_ref()
                .map(|u| u.starts_with("http://") || u.starts_with("https://"))
                != Some(true)
            {
                write_json_response(&NativeResponse {
                    ok: false,
                    message: "capture requires an http(s) url".to_string(),
                    accept_browser_download_requests: None,
                    browser_takeover_all_downloads: None,
                    accepted: Some(false),
                })?;
                continue;
            }
            append_to_inbox(&message)?;
            if message.wait_for_ack == Some(true) {
                let request_id = message
                    .request_id
                    .clone()
                    .ok_or_else(|| "wait_for_ack requires request_id".to_string())?;
                match wait_for_capture_ack(&request_id, Duration::from_secs(12))? {
                    Some(ack) => {
                        write_json_response(&NativeResponse {
                            ok: ack.accepted,
                            message: ack.message,
                            accept_browser_download_requests: None,
                            browser_takeover_all_downloads: None,
                            accepted: Some(ack.accepted),
                        })?;
                    }
                    None => {
                        write_json_response(&NativeResponse {
                            ok: false,
                            message: "Timed out waiting for app handoff confirmation".to_string(),
                            accept_browser_download_requests: None,
                            browser_takeover_all_downloads: None,
                            accepted: Some(false),
                        })?;
                    }
                }
                continue;
            }
            write_json_response(&NativeResponse {
                ok: true,
                message: "queued".to_string(),
                accept_browser_download_requests: None,
                browser_takeover_all_downloads: None,
                accepted: None,
            })?;
            continue;
        }

        if message.action == "heartbeat" {
            append_to_inbox(&message)?;
            write_json_response(&NativeResponse {
                ok: true,
                message: "heartbeat recorded".to_string(),
                accept_browser_download_requests: None,
                browser_takeover_all_downloads: None,
                accepted: None,
            })?;
            continue;
        }

        write_json_response(&NativeResponse {
            ok: false,
            message: format!("unsupported action '{}'", message.action),
            accept_browser_download_requests: None,
            browser_takeover_all_downloads: None,
            accepted: Some(false),
        })?;
    }
    Ok(())
}
