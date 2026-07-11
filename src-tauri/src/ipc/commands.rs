use crate::engine::manager::DownloadManager;
use crate::engine::settings::AppSettings;
use crate::extractor::{
    binaries,
    native_bridge::{
        mark_external_capture_listener_ready, write_capture_ack, CaptureAckPayload,
        ExtensionHealthState, NativeRequestBody,
    },
    webview, ytdlp,
};
use crate::protocols::strategy::{classify_media_strategy, MediaStrategy};
use reqwest::header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, RANGE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use tokio::time::{timeout, Duration};

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
    pub download_origin: Option<String>,
    pub browser_source: Option<String>,
    pub browser_confidence: Option<String>,
    pub browser_request_id: Option<String>,
    pub original_url: Option<String>,
    pub referrer: Option<String>,
    pub request_method: Option<String>,
    pub request_body: Option<NativeRequestBody>,
    pub network_request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtensionHealthResponse {
    pub install_url: String,
    pub setup_url: String,
    pub last_heartbeat_at_ms: Option<u64>,
    pub last_seen_browser: Option<String>,
    pub last_seen_extension_version: Option<String>,
    pub last_seen_runtime_id: Option<String>,
    pub status: String,
    pub status_label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrowserIntegrationStatus {
    pub extension_directory: Option<String>,
    pub native_host_path: Option<String>,
    pub webstore_extension_id: String,
    pub webstore_install_url: String,
    pub chrome_available: bool,
    pub helium_available: bool,
    pub edge_available: bool,
    pub chrome_manifest_installed: bool,
    pub chromium_manifest_installed: bool,
    pub helium_manifest_installed: bool,
    pub edge_manifest_installed: bool,
    pub chrome_manifest_path: Option<String>,
    pub chromium_manifest_path: Option<String>,
    pub helium_manifest_path: Option<String>,
    pub edge_manifest_path: Option<String>,
    pub chrome_registered_manifest_path: Option<String>,
    pub chromium_registered_manifest_path: Option<String>,
    pub helium_registered_manifest_path: Option<String>,
    pub edge_registered_manifest_path: Option<String>,
    pub chrome_manifest_extension_id: Option<String>,
    pub chromium_manifest_extension_id: Option<String>,
    pub helium_manifest_extension_id: Option<String>,
    pub edge_manifest_extension_id: Option<String>,
    pub last_seen_runtime_id: Option<String>,
    pub last_seen_browser: Option<String>,
    pub last_heartbeat_at_ms: Option<u64>,
    pub chrome_runtime_matches_manifest: bool,
    pub chromium_runtime_matches_manifest: bool,
    pub helium_runtime_matches_manifest: bool,
    pub edge_runtime_matches_manifest: bool,
    pub chrome_manifest_id_readable: bool,
    pub chromium_manifest_id_readable: bool,
    pub helium_manifest_id_readable: bool,
    pub edge_manifest_id_readable: bool,
    pub docs_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrowserIntegrationInstallResult {
    pub message: String,
    pub chrome_manifest_path: Option<String>,
    pub edge_manifest_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolStatusResponse {
    pub name: String,
    pub installed: bool,
    pub source: String,
    pub path: Option<String>,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub update_supported: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
struct DownloadAttemptEvent {
    session_id: String,
    step_id: String,
    label: String,
    status: AttemptStatus,
    detail: Option<String>,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum AttemptStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserManifestKind {
    ChromeLike,
    Edge,
}

#[derive(Debug, Clone, Copy)]
struct NativeBrowserTarget {
    id: &'static str,
    label: &'static str,
    registry_key: &'static str,
    root_value_registry_key: Option<&'static str>,
    manifest_kind: BrowserManifestKind,
    install_url: &'static str,
    extensions_url: &'static str,
}

const CHROME_WEB_STORE_EXTENSION_ID: &str = "alnagakehjhbfkdianlkmcncefldpmhm";
const CHROME_WEB_STORE_INSTALL_URL: &str =
    "https://chromewebstore.google.com/detail/velocitydl-bridge/alnagakehjhbfkdianlkmcncefldpmhm";
const FALLBACK_SETUP_URL: &str =
    "https://github.com/notvikke/velocity-dl/blob/main/BROWSER_INTEGRATION_SETUP.md";

fn native_browser_targets() -> &'static [NativeBrowserTarget] {
    const TARGETS: &[NativeBrowserTarget] = &[
        NativeBrowserTarget {
            id: "chromium",
            label: "Chromium",
            registry_key: r"HKCU\Software\Chromium\NativeMessagingHosts\com.velocitydl.native_host",
            root_value_registry_key: Some(r"HKCU\Software\Chromium\NativeMessagingHosts"),
            manifest_kind: BrowserManifestKind::ChromeLike,
            install_url: CHROME_WEB_STORE_INSTALL_URL,
            extensions_url: "chrome://extensions",
        },
        NativeBrowserTarget {
            id: "chrome",
            label: "Chrome",
            registry_key: r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.velocitydl.native_host",
            root_value_registry_key: None,
            manifest_kind: BrowserManifestKind::ChromeLike,
            install_url: CHROME_WEB_STORE_INSTALL_URL,
            extensions_url: "chrome://extensions",
        },
        NativeBrowserTarget {
            id: "helium",
            label: "Helium",
            registry_key: r"HKCU\Software\imput\Helium\NativeMessagingHosts\com.velocitydl.native_host",
            root_value_registry_key: Some(r"HKCU\Software\imput\Helium\NativeMessagingHosts"),
            manifest_kind: BrowserManifestKind::ChromeLike,
            install_url: CHROME_WEB_STORE_INSTALL_URL,
            extensions_url: "chrome://extensions",
        },
        NativeBrowserTarget {
            id: "edge",
            label: "Edge",
            registry_key: r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.velocitydl.native_host",
            root_value_registry_key: None,
            manifest_kind: BrowserManifestKind::Edge,
            install_url: CHROME_WEB_STORE_INSTALL_URL,
            extensions_url: "edge://extensions",
        },
    ];

    TARGETS
}

fn strategy_hint_to_media_strategy(hint: Option<&str>) -> Option<MediaStrategy> {
    match hint.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "direct_file" => Some(MediaStrategy::DirectFile),
        "hls_manifest" => Some(MediaStrategy::HlsManifest),
        "dash_manifest" => Some(MediaStrategy::DashManifest),
        "metadata_extractor" => Some(MediaStrategy::MetadataExtractor),
        _ => None,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolingStatusResponse {
    pub ytdlp: ToolStatusResponse,
    pub ffmpeg: ToolStatusResponse,
}

#[cfg(windows)]
fn apply_launch_on_startup(enabled: bool) -> Result<(), String> {
    use std::process::Command;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_value = format!("\"{}\"", exe.display());

    let status = if enabled {
        Command::new("reg")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "VelocityDL",
                "/t",
                "REG_SZ",
                "/d",
                &exe_value,
                "/f",
            ])
            .status()
            .map_err(|e| e.to_string())?
    } else {
        Command::new("reg")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "VelocityDL",
                "/f",
            ])
            .status()
            .map_err(|e| e.to_string())?
    };

    if status.success() || !enabled {
        Ok(())
    } else {
        Err("Failed to update Windows startup registration".to_string())
    }
}

#[cfg(not(windows))]
fn apply_launch_on_startup(_enabled: bool) -> Result<(), String> {
    Ok(())
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

fn map_tool_status(status: binaries::ToolStatus) -> ToolStatusResponse {
    ToolStatusResponse {
        name: status.name.to_string(),
        installed: status.installed,
        source: status.source,
        path: status.path,
        current_version: status.current_version,
        latest_version: status.latest_version,
        update_available: status.update_available,
        update_supported: status.update_supported,
        last_error: status.last_error,
    }
}

fn emit_download_attempt<R: Runtime>(
    app: &AppHandle<R>,
    session_id: Option<&str>,
    step_id: &str,
    label: impl Into<String>,
    status: AttemptStatus,
    detail: Option<String>,
) {
    let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) else {
        return;
    };

    let _ = app.emit(
        "download_attempt",
        DownloadAttemptEvent {
            session_id: session_id.to_string(),
            step_id: step_id.to_string(),
            label: label.into(),
            status,
            detail,
        },
    );
}

async fn auth_cookie_header<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let auth_manager = app.try_state::<crate::auth::store::AuthManager>()?;
    auth_manager.get_cookies_as_header().await
}

fn validate_extension_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return Err("Extension ID is required".to_string());
    }
    if trimmed.len() != 32 || !trimmed.chars().all(|ch| ('a'..='p').contains(&ch)) {
        return Err("Extension ID must be a 32-character Chromium extension ID".to_string());
    }
    Ok(trimmed)
}

#[cfg(windows)]
fn find_browser_executable(browser: &str) -> Option<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);

    let candidates = match browser {
        "chrome" => vec![
            local_app_data
                .as_ref()
                .map(|base| base.join("Google\\Chrome\\Application\\chrome.exe")),
            program_files
                .as_ref()
                .map(|base| base.join("Google\\Chrome\\Application\\chrome.exe")),
            program_files_x86
                .as_ref()
                .map(|base| base.join("Google\\Chrome\\Application\\chrome.exe")),
        ],
        "edge" => vec![
            local_app_data
                .as_ref()
                .map(|base| base.join("Microsoft\\Edge\\Application\\msedge.exe")),
            program_files
                .as_ref()
                .map(|base| base.join("Microsoft\\Edge\\Application\\msedge.exe")),
            program_files_x86
                .as_ref()
                .map(|base| base.join("Microsoft\\Edge\\Application\\msedge.exe")),
        ],
        "helium" => vec![
            local_app_data
                .as_ref()
                .map(|base| base.join("imput\\Helium\\Application\\chrome.exe")),
        ],
        _ => Vec::new(),
    };

    candidates.into_iter().flatten().find(|path| path.exists())
}

#[cfg(not(windows))]
fn find_browser_executable(_browser: &str) -> Option<PathBuf> {
    None
}

fn native_manifest_output_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA is not available".to_string())?;
    Ok(appdata.join("com.velocitydl.desktop").join("native-messaging"))
}

fn native_host_install_dir() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not available".to_string())?;
    Ok(local_app_data.join("VelocityDL").join("native-host"))
}

fn extension_install_dir() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not available".to_string())?;
    Ok(local_app_data.join("VelocityDL").join("chromium-extension"))
}

fn push_native_host_target_candidates(candidates: &mut Vec<PathBuf>, target_dir: &Path) {
    candidates.push(target_dir.join("release").join("vdl_native_host.exe"));
    candidates.push(
        target_dir
            .join("release")
            .join("native-host")
            .join("vdl_native_host.exe"),
    );
    candidates.push(target_dir.join("debug").join("vdl_native_host.exe"));
    candidates.push(
        target_dir
            .join("debug")
            .join("native-host")
            .join("vdl_native_host.exe"),
    );
}

fn resolve_bundled_resource<R: Runtime>(app: &AppHandle<R>, relative_path: &str) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join(relative_path))
        .filter(|path| path.exists())
}

fn resolve_extension_directory<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(install_dir) = extension_install_dir() {
        candidates.push(install_dir);
    }
    if let Some(path) = resolve_bundled_resource(app, "chromium-extension") {
        candidates.push(path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("resources").join("chromium-extension"));
            candidates.push(parent.join("chromium-extension"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("chromium-extension"));
    }

    candidates
        .into_iter()
        .find(|path| path.exists() && path.join("manifest.json").exists())
}

fn resolve_native_host_executable<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(install_dir) = native_host_install_dir() {
        candidates.push(install_dir.join("vdl_native_host.exe"));
    }
    if let Some(path) = resolve_bundled_resource(app, "native-host/vdl_native_host.exe") {
        candidates.push(path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("resources").join("native-host").join("vdl_native_host.exe"));
            candidates.push(parent.join("vdl_native_host.exe"));
            candidates.push(parent.join("native-host").join("vdl_native_host.exe"));
        }
    }
    if let Some(target_dir) = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from) {
        push_native_host_target_candidates(&mut candidates, &target_dir);
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_native_host_target_candidates(&mut candidates, &cwd.join("target-devrun"));
        push_native_host_target_candidates(&mut candidates, &cwd.join("src-tauri").join("target-devrun"));
        push_native_host_target_candidates(&mut candidates, &cwd.join("src-tauri").join("target"));
    }

    candidates.into_iter().find(|path| path.exists())
}

#[cfg(windows)]
fn stage_native_host_executable<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let source = resolve_native_host_executable(app)
        .ok_or_else(|| "VelocityDL native host binary was not found in this build".to_string())?;
    let install_dir = native_host_install_dir()?;
    std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
    let staged = install_dir.join("vdl_native_host.exe");
    std::fs::copy(&source, &staged).map_err(|e| {
        format!(
            "Failed to stage native host from '{}' to '{}': {}",
            source.display(),
            staged.display(),
            e
        )
    })?;
    Ok(staged)
}

#[cfg(windows)]
fn registry_default_value(registry_key: &str) -> Option<String> {
    registry_named_value(registry_key, None)
}

#[cfg(windows)]
fn registry_named_value(registry_key: &str, value_name: Option<&str>) -> Option<String> {
    use std::process::Command;

    let mut command = Command::new("reg");
    command.args(["query", registry_key]);
    match value_name {
        Some(value_name) => {
            command.args(["/v", value_name]);
        }
        None => {
            command.arg("/ve");
        }
    }

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        if line.contains("REG_SZ") {
            line.split_once("REG_SZ")
                .map(|(_, value)| value.trim().to_string())
                .filter(|value| !value.is_empty())
        } else {
            None
        }
    })
}

fn manifest_extension_id(manifest_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(manifest_path).ok()?;
    let normalized = raw.trim_start_matches('\u{feff}');
    let parsed = serde_json::from_str::<serde_json::Value>(normalized).ok()?;
    parsed
        .get("allowed_origins")
        .and_then(|v| v.as_array())
        .and_then(|origins| origins.first())
        .and_then(|origin| origin.as_str())
        .and_then(|origin| {
            let prefix = "chrome-extension://";
            origin
                .strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix('/'))
                .map(|s| s.to_string())
        })
}

fn browser_matches_manifest_kind(browser: Option<&str>, manifest_kind: BrowserManifestKind) -> bool {
    let Some(browser) = browser else {
        return false;
    };
    match manifest_kind {
        BrowserManifestKind::ChromeLike => {
            browser.eq_ignore_ascii_case("chromium")
                || browser.eq_ignore_ascii_case("chrome")
                || browser.eq_ignore_ascii_case("helium")
        }
        BrowserManifestKind::Edge => browser.eq_ignore_ascii_case("edge"),
    }
}

fn browser_target(browser: &str) -> Option<&'static NativeBrowserTarget> {
    native_browser_targets()
        .iter()
        .find(|target| target.id.eq_ignore_ascii_case(browser))
}

fn manifest_path_for_kind(manifest_dir: &Path, manifest_kind: BrowserManifestKind) -> PathBuf {
    match manifest_kind {
        BrowserManifestKind::ChromeLike => {
            manifest_dir.join("com.velocitydl.native_host.chrome.json")
        }
        BrowserManifestKind::Edge => manifest_dir.join("com.velocitydl.native_host.edge.json"),
    }
}

fn manifest_prefix_for_kind(manifest_kind: BrowserManifestKind) -> &'static str {
    match manifest_kind {
        BrowserManifestKind::ChromeLike => "chrome",
        BrowserManifestKind::Edge => "chrome",
    }
}

fn default_extension_id_for_manifest_kind(manifest_kind: BrowserManifestKind) -> &'static str {
    match manifest_kind {
        BrowserManifestKind::ChromeLike | BrowserManifestKind::Edge => {
            CHROME_WEB_STORE_EXTENSION_ID
        }
    }
}

#[cfg(windows)]
fn registered_manifest_status_for_target(
    target: &NativeBrowserTarget,
    expected_manifest_path: &Path,
) -> (Option<String>, bool) {
    let default_path = registry_default_value(target.registry_key);
    let root_path = target
        .root_value_registry_key
        .and_then(|registry_key| registry_named_value(registry_key, Some("com.velocitydl.native_host")));

    let default_matches = default_path
        .as_ref()
        .map(|value| PathBuf::from(value) == expected_manifest_path)
        .unwrap_or(false);
    let root_matches = match root_path.as_ref() {
        Some(value) => PathBuf::from(value) == expected_manifest_path,
        None => target.root_value_registry_key.is_none(),
    };

    let display_path = match (root_path, default_path) {
        (Some(root), Some(default))
            if PathBuf::from(&root) != expected_manifest_path
                || PathBuf::from(&default) != expected_manifest_path =>
        {
            if PathBuf::from(&root) != expected_manifest_path {
                Some(root)
            } else {
                Some(default)
            }
        }
        (Some(root), _) => Some(root),
        (None, Some(default)) => Some(default),
        (None, None) => None,
    };

    (display_path, default_matches && root_matches)
}

fn resolve_browser_extension_id(
    explicit_id: Option<String>,
    manifest_id: Option<String>,
    heartbeat_browser: Option<&str>,
    heartbeat_runtime_id: Option<&str>,
    manifest_kind: BrowserManifestKind,
) -> Result<Option<String>, String> {
    if let Some(value) = explicit_id.filter(|value| !value.trim().is_empty()) {
        return validate_extension_id(&value).map(Some);
    }
    if let Some(value) = manifest_id.filter(|value| !value.trim().is_empty()) {
        return validate_extension_id(&value).map(Some);
    }
    if browser_matches_manifest_kind(heartbeat_browser, manifest_kind) {
        if let Some(value) = heartbeat_runtime_id.filter(|value| !value.trim().is_empty()) {
            return validate_extension_id(value).map(Some);
        }
    }
    validate_extension_id(default_extension_id_for_manifest_kind(manifest_kind)).map(Some)
}

#[cfg(windows)]
fn write_native_manifest(
    out_path: &Path,
    host_exe_path: &Path,
    extension_id: &str,
    browser_prefix: &str,
) -> Result<(), String> {
    let manifest = serde_json::json!({
        "name": "com.velocitydl.native_host",
        "description": "VelocityDL Native Messaging Host",
        "path": host_exe_path,
        "type": "stdio",
        "allowed_origins": [format!("{browser_prefix}-extension://{extension_id}/")],
    });
    let raw = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(out_path, raw).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn set_native_messaging_registry_value(registry_key: &str, manifest_path: &Path) -> Result<(), String> {
    set_registry_string_value(registry_key, None, manifest_path)
}

#[cfg(windows)]
fn set_native_messaging_registry_named_value(
    registry_key: &str,
    value_name: &str,
    manifest_path: &Path,
) -> Result<(), String> {
    set_registry_string_value(registry_key, Some(value_name), manifest_path)
}

#[cfg(windows)]
fn set_registry_string_value(
    registry_key: &str,
    value_name: Option<&str>,
    manifest_path: &Path,
) -> Result<(), String> {
    use std::process::Command;

    let mut command = Command::new("reg");
    command.arg("add").arg(registry_key);
    match value_name {
        Some(value_name) => {
            command.args(["/v", value_name]);
        }
        None => {
            command.arg("/ve");
        }
    }
    let status = command
        .args(["/t", "REG_SZ", "/d", &manifest_path.to_string_lossy(), "/f"])
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to register native host at '{}'",
            registry_key
        ))
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

fn is_page_like_content_type(content_type: &str) -> bool {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    matches!(
        ct.as_str(),
        "text/html"
            | "application/html"
            | "application/xhtml+xml"
            | "application/json"
            | "text/json"
            | "application/xml"
            | "text/xml"
            | "application/javascript"
            | "text/javascript"
    )
}

fn is_downloadable_file_extension(ext: &str) -> bool {
    matches!(
        ext.trim().to_ascii_lowercase().as_str(),
        "zip"
            | "7z"
            | "rar"
            | "tar"
            | "gz"
            | "bz2"
            | "xz"
            | "iso"
            | "exe"
            | "msi"
            | "apk"
            | "dmg"
            | "pkg"
            | "deb"
            | "rpm"
            | "pdf"
            | "epub"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "txt"
            | "csv"
            | "json"
            | "torrent"
    )
}

fn direct_response_looks_downloadable(
    url: &str,
    content_type: Option<&str>,
    content_disposition: Option<&str>,
) -> bool {
    if let Some(disposition) = content_disposition {
        let lower = disposition.to_ascii_lowercase();
        if lower.contains("attachment") || lower.contains("filename=") {
            return true;
        }
    }

    if let Some(content_type) = content_type {
        if is_media_content_type(content_type) {
            return true;
        }
        if is_page_like_content_type(content_type) {
            return false;
        }
        let ct = content_type
            .split(';')
            .next()
            .unwrap_or(content_type)
            .trim()
            .to_ascii_lowercase();
        if ct.starts_with("application/") || ct.starts_with("image/") || ct == "text/plain" {
            return true;
        }
    }

    extension_from_path_like(url)
        .map(|ext| is_likely_direct_media_url(url) || is_downloadable_file_extension(&ext))
        .unwrap_or(false)
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

fn is_server_script_extension(ext: &str) -> bool {
    matches!(
        ext.trim().to_ascii_lowercase().as_str(),
        "php" | "asp" | "aspx" | "jsp" | "cgi" | "cfm" | "do" | "action"
    )
}

fn has_trustworthy_filename_hint(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };

    Path::new(value)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| !is_server_script_extension(ext))
        .unwrap_or(false)
}

fn strategy_from_detected_ext(ext: &str) -> MediaStrategy {
    match ext.trim().to_ascii_lowercase().as_str() {
        "m3u8" => MediaStrategy::HlsManifest,
        "mpd" => MediaStrategy::DashManifest,
        _ => MediaStrategy::DirectFile,
    }
}

fn resolve_title_from_hints(
    url: &str,
    provided_title: Option<&str>,
    detected_filename: Option<&str>,
    detected_ext: Option<&str>,
    strategy: MediaStrategy,
) -> String {
    let manifest_ext = extension_from_path_like(url).filter(|ext| ext == "m3u8" || ext == "mpd");
    let mut base = sanitize_filename(
        provided_title
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
            return format!("{}.mp4", sanitize_filename(stem));
        }

        if !is_server_script_extension(&ext) {
            return base;
        }

        if let Some(stem) = Path::new(&base).file_stem().and_then(|s| s.to_str()) {
            base = sanitize_filename(stem);
        }
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
        return format!("{stem}.{output_ext}");
    }

    if let Some(filename) = detected_filename {
        let safe = sanitize_filename(filename);
        if Path::new(&safe).extension().is_some() {
            return safe;
        }
        if base == "browser_capture" || base == "downloaded_media" || Path::new(&base).extension().is_some() {
            base = safe;
        }
    }

    if let Some(ext) = detected_ext {
        return format!("{base}.{ext}");
    }

    if let Some(ext) = extension_from_path_like(url) {
        if !is_server_script_extension(&ext) {
            return format!("{base}.{ext}");
        }
    }

    base
}

async fn probe_direct_media_metadata<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    headers: Option<&HashMap<String, String>>,
) -> Option<ytdlp::YtDlpMetadata> {
    let client = reqwest::Client::builder()
        .user_agent(crate::request_context::DEFAULT_USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;

    let req_headers = crate::request_context::merge_request_headers(
        headers,
        auth_cookie_header(app).await.as_deref(),
    );

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

async fn detect_remote_file_hints<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    headers: Option<&HashMap<String, String>>,
) -> (Option<String>, Option<String>, Option<u64>) {
    let client = reqwest::Client::builder()
        .user_agent(crate::request_context::DEFAULT_USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default();

    let request_headers = crate::request_context::merge_request_headers(
        headers,
        auth_cookie_header(app).await.as_deref(),
    );

    let apply_headers = |mut req: reqwest::RequestBuilder| {
        for (k, v) in &request_headers {
            req = req.header(k, v);
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

#[derive(Debug, Clone)]
struct DirectDownloadProbe {
    content_type: Option<String>,
    content_disposition: Option<String>,
    size: Option<u64>,
}

async fn validate_direct_download_target<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    headers: Option<&HashMap<String, String>>,
    referrer: Option<&str>,
) -> Result<DirectDownloadProbe, String> {
    let client = reqwest::Client::builder()
        .user_agent(crate::request_context::DEFAULT_USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut merged_headers = crate::request_context::merge_request_headers(
        headers,
        auth_cookie_header(app).await.as_deref(),
    );
    if let Some(referrer) = referrer.filter(|value| !value.trim().is_empty()) {
        merged_headers
            .entry("Referer".to_string())
            .or_insert_with(|| referrer.to_string());
    }

    let apply_headers = |mut req: reqwest::RequestBuilder| {
        for (k, v) in &merged_headers {
            req = req.header(k, v);
        }
        req
    };

    let inspect_response = |resp: &reqwest::Response| -> Result<DirectDownloadProbe, String> {
        if !resp.status().is_success() {
            return Err(format!("Direct download validation failed with HTTP {}", resp.status()));
        }

        let content_type = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());
        let content_disposition = resp
            .headers()
            .get(CONTENT_DISPOSITION)
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());
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

        if !direct_response_looks_downloadable(
            url,
            content_type.as_deref(),
            content_disposition.as_deref(),
        ) {
            return Err(format!(
                "Direct URL returned a non-download response ({})",
                content_type
                    .clone()
                    .unwrap_or_else(|| "unknown content type".to_string())
            ));
        }

        Ok(DirectDownloadProbe {
            content_type,
            content_disposition,
            size,
        })
    };

    if let Ok(resp) = apply_headers(client.head(url)).send().await {
        if let Ok(result) = inspect_response(&resp) {
            return Ok(result);
        }
    }

    let resp = apply_headers(client.get(url).header(RANGE, "bytes=0-0"))
        .send()
        .await
        .map_err(|e| format!("Direct download validation request failed: {e}"))?;
    inspect_response(&resp)
}

async fn resolve_download_hints<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    provided_title: Option<String>,
    headers: Option<&HashMap<String, String>>,
    browser_source: Option<&str>,
) -> (String, Option<u64>) {
    let strategy = classify_media_strategy(url);
    if browser_source == Some("chromium-downloads-api")
        && has_trustworthy_filename_hint(provided_title.as_deref())
    {
        return (
            resolve_title_from_hints(url, provided_title.as_deref(), None, None, strategy),
            None,
        );
    }
    let (detected_filename, detected_ext, detected_size) =
        detect_remote_file_hints(app, url, headers).await;
    (
        resolve_title_from_hints(
            url,
            provided_title.as_deref(),
            detected_filename.as_deref(),
            detected_ext.as_deref(),
            strategy,
        ),
        detected_size,
    )
}

#[tauri::command]
pub async fn get_settings<R: Runtime>(app: AppHandle<R>) -> Result<AppSettings, String> {
    let config_dir = crate::pathing::config_dir_for_app(&app)?;
    Ok(AppSettings::load(config_dir).await)
}

#[tauri::command]
pub async fn get_extension_health<R: Runtime>(
    app: AppHandle<R>,
    health: State<'_, ExtensionHealthState>,
) -> Result<ExtensionHealthResponse, String> {
    const HEARTBEAT_FRESH_MS: u64 = 6 * 60 * 1000;
    const HEARTBEAT_STALE_MS: u64 = 24 * 60 * 60 * 1000;

    let snapshot = health.snapshot().await;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let settings = AppSettings::load(crate::pathing::config_dir_for_app(&app)?).await;

    let (status, status_label) = match snapshot.last_heartbeat_at_ms {
        Some(ts) if now_ms.saturating_sub(ts) <= HEARTBEAT_FRESH_MS => (
            "connected".to_string(),
            "Extension Connected".to_string(),
        ),
        Some(ts) if now_ms.saturating_sub(ts) <= HEARTBEAT_STALE_MS => (
            "stale".to_string(),
            "Extension Seen Recently".to_string(),
        ),
        Some(_) => ("inactive".to_string(), "Extension Not Active".to_string()),
        None => ("not_detected".to_string(), "Extension Not Detected".to_string()),
    };

    let status_label = if !settings.accept_browser_download_requests {
        format!("{status_label} (App Capture Disabled)")
    } else {
        status_label
    };

    Ok(ExtensionHealthResponse {
        install_url: CHROME_WEB_STORE_INSTALL_URL.to_string(),
        setup_url: FALLBACK_SETUP_URL.to_string(),
        last_heartbeat_at_ms: snapshot.last_heartbeat_at_ms,
        last_seen_browser: snapshot.last_seen_browser,
        last_seen_extension_version: snapshot.last_seen_extension_version,
        last_seen_runtime_id: snapshot.last_seen_runtime_id,
        status,
        status_label,
    })
}

#[tauri::command]
pub async fn get_browser_integration_status<R: Runtime>(
    app: AppHandle<R>,
    health: State<'_, ExtensionHealthState>,
) -> Result<BrowserIntegrationStatus, String> {
    let manifest_dir = native_manifest_output_dir()?;
    let chrome_manifest = manifest_path_for_kind(&manifest_dir, BrowserManifestKind::ChromeLike);
    let edge_manifest = manifest_path_for_kind(&manifest_dir, BrowserManifestKind::Edge);
    let chrome_manifest_id = manifest_extension_id(&chrome_manifest);
    let edge_manifest_id = manifest_extension_id(&edge_manifest);
    let chrome_manifest_id_readable = chrome_manifest_id.is_some();
    let edge_manifest_id_readable = edge_manifest_id.is_some();
    let health_snapshot = health.snapshot().await;
    let last_runtime_id = health_snapshot.last_seen_runtime_id.clone();
    let last_browser = health_snapshot.last_seen_browser.clone();
    let chrome_runtime_matches_manifest = browser_matches_manifest_kind(
        last_browser.as_deref(),
        BrowserManifestKind::ChromeLike,
    )
        && last_runtime_id.is_some()
        && last_runtime_id == chrome_manifest_id;
    let edge_runtime_matches_manifest = browser_matches_manifest_kind(
        last_browser.as_deref(),
        BrowserManifestKind::Edge,
    )
        && last_runtime_id.is_some()
        && last_runtime_id == edge_manifest_id;

    #[cfg(windows)]
    let (chrome_registered_manifest_path, chrome_registered) = registered_manifest_status_for_target(
        browser_target("chrome").expect("chrome target"),
        &chrome_manifest,
    );
    #[cfg(not(windows))]
    let (chrome_registered_manifest_path, chrome_registered): (Option<String>, bool) = (None, false);
    #[cfg(windows)]
    let (chromium_registered_manifest_path, chromium_registered) = registered_manifest_status_for_target(
        browser_target("chromium").expect("chromium target"),
        &chrome_manifest,
    );
    #[cfg(not(windows))]
    let (chromium_registered_manifest_path, chromium_registered): (Option<String>, bool) = (None, false);
    #[cfg(windows)]
    let (helium_registered_manifest_path, helium_registered) = registered_manifest_status_for_target(
        browser_target("helium").expect("helium target"),
        &chrome_manifest,
    );
    #[cfg(not(windows))]
    let (helium_registered_manifest_path, helium_registered): (Option<String>, bool) = (None, false);
    #[cfg(windows)]
    let (edge_registered_manifest_path, edge_registered) = registered_manifest_status_for_target(
        browser_target("edge").expect("edge target"),
        &edge_manifest,
    );
    #[cfg(not(windows))]
    let (edge_registered_manifest_path, edge_registered): (Option<String>, bool) = (None, false);

    Ok(BrowserIntegrationStatus {
        extension_directory: resolve_extension_directory(&app)
            .map(|path| path.to_string_lossy().to_string()),
        native_host_path: resolve_native_host_executable(&app)
            .map(|path| path.to_string_lossy().to_string()),
        webstore_extension_id: CHROME_WEB_STORE_EXTENSION_ID.to_string(),
        webstore_install_url: CHROME_WEB_STORE_INSTALL_URL.to_string(),
        chrome_available: find_browser_executable("chrome").is_some(),
        helium_available: find_browser_executable("helium").is_some(),
        edge_available: find_browser_executable("edge").is_some(),
        chrome_manifest_installed: chrome_manifest.exists() && chrome_registered,
        chromium_manifest_installed: chrome_manifest.exists() && chromium_registered,
        helium_manifest_installed: chrome_manifest.exists() && helium_registered,
        edge_manifest_installed: edge_manifest.exists() && edge_registered,
        chrome_manifest_path: chrome_manifest.exists().then(|| chrome_manifest.to_string_lossy().to_string()),
        chromium_manifest_path: chrome_manifest.exists().then(|| chrome_manifest.to_string_lossy().to_string()),
        helium_manifest_path: chrome_manifest.exists().then(|| chrome_manifest.to_string_lossy().to_string()),
        edge_manifest_path: edge_manifest.exists().then(|| edge_manifest.to_string_lossy().to_string()),
        chrome_registered_manifest_path,
        chromium_registered_manifest_path,
        helium_registered_manifest_path,
        edge_registered_manifest_path,
        chrome_manifest_extension_id: chrome_manifest_id,
        chromium_manifest_extension_id: manifest_extension_id(&chrome_manifest),
        helium_manifest_extension_id: manifest_extension_id(&chrome_manifest),
        edge_manifest_extension_id: edge_manifest_id,
        last_seen_runtime_id: last_runtime_id,
        last_seen_browser: last_browser,
        last_heartbeat_at_ms: health_snapshot.last_heartbeat_at_ms,
        chrome_runtime_matches_manifest,
        chromium_runtime_matches_manifest: chrome_runtime_matches_manifest,
        helium_runtime_matches_manifest: chrome_runtime_matches_manifest,
        edge_runtime_matches_manifest,
        chrome_manifest_id_readable,
        chromium_manifest_id_readable: manifest_extension_id(&chrome_manifest).is_some(),
        helium_manifest_id_readable: manifest_extension_id(&chrome_manifest).is_some(),
        edge_manifest_id_readable,
        docs_url: FALLBACK_SETUP_URL.to_string(),
    })
}

#[tauri::command]
pub async fn get_tooling_status<R: Runtime>(
    app: AppHandle<R>,
    include_remote: Option<bool>,
) -> Result<ToolingStatusResponse, String> {
    let include_remote = include_remote.unwrap_or(false);
    let ytdlp = binaries::get_ytdlp_status(&app, include_remote).await;
    let ffmpeg = binaries::get_ffmpeg_status(&app, include_remote).await;

    Ok(ToolingStatusResponse {
        ytdlp: map_tool_status(ytdlp),
        ffmpeg: map_tool_status(ffmpeg),
    })
}

#[tauri::command]
pub async fn update_tool_binary<R: Runtime>(
    app: AppHandle<R>,
    tool: String,
) -> Result<ToolStatusResponse, String> {
    let normalized = tool.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "yt-dlp" | "ytdlp" => {
            binaries::update_ytdlp(&app).await.map_err(|e| e.to_string())?;
            Ok(map_tool_status(binaries::get_ytdlp_status(&app, true).await))
        }
        "ffmpeg" => {
            binaries::update_ffmpeg(&app).await.map_err(|e| e.to_string())?;
            Ok(map_tool_status(binaries::get_ffmpeg_status(&app, true).await))
        }
        _ => Err("Unsupported tool update target".to_string()),
    }
}

#[tauri::command]
pub async fn open_browser_install_page<R: Runtime>(
    _app: AppHandle<R>,
    browser: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::process::Command;

        let browser_key = browser.trim().to_ascii_lowercase();
        let target =
            browser_target(&browser_key).ok_or_else(|| "Unsupported browser".to_string())?;
        let browser_exe = find_browser_executable(target.id)
            .ok_or_else(|| format!("{} is not installed on this PC", target.label))?;

        Command::new(browser_exe)
            .arg("--new-window")
            .arg(target.install_url)
            .spawn()
            .map_err(|e| e.to_string())?;

        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Browser-specific setup is only implemented on Windows right now".to_string())
}

#[tauri::command]
pub async fn open_browser_extensions_page<R: Runtime>(
    _app: AppHandle<R>,
    browser: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::process::Command;

        let browser_key = browser.trim().to_ascii_lowercase();
        let target =
            browser_target(&browser_key).ok_or_else(|| "Unsupported browser".to_string())?;
        let browser_exe = find_browser_executable(target.id)
            .ok_or_else(|| format!("{} is not installed on this PC", target.label))?;

        Command::new(browser_exe)
            .arg("--new-window")
            .arg(target.extensions_url)
            .spawn()
            .map_err(|e| e.to_string())?;

        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Browser-specific setup is only implemented on Windows right now".to_string())
}

#[tauri::command]
pub async fn install_browser_integration<R: Runtime>(
    app: AppHandle<R>,
    chrome_extension_id: Option<String>,
    edge_extension_id: Option<String>,
) -> Result<BrowserIntegrationInstallResult, String> {
    #[cfg(windows)]
    {
        let host_path = stage_native_host_executable(&app)?;
        let manifest_dir = native_manifest_output_dir()?;
        std::fs::create_dir_all(&manifest_dir).map_err(|e| e.to_string())?;
        let chrome_manifest = manifest_path_for_kind(&manifest_dir, BrowserManifestKind::ChromeLike);
        let edge_manifest = manifest_path_for_kind(&manifest_dir, BrowserManifestKind::Edge);
        let health_snapshot = app.state::<ExtensionHealthState>().snapshot().await;

        let chrome_id = resolve_browser_extension_id(
            chrome_extension_id,
            manifest_extension_id(&chrome_manifest),
            health_snapshot.last_seen_browser.as_deref(),
            health_snapshot.last_seen_runtime_id.as_deref(),
            BrowserManifestKind::ChromeLike,
        )?;
        let edge_id = resolve_browser_extension_id(
            edge_extension_id,
            manifest_extension_id(&edge_manifest),
            health_snapshot.last_seen_browser.as_deref(),
            health_snapshot.last_seen_runtime_id.as_deref(),
            BrowserManifestKind::Edge,
        )?;

        let mut installed = Vec::new();
        let mut chrome_manifest_path = None;
        let mut edge_manifest_path = None;

        if let Some(chrome_id) = chrome_id {
            write_native_manifest(
                &chrome_manifest,
                &host_path,
                &chrome_id,
                manifest_prefix_for_kind(BrowserManifestKind::ChromeLike),
            )?;
            for target in native_browser_targets()
                .iter()
                .filter(|target| target.manifest_kind == BrowserManifestKind::ChromeLike)
            {
                set_native_messaging_registry_value(target.registry_key, &chrome_manifest)?;
                if let Some(registry_key) = target.root_value_registry_key {
                    set_native_messaging_registry_named_value(
                        registry_key,
                        "com.velocitydl.native_host",
                        &chrome_manifest,
                    )?;
                }
                installed.push(target.label);
            }
            chrome_manifest_path = Some(chrome_manifest.to_string_lossy().to_string());
        }

        if let Some(edge_id) = edge_id {
            write_native_manifest(
                &edge_manifest,
                &host_path,
                &edge_id,
                manifest_prefix_for_kind(BrowserManifestKind::Edge),
            )?;
            for target in native_browser_targets()
                .iter()
                .filter(|target| target.manifest_kind == BrowserManifestKind::Edge)
            {
                set_native_messaging_registry_value(target.registry_key, &edge_manifest)?;
                if let Some(registry_key) = target.root_value_registry_key {
                    set_native_messaging_registry_named_value(
                        registry_key,
                        "com.velocitydl.native_host",
                        &edge_manifest,
                    )?;
                }
                installed.push(target.label);
            }
            edge_manifest_path = Some(edge_manifest.to_string_lossy().to_string());
        }

        return Ok(BrowserIntegrationInstallResult {
            message: format!(
                "Native browser integration installed for {}",
                installed.join(" and ")
            ),
            chrome_manifest_path,
            edge_manifest_path,
        });
    }

    #[allow(unreachable_code)]
    Err("Browser integration install is only implemented on Windows right now".to_string())
}

#[tauri::command]
pub async fn open_extension_setup_link<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ack_external_capture_request<R: Runtime>(
    app: AppHandle<R>,
    request_id: String,
    accepted: bool,
    message: Option<String>,
    route_class: Option<String>,
) -> Result<(), String> {
    let config_dir = crate::pathing::config_dir_for_app(&app)?;
    write_capture_ack(
        &config_dir,
        &CaptureAckPayload {
            request_id,
            accepted,
            message: message.unwrap_or_else(|| {
                if accepted {
                    "accepted".to_string()
                } else {
                    "rejected".to_string()
                }
            }),
            route_class,
        },
    )
    .await
}

#[tauri::command]
pub async fn set_external_capture_listener_ready<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    mark_external_capture_listener_ready(&app).await
}

#[tauri::command]
pub async fn reveal_main_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn save_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: AppSettings,
) -> Result<(), String> {
    let config_dir = crate::pathing::config_dir_for_app(&app)?;
    apply_launch_on_startup(settings.launch_on_startup)?;
    settings.save(config_dir).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_metadata<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    headers: Option<HashMap<String, String>>,
    attempt_session_id: Option<String>,
) -> Result<ytdlp::YtDlpMetadata, String> {
    let merged_headers =
        crate::request_context::merge_request_headers(headers.as_ref(), auth_cookie_header(&app).await.as_deref());
    // Step 1: probe direct media first (works for many pasted links even without file extension).
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "direct_probe",
        "Probe direct media response",
        AttemptStatus::Running,
        None,
    );
    if let Some(direct) = probe_direct_media_metadata(&app, &url, Some(&merged_headers)).await {
        emit_download_attempt(
            &app,
            attempt_session_id.as_deref(),
            "direct_probe",
            "Probe direct media response",
            AttemptStatus::Succeeded,
            Some(format!("Resolved as direct {}", direct.ext)),
        );
        return Ok(direct);
    }
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "direct_probe",
        "Probe direct media response",
        AttemptStatus::Failed,
        Some("Response did not validate as direct media".to_string()),
    );

    // Step 2: fallback to yt-dlp for page URLs / extractor-supported sites.
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "resolve_ytdlp",
        "Resolve yt-dlp binary",
        AttemptStatus::Running,
        None,
    );
    let ytdlp_path = binaries::ensure_ytdlp(&app)
        .await
        .map_err(|e| e.to_string())?;
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "resolve_ytdlp",
        "Resolve yt-dlp binary",
        AttemptStatus::Succeeded,
        Some(ytdlp_path.display().to_string()),
    );
    let config_dir = crate::pathing::config_dir_for_app(&app)?;

    let url_clone = url.clone();
    let path_clone = ytdlp_path.clone();
    let config_clone = config_dir.clone();
    let headers_clone = Some(merged_headers.clone());
    let app_for_attempts = app.clone();
    let attempt_id_for_attempts = attempt_session_id.clone();
    let result = timeout(
        Duration::from_secs(45),
        tokio::task::spawn_blocking(move || {
            let mut on_strategy = |label: &str,
                                   state: ytdlp::StrategyAttemptState,
                                   detail: Option<&str>| {
                let status = match state {
                    ytdlp::StrategyAttemptState::Running => AttemptStatus::Running,
                    ytdlp::StrategyAttemptState::Succeeded => AttemptStatus::Succeeded,
                    ytdlp::StrategyAttemptState::Failed => AttemptStatus::Failed,
                };
                emit_download_attempt(
                    &app_for_attempts,
                    attempt_id_for_attempts.as_deref(),
                    &format!("ytdlp_strategy:{}", label.to_ascii_lowercase().replace(' ', "_")),
                    format!("yt-dlp strategy: {label}"),
                    status,
                    detail.map(|value| value.to_string()),
                );
            };
            ytdlp::get_metadata(
                &path_clone,
                &config_clone,
                &url_clone,
                headers_clone,
                &mut on_strategy,
            )
        }),
    )
    .await
    .map_err(|_| "yt-dlp metadata attempt timed out after 45 seconds".to_string())?
    .map_err(|e| e.to_string())?;

    match result {
        Ok(metadata) => Ok(metadata),
        Err(first_err) => {
            // First attempt failed - force-update yt-dlp and retry once
            log::warn!(
                "yt-dlp metadata fetch failed, forcing update and retrying: {}",
                first_err
            );
            emit_download_attempt(
                &app,
                attempt_session_id.as_deref(),
                "update_ytdlp",
                "Update yt-dlp and retry",
                AttemptStatus::Running,
                Some(first_err.to_string()),
            );
            if let Ok(()) = binaries::update_ytdlp(&app).await {
                emit_download_attempt(
                    &app,
                    attempt_session_id.as_deref(),
                    "update_ytdlp",
                    "Update yt-dlp and retry",
                    AttemptStatus::Succeeded,
                    None,
                );
                let refreshed_ytdlp_path = binaries::ensure_ytdlp(&app)
                    .await
                    .map_err(|e| e.to_string())?;
                let url_retry = url.clone();
                let path_retry = refreshed_ytdlp_path;
                let config_retry = config_dir.clone();
                let headers_retry = headers.clone();
                let app_for_retry_attempts = app.clone();
                let attempt_id_for_retry = attempt_session_id.clone();
                let retry_result = timeout(
                    Duration::from_secs(45),
                    tokio::task::spawn_blocking(move || {
                        let mut on_strategy = |label: &str,
                                               state: ytdlp::StrategyAttemptState,
                                               detail: Option<&str>| {
                            let status = match state {
                                ytdlp::StrategyAttemptState::Running => AttemptStatus::Running,
                                ytdlp::StrategyAttemptState::Succeeded => AttemptStatus::Succeeded,
                                ytdlp::StrategyAttemptState::Failed => AttemptStatus::Failed,
                            };
                            emit_download_attempt(
                                &app_for_retry_attempts,
                                attempt_id_for_retry.as_deref(),
                                &format!(
                                    "retry_ytdlp_strategy:{}",
                                    label.to_ascii_lowercase().replace(' ', "_")
                                ),
                                format!("yt-dlp retry strategy: {label}"),
                                status,
                                detail.map(|value| value.to_string()),
                            );
                        };
                        ytdlp::get_metadata(
                            &path_retry,
                            &config_retry,
                            &url_retry,
                            headers_retry,
                            &mut on_strategy,
                        )
                    }),
                )
                .await
                .map_err(|_| "yt-dlp retry timed out after 45 seconds".to_string())?
                .map_err(|e| e.to_string())?;

                match retry_result {
                    Ok(metadata) => Ok(metadata),
                    Err(retry_err) => {
                        // Step 3: final fallback to direct probe in case extractor failed
                        // but URL resolves to media bytes.
                        if let Some(direct) =
                            probe_direct_media_metadata(&app, &url, Some(&merged_headers)).await
                        {
                            Ok(direct)
                        } else {
                            emit_download_attempt(
                                &app,
                                attempt_session_id.as_deref(),
                                "update_ytdlp",
                                "Update yt-dlp and retry",
                                AttemptStatus::Failed,
                                Some(retry_err.to_string()),
                            );
                            Err(retry_err.to_string())
                        }
                    }
                }
            } else {
                emit_download_attempt(
                    &app,
                    attempt_session_id.as_deref(),
                    "update_ytdlp",
                    "Update yt-dlp and retry",
                    AttemptStatus::Failed,
                    Some("Auto-update failed".to_string()),
                );
                if let Some(direct) = probe_direct_media_metadata(&app, &url, Some(&merged_headers)).await {
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
    attempt_session_id: Option<String>,
    strategy_hint: Option<String>,
    download_origin: Option<String>,
    browser_source: Option<String>,
    browser_confidence: Option<String>,
    browser_request_id: Option<String>,
    original_url: Option<String>,
    referrer: Option<String>,
    request_method: Option<String>,
    request_body: Option<NativeRequestBody>,
    network_request_id: Option<String>,
) -> Result<DownloadItem, String> {
    let id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let normalized_request_method = request_method
        .as_deref()
        .unwrap_or("GET")
        .trim()
        .to_ascii_uppercase();
    if normalized_request_method != "GET" && normalized_request_method != "POST" {
        return Err(format!("Unsupported browser request method '{normalized_request_method}'"));
    }
    if normalized_request_method == "POST" && request_body.is_none() {
        return Err("The browser reported a POST download but its body was unavailable. Re-submit the download from the browser.".to_string());
    }
    let merged_probe_headers =
        crate::request_context::merge_request_headers(headers.as_ref(), auth_cookie_header(&app).await.as_deref());
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "classify_strategy",
        "Classify download strategy",
        AttemptStatus::Running,
        None,
    );
    let mut strategy = if normalized_request_method == "POST" {
        MediaStrategy::DirectFile
    } else {
        strategy_hint_to_media_strategy(strategy_hint.as_deref())
            .unwrap_or_else(|| classify_media_strategy(&url))
    };
    if normalized_request_method == "GET" && audio_url.is_none() && matches!(strategy, MediaStrategy::MetadataExtractor) {
        emit_download_attempt(
            &app,
            attempt_session_id.as_deref(),
            "validate_direct_url",
            "Validate queued URL as downloadable media",
            AttemptStatus::Running,
            None,
        );
        if let Some(direct) = probe_direct_media_metadata(&app, &url, Some(&merged_probe_headers)).await {
            strategy = strategy_from_detected_ext(&direct.ext);
            emit_download_attempt(
                &app,
                attempt_session_id.as_deref(),
                "validate_direct_url",
                "Validate queued URL as downloadable media",
                AttemptStatus::Succeeded,
                Some(format!("Detected direct {}", direct.ext)),
            );
        } else {
            emit_download_attempt(
                &app,
                attempt_session_id.as_deref(),
                "validate_direct_url",
                "Validate queued URL as downloadable media",
                AttemptStatus::Failed,
                Some("URL behaved like a page, not a direct file".to_string()),
            );
            return Err(
                "This URL behaved like a web page instead of a direct downloadable file. Open the metadata picker and let VelocityDL try extractor strategies."
                    .to_string(),
            );
        }
    }
    let mut direct_download_probe: Option<DirectDownloadProbe> = None;
    if normalized_request_method == "GET" && audio_url.is_none() && matches!(strategy, MediaStrategy::DirectFile) {
        emit_download_attempt(
            &app,
            attempt_session_id.as_deref(),
            "validate_direct_url",
            "Validate direct download response",
            AttemptStatus::Running,
            None,
        );
        match validate_direct_download_target(&app, &url, headers.as_ref(), referrer.as_deref()).await {
            Ok(validation) => {
                let detail = validation
                    .content_type
                    .clone()
                    .or(validation.content_disposition.clone())
                    .unwrap_or_else(|| "Downloadable response confirmed".to_string());
                direct_download_probe = Some(validation);
                emit_download_attempt(
                    &app,
                    attempt_session_id.as_deref(),
                    "validate_direct_url",
                    "Validate direct download response",
                    AttemptStatus::Succeeded,
                    Some(detail),
                );
            }
            Err(error) => {
                emit_download_attempt(
                    &app,
                    attempt_session_id.as_deref(),
                    "validate_direct_url",
                    "Validate direct download response",
                    AttemptStatus::Failed,
                    Some(error.clone()),
                );
                return Err(format!(
                    "{error}. The browser handoff URL did not validate as a real downloadable file response, so VelocityDL stopped before queueing a fake completion."
                ));
            }
        }
    }
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "classify_strategy",
        "Classify download strategy",
        AttemptStatus::Succeeded,
        Some(strategy.as_str().to_string()),
    );
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "resolve_title",
        "Resolve output filename",
        AttemptStatus::Running,
        None,
    );
    let (final_title, detected_size) = if normalized_request_method == "POST" {
        (
            resolve_title_from_hints(&url, title.as_deref(), None, None, strategy),
            None,
        )
    } else {
        resolve_download_hints(
            &app,
            &url,
            title,
            headers.as_ref(),
            browser_source.as_deref(),
        )
        .await
    };
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "resolve_title",
        "Resolve output filename",
        AttemptStatus::Succeeded,
        Some(final_title.clone()),
    );
    let resolved_total_size = if normalized_request_method == "POST" {
        0
    } else { match total_size {
        Some(v) if v > 0 => v,
        _ => direct_download_probe
            .as_ref()
            .and_then(|probe| probe.size)
            .or(detected_size)
            .unwrap_or(0),
    }};

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
        download_origin,
        browser_source,
        browser_confidence,
        browser_request_id,
        original_url,
        referrer,
        request_method: Some(normalized_request_method),
        request_body,
        network_request_id,
    };

    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "queue_download",
        "Queue download worker",
        AttemptStatus::Running,
        None,
    );
    manager.start_download(app.clone(), item.clone()).await;
    emit_download_attempt(
        &app,
        attempt_session_id.as_deref(),
        "queue_download",
        "Queue download worker",
        AttemptStatus::Succeeded,
        Some(item.id.clone()),
    );

    Ok(item)
}

#[tauri::command]
pub async fn get_app_diagnostics<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let config_dir = crate::pathing::config_dir_for_app(&app)?;
    let app_data_dir = crate::pathing::app_data_dir_for_app(&app)?;
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
pub async fn delete_download_artifacts(
    output_path: String,
    title: String,
    has_audio_track: bool,
) -> Result<(), String> {
    let final_output_path = std::path::PathBuf::from(output_path).join(title);
    let candidate_paths =
        crate::delete_artifacts::candidate_artifact_paths(&final_output_path, has_audio_track);

    let parent = final_output_path
        .parent()
        .ok_or_else(|| "Invalid download path".to_string())?
        .to_path_buf();

    for artifact_path in &candidate_paths {
        if tokio::fs::try_exists(artifact_path)
            .await
            .map_err(|e| e.to_string())?
        {
            let _ = tokio::fs::remove_file(artifact_path).await;
        }
    }

    let mut dir = match tokio::fs::read_dir(&parent).await {
        Ok(dir) => dir,
        Err(_) => return Ok(()),
    };

    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        if candidate_paths
            .iter()
            .any(|artifact| crate::delete_artifacts::matches_artifact_family(&path, artifact))
        {
            let _ = tokio::fs::remove_file(path).await;
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

#[cfg(test)]
mod tests {
    use super::{
        direct_response_looks_downloadable, has_trustworthy_filename_hint,
        is_page_like_content_type, native_browser_targets, resolve_title_from_hints,
        resolve_browser_extension_id, strategy_from_detected_ext,
        strategy_hint_to_media_strategy, BrowserManifestKind,
    };
    use crate::protocols::strategy::MediaStrategy;

    #[test]
    fn suspicious_server_script_title_uses_detected_filename() {
        let title = resolve_title_from_hints(
            "https://example.com/download.php?id=9",
            Some("download.php"),
            Some("invoice.pdf"),
            Some("pdf"),
            MediaStrategy::MetadataExtractor,
        );

        assert_eq!(title, "invoice.pdf");
    }

    #[test]
    fn detected_extension_replaces_server_script_suffix() {
        let title = resolve_title_from_hints(
            "https://example.com/file.php",
            Some("file.php"),
            None,
            Some("mp4"),
            MediaStrategy::MetadataExtractor,
        );

        assert_eq!(title, "file.mp4");
    }

    #[test]
    fn direct_probe_extension_maps_to_runtime_strategy() {
        assert_eq!(strategy_from_detected_ext("m3u8"), MediaStrategy::HlsManifest);
        assert_eq!(strategy_from_detected_ext("mpd"), MediaStrategy::DashManifest);
        assert_eq!(strategy_from_detected_ext("mp4"), MediaStrategy::DirectFile);
    }

    #[test]
    fn trustworthy_filename_hint_accepts_normal_archive_name() {
        assert!(has_trustworthy_filename_hint(Some(
            "DokiDoki_Message_v2.0.1 (1).zip"
        )));
    }

    #[test]
    fn trustworthy_filename_hint_rejects_server_script_name() {
        assert!(!has_trustworthy_filename_hint(Some("download.php")));
    }

    #[test]
    fn trustworthy_filename_hint_rejects_missing_extension() {
        assert!(!has_trustworthy_filename_hint(Some("download")));
    }

    #[test]
    fn strategy_hint_maps_to_media_strategy() {
        assert_eq!(
            strategy_hint_to_media_strategy(Some("direct_file")),
            Some(MediaStrategy::DirectFile)
        );
        assert_eq!(
            strategy_hint_to_media_strategy(Some("hls_manifest")),
            Some(MediaStrategy::HlsManifest)
        );
        assert_eq!(
            strategy_hint_to_media_strategy(Some("dash_manifest")),
            Some(MediaStrategy::DashManifest)
        );
        assert_eq!(strategy_hint_to_media_strategy(Some("unknown")), None);
    }

    #[test]
    fn browser_downloads_api_takeover_rejects_page_like_direct_validation() {
        assert!(!direct_response_looks_downloadable(
            "https://store1.gofile.io/download/web/xyz/NTRonpa_Public_DebugV3.zip",
            Some("text/html; charset=UTF-8"),
            None,
        ));
    }

    #[test]
    fn non_takeover_or_non_direct_browser_routes_still_validate_direct_downloads() {
        assert!(direct_response_looks_downloadable(
            "https://example.com/download/NTRonpa_Public_DebugV3.zip",
            Some("application/octet-stream"),
            None,
        ));
        assert!(direct_response_looks_downloadable(
            "https://example.com/download",
            Some("text/html"),
            Some("attachment; filename=\"NTRonpa_Public_DebugV3.zip\""),
        ));
    }

    #[test]
    fn page_like_content_types_are_rejected_for_direct_download_validation() {
        assert!(is_page_like_content_type("text/html; charset=utf-8"));
        assert!(is_page_like_content_type("application/json"));
        assert!(!is_page_like_content_type("application/octet-stream"));
    }

    #[test]
    fn direct_download_validation_accepts_binary_and_attachment_responses() {
        assert!(direct_response_looks_downloadable(
            "https://example.com/file.7z",
            Some("application/octet-stream"),
            None,
        ));
        assert!(direct_response_looks_downloadable(
            "https://example.com/download",
            Some("text/html"),
            Some("attachment; filename=\"archive.7z\""),
        ));
    }

    #[test]
    fn direct_download_validation_rejects_page_responses() {
        assert!(!direct_response_looks_downloadable(
            "https://store.gofile.io/download/web/abc/file.7z",
            Some("text/html; charset=utf-8"),
            None,
        ));
        assert!(!direct_response_looks_downloadable(
            "https://example.com/api/download",
            Some("application/json"),
            None,
        ));
    }

    #[test]
    fn native_browser_targets_include_helium_registry_root() {
        let helium = native_browser_targets()
            .iter()
            .find(|target| target.id == "helium")
            .expect("expected Helium browser target");

        assert_eq!(
            helium.registry_key,
            r"HKCU\Software\imput\Helium\NativeMessagingHosts\com.velocitydl.native_host"
        );
        assert_eq!(
            helium.root_value_registry_key,
            Some(r"HKCU\Software\imput\Helium\NativeMessagingHosts")
        );
        assert_eq!(helium.manifest_kind, BrowserManifestKind::ChromeLike);
    }

    #[test]
    fn native_browser_targets_include_chromium_fallback_registry_root() {
        let chromium = native_browser_targets()
            .iter()
            .find(|target| target.id == "chromium")
            .expect("expected Chromium browser target");

        assert_eq!(
            chromium.registry_key,
            r"HKCU\Software\Chromium\NativeMessagingHosts\com.velocitydl.native_host"
        );
        assert_eq!(
            chromium.root_value_registry_key,
            Some(r"HKCU\Software\Chromium\NativeMessagingHosts")
        );
        assert_eq!(chromium.manifest_kind, BrowserManifestKind::ChromeLike);
    }

    #[test]
    fn chrome_like_browser_targets_use_webstore_install_page() {
        let chrome = native_browser_targets()
            .iter()
            .find(|target| target.id == "chrome")
            .expect("expected Chrome browser target");
        let helium = native_browser_targets()
            .iter()
            .find(|target| target.id == "helium")
            .expect("expected Helium browser target");

        assert_eq!(
            chrome.install_url,
            "https://chromewebstore.google.com/detail/velocitydl-bridge/alnagakehjhbfkdianlkmcncefldpmhm"
        );
        assert_eq!(helium.install_url, chrome.install_url);
    }

    #[test]
    fn chrome_like_manifest_defaults_to_webstore_extension_id() {
        let resolved = resolve_browser_extension_id(
            None,
            None,
            None,
            None,
            BrowserManifestKind::ChromeLike,
        )
        .expect("resolution should not fail");

        assert_eq!(
            resolved.as_deref(),
            Some("alnagakehjhbfkdianlkmcncefldpmhm")
        );
    }

    #[test]
    fn chrome_like_targets_share_the_same_manifest_kind() {
        let targets = native_browser_targets();
        let chrome = targets
            .iter()
            .find(|target| target.id == "chrome")
            .expect("expected Chrome browser target");
        let chromium = targets
            .iter()
            .find(|target| target.id == "chromium")
            .expect("expected Chromium browser target");
        let helium = targets
            .iter()
            .find(|target| target.id == "helium")
            .expect("expected Helium browser target");

        assert_eq!(chrome.manifest_kind, BrowserManifestKind::ChromeLike);
        assert_eq!(chromium.manifest_kind, BrowserManifestKind::ChromeLike);
        assert_eq!(helium.manifest_kind, BrowserManifestKind::ChromeLike);
    }
}
