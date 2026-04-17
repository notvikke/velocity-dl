use anyhow::{anyhow, Context, Result};
use log::{info, warn};
use reqwest::Client;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::fs;

pub const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
pub const FFMPEG_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub path: PathBuf,
    pub source: &'static str,
}

#[derive(Debug, Clone)]
pub struct ToolStatus {
    pub name: &'static str,
    pub installed: bool,
    pub source: String,
    pub path: Option<String>,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub update_supported: bool,
    pub last_error: Option<String>,
}

pub async fn get_binaries_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let mut path = app
        .path()
        .app_data_dir()
        .context("Failed to get app data dir")?;
    path.push("binaries");
    if !path.exists() {
        fs::create_dir_all(&path).await?;
    }
    Ok(path)
}

fn bundled_binary_path<R: Runtime>(app: &AppHandle<R>, relative_path: &str) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join(relative_path))
        .filter(|path| path.exists())
}

async fn app_data_binary_path<R: Runtime>(app: &AppHandle<R>, file_name: &str) -> Result<PathBuf> {
    Ok(get_binaries_dir(app).await?.join(file_name))
}

pub async fn resolve_ytdlp<R: Runtime>(app: &AppHandle<R>) -> Result<Option<ResolvedBinary>> {
    let app_data = app_data_binary_path(app, "yt-dlp.exe").await?;
    if app_data.exists() {
        return Ok(Some(ResolvedBinary {
            path: app_data,
            source: "app_data",
        }));
    }
    if let Some(path) = bundled_binary_path(app, "third-party/yt-dlp.exe") {
        return Ok(Some(ResolvedBinary {
            path,
            source: "bundled",
        }));
    }
    Ok(None)
}

pub async fn resolve_ffmpeg<R: Runtime>(app: &AppHandle<R>) -> Result<Option<ResolvedBinary>> {
    let app_data = app_data_binary_path(app, "ffmpeg.exe").await?;
    if app_data.exists() {
        return Ok(Some(ResolvedBinary {
            path: app_data,
            source: "app_data",
        }));
    }
    if let Some(path) = bundled_binary_path(app, "third-party/ffmpeg.exe") {
        return Ok(Some(ResolvedBinary {
            path,
            source: "bundled",
        }));
    }
    Ok(None)
}

fn trim_version_line(raw: &str) -> Option<String> {
    let line = raw.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn read_command_stdout(mut command: std::process::Command) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

pub fn get_ytdlp_version(path: &PathBuf) -> Option<String> {
    trim_version_line(&read_command_stdout({
        let mut cmd = std::process::Command::new(path);
        cmd.arg("--version");
        cmd
    })?)
}

pub fn get_ffmpeg_version(path: &PathBuf) -> Option<String> {
    let first_line = trim_version_line(&read_command_stdout({
        let mut cmd = std::process::Command::new(path);
        cmd.arg("-version");
        cmd
    })?)?;
    Some(first_line.replace("ffmpeg version ", ""))
}

async fn latest_github_release_tag(repo: &str) -> Result<String> {
    let client = Client::builder()
        .user_agent("VelocityDL/1.0")
        .timeout(std::time::Duration::from_secs(8))
        .build()?;
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Err(anyhow!("GitHub API returned {}", response.status()));
    }
    let payload: serde_json::Value = response.json().await?;
    payload["tag_name"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("Latest release tag_name missing for {repo}"))
}

fn normalize_ytdlp_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_string()
}

pub async fn get_ytdlp_status<R: Runtime>(app: &AppHandle<R>, include_remote: bool) -> ToolStatus {
    match resolve_ytdlp(app).await {
        Ok(Some(binary)) => {
            let current_version = get_ytdlp_version(&binary.path);
            let latest_version = if include_remote {
                latest_github_release_tag("yt-dlp/yt-dlp")
                    .await
                    .ok()
                    .map(|v| normalize_ytdlp_version(&v))
            } else {
                None
            };
            let update_available = match (&current_version, &latest_version) {
                (Some(current), Some(latest)) => normalize_ytdlp_version(current) != *latest,
                _ => false,
            };
            ToolStatus {
                name: "yt-dlp",
                installed: true,
                source: binary.source.to_string(),
                path: Some(binary.path.to_string_lossy().to_string()),
                current_version,
                latest_version,
                update_available,
                update_supported: true,
                last_error: None,
            }
        }
        Ok(None) => ToolStatus {
            name: "yt-dlp",
            installed: false,
            source: "missing".to_string(),
            path: None,
            current_version: None,
            latest_version: if include_remote {
                latest_github_release_tag("yt-dlp/yt-dlp")
                    .await
                    .ok()
                    .map(|v| normalize_ytdlp_version(&v))
            } else {
                None
            },
            update_available: false,
            update_supported: true,
            last_error: None,
        },
        Err(err) => ToolStatus {
            name: "yt-dlp",
            installed: false,
            source: "error".to_string(),
            path: None,
            current_version: None,
            latest_version: None,
            update_available: false,
            update_supported: true,
            last_error: Some(err.to_string()),
        },
    }
}

pub async fn get_ffmpeg_status<R: Runtime>(app: &AppHandle<R>, include_remote: bool) -> ToolStatus {
    let remote = if include_remote {
        latest_github_release_tag("BtbN/FFmpeg-Builds").await.ok()
    } else {
        None
    };

    match resolve_ffmpeg(app).await {
        Ok(Some(binary)) => ToolStatus {
            name: "ffmpeg",
            installed: true,
            source: binary.source.to_string(),
            path: Some(binary.path.to_string_lossy().to_string()),
            current_version: get_ffmpeg_version(&binary.path),
            latest_version: remote,
            update_available: false,
            update_supported: true,
            last_error: None,
        },
        Ok(None) => {
            if let Ok(output) = std::process::Command::new("ffmpeg").arg("-version").output() {
                if output.status.success() {
                    let first_line = String::from_utf8(output.stdout)
                        .ok()
                        .and_then(|raw| trim_version_line(&raw));
                    return ToolStatus {
                        name: "ffmpeg",
                        installed: true,
                        source: "system".to_string(),
                        path: Some("ffmpeg".to_string()),
                        current_version: first_line.map(|line| line.replace("ffmpeg version ", "")),
                        latest_version: remote,
                        update_available: false,
                        update_supported: true,
                        last_error: None,
                    };
                }
            }

            ToolStatus {
                name: "ffmpeg",
                installed: false,
                source: "missing".to_string(),
                path: None,
                current_version: None,
                latest_version: remote,
                update_available: false,
                update_supported: true,
                last_error: None,
            }
        }
        Err(err) => ToolStatus {
            name: "ffmpeg",
            installed: false,
            source: "error".to_string(),
            path: None,
            current_version: None,
            latest_version: remote,
            update_available: false,
            update_supported: true,
            last_error: Some(err.to_string()),
        },
    }
}

pub async fn ensure_ytdlp<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    if let Some(resolved) = resolve_ytdlp(app).await? {
        return Ok(resolved.path);
    }

    let mut ytdlp_path = get_binaries_dir(app).await?;
    ytdlp_path.push("yt-dlp.exe");

    let should_download = if !ytdlp_path.exists() {
        true
    } else {
        // Check age of the file - update every 24 hours
        let metadata = std::fs::metadata(&ytdlp_path)?;
        let modified = metadata.modified()?;
        let age = std::time::SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default();
        age.as_secs() > 86400 // 24 hours
    };

    if should_download {
        update_ytdlp(app).await?;
    }
    Ok(ytdlp_path)
}

pub async fn update_ytdlp<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let mut ytdlp_path = get_binaries_dir(app).await?;
    ytdlp_path.push("yt-dlp.exe");

    let client = Client::new();
    let response = client.get(YTDLP_URL).send().await?;
    let bytes = response.bytes().await?;
    fs::write(&ytdlp_path, bytes).await?;
    Ok(())
}

pub async fn ensure_ffmpeg<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    if let Some(resolved) = resolve_ffmpeg(app).await? {
        return Ok(resolved.path);
    }

    let binaries_dir = get_binaries_dir(app).await?;
    let ffmpeg_path = binaries_dir.join("ffmpeg.exe");

    if ffmpeg_path.exists() {
        return Ok(ffmpeg_path);
    }

    if let Ok(output) = std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
    {
        if output.status.success() {
            return Ok(PathBuf::from("ffmpeg"));
        }
    }

    info!("[FFmpeg] Binary not found. Starting auto-download sequence...");
    let _ = app.emit(
        "ffmpeg_status",
        "Downloading FFmpeg (~100MB)... One-time setup.",
    );

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    // Step 1: Try GitHub API (BtbN)
    let download_url = match get_btbn_url(&client).await {
        Ok(url) => url,
        Err(e) => {
            warn!(
                "[FFmpeg] GitHub API failed: {}. Falling back to default Gyan.dev link...",
                e
            );
            // Fallback link (Gyan.dev changes this weekly, so this is a "best effort" fallback)
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".to_string()
        }
    };

    info!("[FFmpeg] Resolved download URL: {}", download_url);
    download_ffmpeg(app, &binaries_dir, &download_url).await?;

    if ffmpeg_path.exists() {
        info!("[FFmpeg] Successfully downloaded and verified binary.");
        Ok(ffmpeg_path)
    } else {
        Err(anyhow!(
            "Extraction finished but ffmpeg.exe is still missing from binaries folder."
        ))
    }
}

pub async fn update_ffmpeg<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let binaries_dir = get_binaries_dir(app).await?;
    let ffmpeg_path = binaries_dir.join("ffmpeg.exe");

    let _ = app.emit(
        "ffmpeg_status",
        "Downloading FFmpeg update (~100MB)...",
    );

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let download_url = match get_btbn_url(&client).await {
        Ok(url) => url,
        Err(e) => {
            warn!(
                "[FFmpeg] GitHub API failed during update: {}. Falling back to gyan.dev...",
                e
            );
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".to_string()
        }
    };

    download_ffmpeg(app, &binaries_dir, &download_url).await?;
    Ok(ffmpeg_path)
}

async fn get_btbn_url(client: &Client) -> Result<String> {
    let release_url = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
    let response = client.get(release_url).send().await?;

    if !response.status().is_success() {
        return Err(anyhow!("GitHub API Error: {}", response.status()));
    }

    let release_info: serde_json::Value = response.json().await?;
    let assets = release_info["assets"]
        .as_array()
        .context("No assets found")?;

    for asset in assets {
        if let Some(name) = asset["name"].as_str() {
            if name.ends_with("win64-gpl.zip") && !name.contains("shared") {
                return Ok(asset["browser_download_url"].as_str().unwrap().to_string());
            }
        }
    }
    Err(anyhow!("No matching win64-gpl.zip found in BtbN assets"))
}

async fn download_ffmpeg<R: Runtime>(
    app: &AppHandle<R>,
    binaries_dir: &PathBuf,
    url: &str,
) -> Result<()> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(900)) // 15 minutes for slow connections
        .build()?;

    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Err(anyhow!("Download server returned {}", response.status()));
    }

    let temp_zip = binaries_dir.join("ffmpeg_temp.zip");
    info!("[FFmpeg] Streaming download to {:?}", temp_zip);

    {
        let mut file = std::fs::File::create(&temp_zip)?;
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        while let Some(item) = stream.next().await {
            let chunk = item?;
            std::io::copy(&mut chunk.as_ref(), &mut file)?;
        }
    }

    info!(
        "[FFmpeg] Download complete ({} bytes). Starting extraction...",
        std::fs::metadata(&temp_zip)?.len()
    );
    let _ = app.emit("ffmpeg_status", "Extracting FFmpeg...");

    let binaries_dir_clone = binaries_dir.clone();
    let temp_zip_clone = temp_zip.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let zip_file = std::fs::File::open(&temp_zip_clone)?;
        let mut archive =
            zip::ZipArchive::new(zip_file).map_err(|e| anyhow!("Failed to open zip: {}", e))?;
        let mut found_ffmpeg = false;
        let mut found_ffprobe = false;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let name = file.name().to_string();
            let lower_name = name.to_ascii_lowercase();

            if lower_name.ends_with("ffmpeg.exe") {
                let output_path = binaries_dir_clone.join("ffmpeg.exe");
                let mut outfile = std::fs::File::create(&output_path)?;
                std::io::copy(&mut file, &mut outfile)?;
                info!("[FFmpeg] Successfully extracted ffmpeg.exe");
                found_ffmpeg = true;
            } else if lower_name.ends_with("ffprobe.exe") {
                let output_path = binaries_dir_clone.join("ffprobe.exe");
                let mut outfile = std::fs::File::create(&output_path)?;
                std::io::copy(&mut file, &mut outfile)?;
                info!("[FFmpeg] Successfully extracted ffprobe.exe");
                found_ffprobe = true;
            }
        }

        if !found_ffmpeg {
            return Err(anyhow!("Archive did not contain ffmpeg.exe"));
        }
        if !found_ffprobe {
            warn!("[FFmpeg] Archive did not contain ffprobe.exe");
        }
        Ok(())
    })
    .await??;

    let _ = std::fs::remove_file(&temp_zip);
    info!("[FFmpeg] Cleanup complete. Binary is ready.");
    let _ = app.emit("ffmpeg_status", "FFmpeg ready!");
    Ok(())
}
