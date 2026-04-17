use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone)]
pub struct HlsProgress {
    pub total_size: Option<u64>,
    pub out_time_ms: Option<u64>,
    pub speed_factor: Option<String>,
}

pub async fn probe_duration_seconds(
    ffmpeg_path: &PathBuf,
    url: &str,
    headers: Option<&HashMap<String, String>>,
) -> Option<f64> {
    let ffprobe_path = ffmpeg_path.with_file_name(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    let executable = if ffprobe_path.exists() {
        ffprobe_path
    } else if ffmpeg_path.file_name().and_then(|v| v.to_str()) == Some("ffmpeg") {
        PathBuf::from("ffprobe")
    } else {
        return None;
    };

    let mut command = tokio::process::Command::new(executable);
    command
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1");

    if let Some(headers_arg) = build_ffmpeg_headers(headers) {
        command.arg("-headers").arg(headers_arg);
    }

    let output = command.arg(url).output().await.ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
}

pub async fn download_m3u8(
    ffmpeg_path: PathBuf,
    url: &str,
    output: PathBuf,
    headers: Option<&HashMap<String, String>>,
    mut on_progress: impl FnMut(HlsProgress) + Send,
) -> Result<()> {
    let mut command = tokio::process::Command::new(ffmpeg_path);
    command
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg("-y")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(headers_arg) = build_ffmpeg_headers(headers) {
        command.arg("-headers").arg(headers_arg);
    }

    let mut child = command
        .arg("-i")
        .arg(url)
        .arg("-c")
        .arg("copy")
        .arg("-bsf:a")
        .arg("aac_adtstoasc")
        .arg(&output)
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("FFmpeg stdout pipe unavailable for HLS progress"))?;
    let mut reader = BufReader::new(stdout).lines();
    let mut current_total_size = None;
    let mut current_out_time_ms = None;
    let mut current_speed_factor = None;
    let mut last_emit = Instant::now();

    while let Some(line) = reader.next_line().await? {
        if let Some((key, value)) = line.split_once('=') {
            match key {
                "total_size" => {
                    current_total_size = value.parse::<u64>().ok();
                }
                "out_time_ms" => {
                    current_out_time_ms = value.parse::<u64>().ok();
                }
                "speed" => {
                    current_speed_factor = Some(value.trim().to_string());
                }
                "progress" => {
                    if last_emit.elapsed().as_millis() >= 400 || value == "end" {
                        on_progress(HlsProgress {
                            total_size: current_total_size,
                            out_time_ms: current_out_time_ms,
                            speed_factor: current_speed_factor.clone(),
                        });
                        last_emit = Instant::now();
                    }
                }
                _ => {}
            }
        }
    }

    let output = child.wait_with_output().await?;

    if !output.status.success() {
        return Err(anyhow!(
            "FFmpeg HLS download failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

fn build_ffmpeg_headers(headers: Option<&HashMap<String, String>>) -> Option<String> {
    let mut lines = Vec::new();
    let mut has_user_agent = false;
    let mut has_origin = false;
    let mut referer_value: Option<String> = None;

    for (key, value) in headers? {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        if key.eq_ignore_ascii_case("X-VDL-Raw-Media-Url") {
            continue;
        }
        if key.eq_ignore_ascii_case("User-Agent") {
            has_user_agent = true;
        }
        if key.eq_ignore_ascii_case("Origin") {
            has_origin = true;
        }
        if key.eq_ignore_ascii_case("Referer") {
            referer_value = Some(value.to_string());
        }
        lines.push(format!("{key}: {value}"));
    }

    if !has_origin {
        if let Some(referer) = referer_value {
            if let Ok(parsed) = url::Url::parse(&referer) {
                lines.push(format!("Origin: {}", parsed.origin().ascii_serialization()));
            }
        }
    }

    if !has_user_agent {
        lines.push(format!(
            "User-Agent: {}",
            crate::engine::downloader::APP_USER_AGENT
        ));
    }

    if lines.is_empty() {
        None
    } else {
        Some(format!("{}\r\n", lines.join("\r\n")))
    }
}
