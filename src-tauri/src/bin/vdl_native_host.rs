use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use velocitydl_lib::extension_identity::{extension_id_from_origin, normalize_extension_id};

#[derive(Debug, Serialize, Deserialize)]
struct NativeMessage {
    action: String,
    #[serde(default)]
    transport_id: Option<String>,
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
    #[serde(default)]
    original_url: Option<String>,
    #[serde(default)]
    browser_confidence: Option<String>,
    #[serde(default)]
    request_method: Option<String>,
    #[serde(default)]
    request_body: Option<NativeRequestBody>,
    #[serde(default)]
    request_body_unavailable: Option<bool>,
    #[serde(default)]
    network_request_id: Option<String>,
    #[serde(default)]
    tab_id: Option<i64>,
    #[serde(default)]
    frame_id: Option<i64>,
    #[serde(default)]
    initiator: Option<String>,
    #[serde(default)]
    document_url: Option<String>,
    #[serde(default)]
    redirect_chain: Vec<String>,
    #[serde(default)]
    context_captured_at_ms: Option<u64>,
    #[serde(default)]
    media_context: Option<serde_json::Value>,
    #[serde(default)]
    refresh_id: Option<String>,
    #[serde(default)]
    refresh_headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct NativeRequestBody {
    encoding: String,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    byte_length: u64,
    #[serde(default)]
    truncated: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    route_class: Option<String>,
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
    route_class: Option<String>,
}

fn default_true() -> bool {
    true
}

fn caller_extension_id_from_args(args: impl IntoIterator<Item = String>) -> Result<String, String> {
    args.into_iter()
        .find_map(|argument| extension_id_from_origin(&argument))
        .ok_or_else(|| "Native messaging caller origin is missing or invalid".to_string())
}

fn bind_trusted_heartbeat_identity(
    message: &mut NativeMessage,
    caller_extension_id: &str,
) -> Result<(), String> {
    let trusted_id = normalize_extension_id(caller_extension_id)
        .ok_or_else(|| "Native messaging caller extension ID is invalid".to_string())?;
    let claimed_id = message
        .runtime_id
        .as_deref()
        .and_then(normalize_extension_id)
        .ok_or_else(|| "Heartbeat runtime extension ID is missing or invalid".to_string())?;
    if claimed_id != trusted_id {
        return Err("Heartbeat runtime extension ID does not match native caller".to_string());
    }
    message.runtime_id = Some(trusted_id);
    Ok(())
}

fn app_config_dir() -> Result<PathBuf, String> {
    let appdata = env::var("APPDATA").map_err(|e| format!("APPDATA not set: {}", e))?;
    Ok(PathBuf::from(appdata).join("com.velocitydl.desktop"))
}

fn app_alive_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("app_alive")
}

fn is_app_running(max_age: Duration) -> bool {
    let Ok(config_dir) = app_config_dir() else {
        return false;
    };
    let path = app_alive_path(&config_dir);
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(last_seen_ms) = raw.trim().parse::<u64>() else {
        return false;
    };
    let now_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    now_ms.saturating_sub(last_seen_ms) <= max_age.as_millis() as u64
}

thread_local! {
    static CURRENT_TRANSPORT_ID: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn serialize_json_response<T: Serialize>(
    resp: &T,
    transport_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut value = serde_json::to_value(resp).map_err(|e| e.to_string())?;
    if let (Some(id), Some(object)) = (transport_id, value.as_object_mut()) {
        object.insert(
            "transport_id".to_string(),
            serde_json::Value::String(id.to_string()),
        );
    }
    serde_json::to_vec(&value).map_err(|e| e.to_string())
}

fn write_json_response<T: Serialize>(resp: &T) -> Result<(), String> {
    let bytes =
        CURRENT_TRANSPORT_ID.with(|id| serialize_json_response(resp, id.borrow().as_deref()))?;
    let len = (bytes.len() as u32).to_le_bytes();
    let mut stdout = io::stdout();
    stdout.write_all(&len).map_err(|e| e.to_string())?;
    stdout.write_all(&bytes).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

fn validate_capture_message(message: &NativeMessage) -> Result<(), String> {
    if message
        .url
        .as_ref()
        .map(|url| url.starts_with("http://") || url.starts_with("https://"))
        != Some(true)
    {
        return Err("capture requires an http(s) url".to_string());
    }
    let method = message
        .request_method
        .as_deref()
        .unwrap_or("GET")
        .to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err(format!("unsupported capture request method '{method}'"));
    }
    if let Some(body) = &message.request_body {
        if body.truncated || body.byte_length > 512 * 1024 {
            return Err("capture request body is truncated or exceeds 512 KiB".to_string());
        }
        if body.encoding != "utf8" && body.encoding != "base64" {
            return Err(format!(
                "unsupported capture body encoding '{}'",
                body.encoding
            ));
        }
        if body.data.is_none() {
            return Err("capture request body data is missing".to_string());
        }
    }
    if method == "POST"
        && message.request_body.is_none()
        && message.request_body_unavailable != Some(true)
    {
        return Err("POST capture requires request body metadata".to_string());
    }
    Ok(())
}

fn load_settings_snapshot() -> AppSettingsSnapshot {
    let settings_path = match app_config_dir() {
        Ok(dir) => dir.join("settings.json"),
        Err(_) => {
            return AppSettingsSnapshot {
                accept_browser_download_requests: true,
                browser_takeover_all_downloads: true,
            }
        }
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

fn wait_for_capture_ack(
    request_id: &str,
    timeout: Duration,
) -> Result<Option<CaptureAckPayload>, String> {
    let config_dir = app_config_dir()?;
    fs::create_dir_all(capture_ack_dir(&config_dir)).map_err(|e| e.to_string())?;
    let ack_path = capture_ack_path(&config_dir, request_id);
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if ack_path.exists() {
            let raw = fs::read_to_string(&ack_path).map_err(|e| {
                format!("Failed to read capture ack '{}': {}", ack_path.display(), e)
            })?;
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
    let caller_extension_id = caller_extension_id_from_args(env::args())?;
    loop {
        let mut message = match read_native_message()? {
            Some(m) => m,
            None => break,
        };
        CURRENT_TRANSPORT_ID.with(|id| *id.borrow_mut() = message.transport_id.clone());

        if message.action == "ping" {
            let running = is_app_running(Duration::from_secs(12));
            write_json_response(&NativeResponse {
                ok: running,
                message: if running {
                    "VelocityDL app is running".to_string()
                } else {
                    "VelocityDL app is not running".to_string()
                },
                accept_browser_download_requests: None,
                browser_takeover_all_downloads: None,
                accepted: None,
                route_class: None,
            })?;
            continue;
        }

        if message.action == "get_preferences" {
            if !is_app_running(Duration::from_secs(12)) {
                write_json_response(&NativeResponse {
                    ok: false,
                    message: "VelocityDL app is not running".to_string(),
                    accept_browser_download_requests: None,
                    browser_takeover_all_downloads: None,
                    accepted: Some(false),
                    route_class: None,
                })?;
                continue;
            }
            let prefs = load_settings_snapshot();
            write_json_response(&NativeResponse {
                ok: true,
                message: "preferences".to_string(),
                accept_browser_download_requests: Some(prefs.accept_browser_download_requests),
                browser_takeover_all_downloads: Some(prefs.browser_takeover_all_downloads),
                accepted: None,
                route_class: None,
            })?;
            continue;
        }

        if message.action == "get_session_refresh_requests" {
            let config_dir = app_config_dir()?;
            let requests =
                velocitydl_lib::browser_session::take_pending_refresh_requests(&config_dir)?;
            write_json_response(&serde_json::json!({
                "ok": true,
                "message": "session refresh requests",
                "refresh_requests": requests,
            }))?;
            continue;
        }

        if message.action == "session_refresh_response" {
            let refresh_id = message
                .refresh_id
                .clone()
                .ok_or_else(|| "session_refresh_response requires refresh_id".to_string())?;
            let headers = message
                .refresh_headers
                .clone()
                .ok_or_else(|| "session_refresh_response requires refresh_headers".to_string())?;
            velocitydl_lib::browser_session::write_refresh_response(
                &app_config_dir()?,
                &velocitydl_lib::browser_session::SessionRefreshResponse {
                    refresh_id,
                    headers,
                    captured_at_ms: message.sent_at_ms.unwrap_or(0),
                },
            )?;
            write_json_response(
                &serde_json::json!({ "ok": true, "message": "session refresh stored" }),
            )?;
            continue;
        }

        if message.action == "capture" {
            if !is_app_running(Duration::from_secs(12)) {
                write_json_response(&NativeResponse {
                    ok: false,
                    message: "VelocityDL app is not running".to_string(),
                    accept_browser_download_requests: None,
                    browser_takeover_all_downloads: None,
                    accepted: Some(false),
                    route_class: None,
                })?;
                continue;
            }
            if let Err(validation_error) = validate_capture_message(&message) {
                write_json_response(&NativeResponse {
                    ok: false,
                    message: validation_error,
                    accept_browser_download_requests: None,
                    browser_takeover_all_downloads: None,
                    accepted: Some(false),
                    route_class: None,
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
                            route_class: ack.route_class,
                        })?;
                    }
                    None => {
                        write_json_response(&NativeResponse {
                            ok: false,
                            message: "Timed out waiting for app handoff confirmation".to_string(),
                            accept_browser_download_requests: None,
                            browser_takeover_all_downloads: None,
                            accepted: Some(false),
                            route_class: None,
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
                route_class: None,
            })?;
            continue;
        }

        if message.action == "heartbeat" {
            if !is_app_running(Duration::from_secs(12)) {
                write_json_response(&NativeResponse {
                    ok: false,
                    message: "VelocityDL app is not running".to_string(),
                    accept_browser_download_requests: None,
                    browser_takeover_all_downloads: None,
                    accepted: Some(false),
                    route_class: None,
                })?;
                continue;
            }
            if let Err(validation_error) =
                bind_trusted_heartbeat_identity(&mut message, &caller_extension_id)
            {
                write_json_response(&NativeResponse {
                    ok: false,
                    message: validation_error,
                    accept_browser_download_requests: None,
                    browser_takeover_all_downloads: None,
                    accepted: Some(false),
                    route_class: None,
                })?;
                continue;
            }
            append_to_inbox(&message)?;
            write_json_response(&NativeResponse {
                ok: true,
                message: "heartbeat recorded".to_string(),
                accept_browser_download_requests: None,
                browser_takeover_all_downloads: None,
                accepted: None,
                route_class: None,
            })?;
            continue;
        }

        write_json_response(&NativeResponse {
            ok: false,
            message: format!("unsupported action '{}'", message.action),
            accept_browser_download_requests: None,
            browser_takeover_all_downloads: None,
            accepted: Some(false),
            route_class: None,
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        bind_trusted_heartbeat_identity, caller_extension_id_from_args, serialize_json_response,
        validate_capture_message, NativeMessage,
    };
    use velocitydl_lib::extension_identity::CHROME_WEB_STORE_EXTENSION_ID;

    #[test]
    fn caller_extension_id_comes_from_chromiums_origin_argument() {
        let id = caller_extension_id_from_args([
            "vdl_native_host.exe".to_string(),
            format!("chrome-extension://{CHROME_WEB_STORE_EXTENSION_ID}/"),
            "--parent-window=0".to_string(),
        ])
        .unwrap();

        assert_eq!(id, CHROME_WEB_STORE_EXTENSION_ID);
    }

    #[test]
    fn caller_extension_id_rejects_missing_or_malformed_origins() {
        assert!(caller_extension_id_from_args([
            "vdl_native_host.exe".to_string(),
            "--parent-window=0".to_string(),
        ])
        .is_err());
        assert!(caller_extension_id_from_args([
            "vdl_native_host.exe".to_string(),
            "https://example.test/".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn caller_identity_replaces_a_matching_heartbeat_claim() {
        let mut message: NativeMessage = serde_json::from_value(serde_json::json!({
            "action": "heartbeat",
            "runtime_id": CHROME_WEB_STORE_EXTENSION_ID.to_uppercase()
        }))
        .unwrap();

        bind_trusted_heartbeat_identity(&mut message, CHROME_WEB_STORE_EXTENSION_ID).unwrap();

        assert_eq!(
            message.runtime_id.as_deref(),
            Some(CHROME_WEB_STORE_EXTENSION_ID)
        );
    }

    #[test]
    fn caller_identity_rejects_a_different_heartbeat_claim() {
        let mut message: NativeMessage = serde_json::from_value(serde_json::json!({
            "action": "heartbeat",
            "runtime_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }))
        .unwrap();

        let error = bind_trusted_heartbeat_identity(&mut message, CHROME_WEB_STORE_EXTENSION_ID)
            .unwrap_err();

        assert!(error.contains("does not match native caller"));
    }

    #[test]
    fn capture_contract_deserializes_post_body_and_network_context() {
        let message: NativeMessage = serde_json::from_value(serde_json::json!({
            "action": "capture",
            "transport_id": "transport-1",
            "url": "https://example.test/export",
            "request_method": "POST",
            "request_body": {
                "encoding": "utf8",
                "content_type": "application/x-www-form-urlencoded",
                "data": "format=csv",
                "byte_length": 10,
                "truncated": false
            },
            "network_request_id": "network-7",
            "tab_id": 4,
            "frame_id": 2,
            "redirect_chain": ["https://example.test/start"]
        }))
        .unwrap();

        assert_eq!(message.transport_id.as_deref(), Some("transport-1"));
        assert_eq!(message.request_method.as_deref(), Some("POST"));
        assert_eq!(
            message
                .request_body
                .as_ref()
                .and_then(|body| body.data.as_deref()),
            Some("format=csv")
        );
        assert_eq!(message.network_request_id.as_deref(), Some("network-7"));
        assert_eq!(message.tab_id, Some(4));
        assert_eq!(message.frame_id, Some(2));
        assert_eq!(message.redirect_chain.len(), 1);
        validate_capture_message(&message).unwrap();
    }

    #[test]
    fn capture_contract_rejects_truncated_or_oversized_bodies() {
        let mut message: NativeMessage = serde_json::from_value(serde_json::json!({
            "action": "capture",
            "url": "https://example.test/export",
            "request_method": "POST",
            "request_body": {
                "encoding": "utf8",
                "data": "x",
                "byte_length": 600000,
                "truncated": true
            }
        }))
        .unwrap();
        assert!(validate_capture_message(&message)
            .unwrap_err()
            .contains("body"));
        message.request_body.as_mut().unwrap().truncated = false;
        assert!(validate_capture_message(&message)
            .unwrap_err()
            .contains("body"));
    }

    #[test]
    fn native_response_echoes_transport_id() {
        let value = serialize_json_response(
            &super::NativeResponse {
                ok: true,
                message: "ok".to_string(),
                accept_browser_download_requests: None,
                browser_takeover_all_downloads: None,
                accepted: None,
                route_class: None,
            },
            Some("transport-9"),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&value).unwrap();
        assert_eq!(parsed["transport_id"], "transport-9");
    }
}
