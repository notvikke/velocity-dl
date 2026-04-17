use anyhow::{anyhow, Result};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YtDlpMetadata {
    pub title: String,
    pub ext: String,
    #[serde(default)]
    pub duration: Option<f64>,
    pub webpage_url: String,
    pub formats: Vec<YtDlpFormat>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub http_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub uploader: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YtDlpFormat {
    pub format_id: String,
    pub url: String,
    pub ext: String,
    #[serde(default)]
    pub vcodec: Option<String>,
    #[serde(default)]
    pub acodec: Option<String>,
    #[serde(default)]
    pub filesize: Option<u64>,
    #[serde(default)]
    pub filesize_approx: Option<u64>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub format_note: Option<String>,
    #[serde(default)]
    pub fps: Option<f32>,
    #[serde(default)]
    pub tbr: Option<f32>,
    #[serde(default)]
    pub vbr: Option<f32>,
    #[serde(default)]
    pub abr: Option<f32>,
    #[serde(default)]
    pub http_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub container: Option<String>,
}

struct StrategyProfile {
    name: &'static str,
    patterns: &'static [&'static str],
    cookie_first: bool,
    youtube_client_fallbacks: bool,
    js_heavy_fallback: bool,
    browser_impersonation: bool,
}

struct StrategySpec {
    label: String,
    args: Vec<String>,
}

#[derive(Serialize)]
struct StrategyTelemetryRecord {
    ts_unix_ms: u128,
    host: String,
    url: String,
    profile: String,
    strategy: String,
    used_sniff_headers: bool,
    success: bool,
    error: Option<String>,
    stderr_excerpt: Option<String>,
}

const PROFILES: &[StrategyProfile] = &[
    StrategyProfile {
        name: "youtube",
        patterns: &["youtube.com", "youtu.be", "youtube-nocookie.com"],
        cookie_first: false,
        youtube_client_fallbacks: true,
        js_heavy_fallback: false,
        browser_impersonation: false,
    },
    StrategyProfile {
        name: "cookie-heavy-social",
        patterns: &[
            "x.com",
            "twitter.com",
            "twitch.tv",
            "instagram.com",
            "facebook.com",
            "tiktok.com",
        ],
        cookie_first: true,
        youtube_client_fallbacks: false,
        js_heavy_fallback: false,
        browser_impersonation: false,
    },
    StrategyProfile {
        name: "jable",
        patterns: &["jable.tv"],
        cookie_first: true,
        youtube_client_fallbacks: false,
        js_heavy_fallback: true,
        browser_impersonation: true,
    },
    StrategyProfile {
        name: "js-heavy-video",
        patterns: &[
            "rumble.com",
            "odysee.com",
            "bitchute.com",
            "vimeo.com",
            "dailymotion.com",
        ],
        cookie_first: false,
        youtube_client_fallbacks: false,
        js_heavy_fallback: true,
        browser_impersonation: false,
    },
    StrategyProfile {
        name: "default",
        patterns: &[],
        cookie_first: false,
        youtube_client_fallbacks: false,
        js_heavy_fallback: false,
        browser_impersonation: false,
    },
];

fn normalized_host(url: &str) -> String {
    let without_scheme = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url);
    without_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
        .trim_start_matches("www.")
        .to_string()
}

fn resolve_profile(host: &str) -> &'static StrategyProfile {
    for profile in PROFILES {
        if profile.patterns.iter().any(|p| host.contains(p)) {
            return profile;
        }
    }
    PROFILES.last().expect("profiles must not be empty")
}

fn build_header_args(headers: &HashMap<String, String>) -> Vec<String> {
    let mut args = Vec::new();
    for (k, v) in headers {
        let key = k.trim();
        let value = v.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        args.push("--add-header".to_string());
        args.push(format!("{}: {}", key, value));
    }
    args
}

fn browser_cookie_strategies(prefix: &str) -> Vec<StrategySpec> {
    let mut out = Vec::new();
    for browser in ["edge", "chrome", "brave", "firefox"] {
        out.push(StrategySpec {
            label: format!("{} ({})", prefix, browser),
            args: vec![
                "--cookies-from-browser".to_string(),
                browser.to_string(),
                "--user-agent".to_string(),
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".to_string(),
                "--extractor-retries".to_string(),
                "0".to_string(),
            ],
        });
    }
    out
}

fn strategy_plan(
    profile: &StrategyProfile,
    sniff_headers: Option<&HashMap<String, String>>,
) -> Vec<StrategySpec> {
    let mut plan = Vec::new();
    let base_args = || {
        let mut args = vec!["--extractor-retries".to_string(), "0".to_string()];
        if profile.browser_impersonation {
            args.push("--impersonate".to_string());
            args.push("chrome".to_string());
        }
        args
    };

    if let Some(headers) = sniff_headers {
        let mut args = base_args();
        args.extend(build_header_args(headers));
        plan.push(StrategySpec {
            label: "Sniff headers".to_string(),
            args,
        });
    }

    if profile.cookie_first {
        plan.extend(browser_cookie_strategies("Cookie-first"));
    }

    plan.push(StrategySpec {
        label: "Default (auto)".to_string(),
        args: base_args(),
    });

    if profile.youtube_client_fallbacks {
        plan.push(StrategySpec {
            label: "Web client".to_string(),
            args: vec![
                "--extractor-args".to_string(),
                "youtube:player_client=web".to_string(),
                "--extractor-retries".to_string(),
                "0".to_string(),
            ],
        });
        plan.push(StrategySpec {
            label: "Default minus android_sdkless".to_string(),
            args: vec![
                "--extractor-args".to_string(),
                "youtube:player_client=default,-android_sdkless".to_string(),
                "--extractor-retries".to_string(),
                "0".to_string(),
            ],
        });
        plan.push(StrategySpec {
            label: "Mobile Web client".to_string(),
            args: vec![
                "--extractor-args".to_string(),
                "youtube:player_client=mweb".to_string(),
                "--no-check-certificates".to_string(),
                "--extractor-retries".to_string(),
                "0".to_string(),
            ],
        });
    }

    if !profile.cookie_first {
        plan.extend(browser_cookie_strategies("Browser cookies"));
    }

    if profile.js_heavy_fallback {
        plan.push(StrategySpec {
            label: "JS-heavy fallback".to_string(),
            args: vec![
                "--js-runtimes".to_string(),
                "node".to_string(),
                "--extractor-retries".to_string(),
                "0".to_string(),
            ],
        });
    }

    plan
}

fn append_telemetry(config_dir: &PathBuf, record: &StrategyTelemetryRecord) {
    let path = config_dir.join("strategy_telemetry.jsonl");
    let rotated = config_dir.join("strategy_telemetry.1.jsonl");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Keep telemetry bounded for long-running daily usage.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(&path, &rotated);
        }
    }
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            if let Ok(line) = serde_json::to_string(record) {
                let _ = writeln!(file, "{}", line);
            }
        }
        Err(e) => {
            warn!("Failed to open telemetry file '{}': {}", path.display(), e);
        }
    }
}

fn summarize_stderr(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return "(no stderr)".to_string();
    }

    let excerpt = if lines.len() <= 8 {
        lines.join(" | ")
    } else {
        let mut selected = lines[..4].to_vec();
        selected.push("...".to_string());
        selected.extend(lines[lines.len() - 3..].iter().cloned());
        selected.join(" | ")
    };

    if excerpt.len() > 700 {
        excerpt[..700].to_string()
    } else {
        excerpt
    }
}

fn try_strategy(ytdlp_path: &PathBuf, strategy: &StrategySpec, url: &str) -> Result<YtDlpMetadata> {
    info!("[yt-dlp] Trying strategy: {}", strategy.label);

    let mut cmd = Command::new(ytdlp_path);
    cmd.arg("--dump-json")
        .arg("--no-playlist")
        .arg("--js-runtimes")
        .arg("node");

    for arg in &strategy.args {
        cmd.arg(arg);
    }
    cmd.arg(url);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = cmd.output()?;
    if out.status.success() {
        let metadata = serde_json::from_slice::<YtDlpMetadata>(&out.stdout)?;
        info!(
            "[yt-dlp] Strategy '{}' succeeded! Title: {}, Formats: {}",
            strategy.label,
            metadata.title,
            metadata.formats.len()
        );
        return Ok(metadata);
    }

    let stderr_excerpt = summarize_stderr(&out.stderr);
    Err(anyhow!(
        "Strategy '{}' failed (exit {}): {}",
        strategy.label,
        out.status,
        stderr_excerpt
    ))
}

pub fn get_metadata(
    ytdlp_path: &PathBuf,
    config_dir: &PathBuf,
    url: &str,
    sniff_headers: Option<HashMap<String, String>>,
) -> Result<YtDlpMetadata> {
    let host = normalized_host(url);
    let profile = resolve_profile(&host);
    let plan = strategy_plan(profile, sniff_headers.as_ref());
    let used_sniff_headers = sniff_headers
        .as_ref()
        .map(|h| !h.is_empty())
        .unwrap_or(false);

    let mut last_error = String::new();
    for strategy in plan {
        match try_strategy(ytdlp_path, &strategy, url) {
            Ok(metadata) => {
                append_telemetry(
                    config_dir,
                    &StrategyTelemetryRecord {
                        ts_unix_ms: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis(),
                        host: host.clone(),
                        url: url.to_string(),
                        profile: profile.name.to_string(),
                        strategy: strategy.label,
                        used_sniff_headers,
                        success: true,
                        error: None,
                        stderr_excerpt: None,
                    },
                );
                return Ok(metadata);
            }
            Err(e) => {
                last_error = e.to_string();
                append_telemetry(
                    config_dir,
                    &StrategyTelemetryRecord {
                        ts_unix_ms: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis(),
                        host: host.clone(),
                        url: url.to_string(),
                        profile: profile.name.to_string(),
                        strategy: strategy.label,
                        used_sniff_headers,
                        success: false,
                        error: Some(last_error.clone()),
                        stderr_excerpt: Some(last_error.clone()),
                    },
                );
            }
        }
    }

    if last_error.contains("Sign in") || last_error.contains("confirm you're not a bot") {
        return Err(anyhow!(
            "Site requires sign-in or bot verification. Use Deep Sniff after manual playback/login."
        ));
    }

    if last_error.contains("HTTP Error 403") {
        return Err(anyhow!(
            "Site returned 403 Forbidden. Try Deep Sniff capture or refresh extractor binaries."
        ));
    }

    let truncated_err = if last_error.len() > 220 {
        &last_error[..220]
    } else {
        &last_error
    };

    Err(anyhow!(
        "Failed to fetch media metadata after trying profile '{}'.\n\nLast error: {}\n\nTry Deep Sniff or a direct captured stream URL. Some sites require browser cookies or a played-in-browser capture.",
        profile.name,
        truncated_err.trim()
    ))
}
