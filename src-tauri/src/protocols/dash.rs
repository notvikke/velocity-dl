use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

const FFMPEG_PROGRESS_STALL_TIMEOUT: Duration = Duration::from_secs(45);
const STDERR_TAIL_LINES: usize = 24;

#[derive(Debug, Clone)]
pub struct DashProgress {
    pub total_size: Option<u64>,
    pub out_time_ms: Option<u64>,
    pub speed_factor: Option<String>,
}

#[cfg(windows)]
fn hide_console_window(command: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    command.as_std_mut().creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut tokio::process::Command) {}

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
    hide_console_window(&mut command);
    command
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1");

    if let Some(headers_arg) = crate::request_context::build_ffmpeg_header_blob(headers) {
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

pub async fn download_mpd(
    ffmpeg_path: PathBuf,
    url: &str,
    output: PathBuf,
    headers: Option<&HashMap<String, String>>,
    mut on_progress: impl FnMut(DashProgress) + Send,
) -> Result<()> {
    let mut command = tokio::process::Command::new(ffmpeg_path);
    hide_console_window(&mut command);
    command
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg("-y")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(headers_arg) = crate::request_context::build_ffmpeg_header_blob(headers) {
        command.arg("-headers").arg(headers_arg);
    }

    let mut child = command
        .arg("-i")
        .arg(url)
        .arg("-c")
        .arg("copy")
        .arg(&output)
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("FFmpeg stdout pipe unavailable for DASH progress"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("FFmpeg stderr pipe unavailable for DASH progress"))?;
    let mut reader = BufReader::new(stdout).lines();
    let stderr_tail = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_tail_task = stderr_tail.clone();
    let stderr_task = tokio::spawn(async move {
        let mut stderr_reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut tail = stderr_tail_task.lock().await;
            tail.push(trimmed.to_string());
            if tail.len() > STDERR_TAIL_LINES {
                let drain_count = tail.len() - STDERR_TAIL_LINES;
                tail.drain(0..drain_count);
            }
        }
    });
    let mut current_total_size = None;
    let mut current_out_time_ms = None;
    let mut current_speed_factor = None;
    let mut last_emit = Instant::now();

    loop {
        let next_line = timeout(FFMPEG_PROGRESS_STALL_TIMEOUT, reader.next_line()).await;
        let Some(line) = (match next_line {
            Ok(line) => line?,
            Err(_) => {
                let stderr_snapshot = {
                    let tail = stderr_tail.lock().await;
                    if tail.is_empty() {
                        "(no stderr output captured)".to_string()
                    } else {
                        tail.join(" | ")
                    }
                };
                let _ = child.kill().await;
                let _ = stderr_task.await;
                return Err(anyhow!(
                    "FFmpeg DASH download stalled for {}s. stderr tail: {}",
                    FFMPEG_PROGRESS_STALL_TIMEOUT.as_secs(),
                    stderr_snapshot
                ));
            }
        }) else {
            break;
        };

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
                        on_progress(DashProgress {
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
    let _ = stderr_task.await;

    if !output.status.success() {
        let stderr_snapshot = {
            let tail = stderr_tail.lock().await;
            if tail.is_empty() {
                String::from_utf8_lossy(&output.stderr).to_string()
            } else {
                tail.join(" | ")
            }
        };
        return Err(anyhow!("FFmpeg DASH download failed: {}", stderr_snapshot));
    }

    Ok(())
}
