use crate::engine::downloader::Downloader;
use crate::engine::rate_limiter::GlobalSpeedLimiter;
use crate::engine::merger::{merge_segments, preallocate_file};
use crate::engine::segmenter::{calculate_segments, Segment};
use crate::engine::settings::AppSettings;
use crate::engine::sound::{play_error_sound, play_finish_sound};
use crate::engine::speed::SpeedCalculator;
use crate::ipc::commands::DownloadItem;
use crate::protocols::dash::{download_mpd, probe_duration_seconds as probe_dash_duration_seconds, DashProgress};
use crate::protocols::hls::{download_m3u8, probe_duration_seconds, HlsProgress};
use log::info;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: String,
    progress: f32,
    speed: String,
    stream_speed_factor: Option<String>,
    indeterminate_progress: Option<bool>,
    eta: String,
    status: String,
    error: Option<String>,
    segments: Vec<SegmentState>,
}

#[derive(Clone, Serialize)]
struct SegmentState {
    id: usize,
    state: String, // "idle", "downloading", "finished"
}

fn segment_state_for_segment(segment: &Segment) -> String {
    if segment.finished {
        "finished".to_string()
    } else if segment.current > segment.start {
        "downloading".to_string()
    } else {
        "idle".to_string()
    }
}

async fn snapshot_segments(segments: &Arc<Mutex<Vec<Segment>>>) -> (u64, bool, Vec<SegmentState>) {
    let segments = segments.lock().await;
    let mut downloaded_bytes = 0u64;
    let mut all_finished = true;
    let mut states = Vec::with_capacity(segments.len());

    for (i, segment) in segments.iter().enumerate() {
        downloaded_bytes += segment.current.saturating_sub(segment.start);
        all_finished &= segment.finished;
        states.push(SegmentState {
            id: i,
            state: segment_state_for_segment(segment),
        });
    }

    (downloaded_bytes, all_finished, states)
}

fn format_hls_speed(speed: f64) -> String {
    if speed <= 0.0 {
        "0 B/s".to_string()
    } else {
        format_speed(speed)
    }
}

fn parse_ffmpeg_speed_factor(value: Option<&str>) -> Option<f64> {
    let raw = value?.trim();
    let numeric = raw.strip_suffix('x').unwrap_or(raw).trim();
    let parsed = numeric.parse::<f64>().ok()?;
    if parsed.is_finite() && parsed > 0.0 {
        Some(parsed)
    } else {
        None
    }
}

fn estimate_stream_eta(
    total_duration_secs: Option<f64>,
    out_time_ms: Option<u64>,
    speed_factor: Option<&str>,
    fallback: &str,
) -> String {
    match (total_duration_secs, out_time_ms) {
        (Some(total), Some(out_time_ms)) if total > 0.0 => {
            let consumed = out_time_ms as f64 / 1_000_000.0;
            let remaining_media_secs = (total - consumed).max(0.0);
            let wall_clock_secs = match parse_ffmpeg_speed_factor(speed_factor) {
                Some(speed) if speed > 0.0 => remaining_media_secs / speed,
                _ => remaining_media_secs,
            };
            format_duration(std::time::Duration::from_secs_f64(wall_clock_secs))
        }
        _ => fallback.to_string(),
    }
}

pub struct DownloadManager {
    active_downloads: Arc<Mutex<HashMap<String, CancellationToken>>>,
    speed_limiter: GlobalSpeedLimiter,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            active_downloads: Arc::new(Mutex::new(HashMap::new())),
            speed_limiter: GlobalSpeedLimiter::new(),
        }
    }

    pub async fn start_download<R: Runtime>(&self, app: AppHandle<R>, item: DownloadItem) {
        let id = item.id.clone();
        let cancel_token = CancellationToken::new();
        let mut active_downloads = self.active_downloads.lock().await;
        active_downloads.insert(id.clone(), cancel_token.clone());
        drop(active_downloads);

        let manager_clone = self.active_downloads.clone();
        let speed_limiter = self.speed_limiter.clone();

        tokio::spawn(async move {
            if let Err(e) = Self::download_task(app.clone(), item, cancel_token, speed_limiter).await {
                let _ = app.emit(
                    "download_progress",
                    DownloadProgress {
                        id: id.clone(),
                        progress: 0.0,
                        speed: "0 B/s".to_string(),
                        stream_speed_factor: None,
                        indeterminate_progress: None,
                        eta: "Error".to_string(),
                        status: "error".to_string(),
                        error: Some(e.to_string()),
                        segments: vec![],
                    },
                );

                let config_dir = app.path().app_config_dir().unwrap_or_default();
                let settings = AppSettings::load(config_dir).await;
                if settings.play_sound_on_fail {
                    play_error_sound();
                }
            }

            let mut active_downloads = manager_clone.lock().await;
            active_downloads.remove(&id);
        });
    }

    async fn download_task<R: Runtime>(
        app: AppHandle<R>,
        item: DownloadItem,
        cancel_token: CancellationToken,
        speed_limiter: GlobalSpeedLimiter,
    ) -> anyhow::Result<()> {
        let config_dir = app.path().app_config_dir().unwrap_or_default();
        let settings = AppSettings::load(config_dir).await;
        speed_limiter.set_limit_mb(settings.speed_limit_mb).await;

        let final_output_path = PathBuf::from(&item.output_path).join(&item.title);

        // Ensure directory exists
        if let Some(parent) = final_output_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let strategy = item.download_strategy.as_deref().unwrap_or("");
        let is_hls_manifest = strategy == "hls_manifest";
        let is_dash_manifest = strategy == "dash_manifest";

        if is_hls_manifest || is_dash_manifest {
            let manifest_label = if is_dash_manifest { "DASH" } else { "HLS" };
            let _ = app.emit(
                "download_progress",
                DownloadProgress {
                    id: item.id.clone(),
                    progress: 0.0,
                    speed: "Preparing".to_string(),
                    stream_speed_factor: None,
                    indeterminate_progress: Some(false),
                    eta: format!("Fetching {manifest_label} stream"),
                    status: "processing".to_string(),
                    error: None,
                    segments: vec![],
                },
            );

            let ffmpeg_path = crate::extractor::binaries::ensure_ffmpeg(&app).await?;
            let progress_app = app.clone();
            let progress_id = item.id.clone();
            let mut last_size = 0u64;
            let mut last_tick = Instant::now();
            if is_hls_manifest {
                let duration_secs =
                    probe_duration_seconds(&ffmpeg_path, &item.url, item.headers.as_ref()).await;
                tokio::select! {
                    res = download_m3u8(
                        ffmpeg_path,
                        &item.url,
                        final_output_path.clone(),
                        item.headers.as_ref(),
                        move |progress: HlsProgress| {
                            let now = Instant::now();
                            let bytes = progress.total_size.unwrap_or(last_size);
                            let elapsed = now.duration_since(last_tick).as_secs_f64();
                            let bytes_per_sec = if elapsed > 0.0 && bytes >= last_size {
                                (bytes - last_size) as f64 / elapsed
                            } else {
                                0.0
                            };
                            last_size = bytes;
                            last_tick = now;

                            let progress_percent = match (duration_secs, progress.out_time_ms) {
                                (Some(total), Some(out_time_ms)) if total > 0.0 => {
                                    ((out_time_ms as f64 / 1_000_000.0) / total * 100.0)
                                        .clamp(0.0, 99.0) as f32
                                }
                                _ => 0.0,
                            };
                            let eta = estimate_stream_eta(
                                duration_secs,
                                progress.out_time_ms,
                                progress.speed_factor.as_deref(),
                                progress
                                    .speed_factor
                                    .as_deref()
                                    .unwrap_or("Downloading HLS stream"),
                            );

                            let _ = progress_app.emit(
                                "download_progress",
                                DownloadProgress {
                                    id: progress_id.clone(),
                                    progress: progress_percent,
                                    speed: format_hls_speed(bytes_per_sec),
                                    stream_speed_factor: progress.speed_factor.clone(),
                                    indeterminate_progress: Some(false),
                                    eta,
                                    status: "active".to_string(),
                                    error: None,
                                    segments: vec![],
                                },
                            );
                        },
                    ) => res?,
                    _ = cancel_token.cancelled() => {
                        return Ok(());
                    }
                }
            } else {
                let duration_secs =
                    probe_dash_duration_seconds(&ffmpeg_path, &item.url, item.headers.as_ref()).await;
                tokio::select! {
                    res = download_mpd(
                        ffmpeg_path,
                        &item.url,
                        final_output_path.clone(),
                        item.headers.as_ref(),
                        move |progress: DashProgress| {
                            let now = Instant::now();
                            let bytes = progress.total_size.unwrap_or(last_size);
                            let elapsed = now.duration_since(last_tick).as_secs_f64();
                            let bytes_per_sec = if elapsed > 0.0 && bytes >= last_size {
                                (bytes - last_size) as f64 / elapsed
                            } else {
                                0.0
                            };
                            last_size = bytes;
                            last_tick = now;

                            let progress_percent = match (duration_secs, progress.out_time_ms) {
                                (Some(total), Some(out_time_ms)) if total > 0.0 => {
                                    ((out_time_ms as f64 / 1_000_000.0) / total * 100.0)
                                        .clamp(0.0, 99.0) as f32
                                }
                                _ => 0.0,
                            };
                            let eta = estimate_stream_eta(
                                duration_secs,
                                progress.out_time_ms,
                                progress.speed_factor.as_deref(),
                                progress
                                    .speed_factor
                                    .as_deref()
                                    .unwrap_or("Downloading DASH stream"),
                            );

                            let _ = progress_app.emit(
                                "download_progress",
                                DownloadProgress {
                                    id: progress_id.clone(),
                                    progress: progress_percent,
                                    speed: format_hls_speed(bytes_per_sec),
                                    stream_speed_factor: progress.speed_factor.clone(),
                                    indeterminate_progress: Some(false),
                                    eta,
                                    status: "active".to_string(),
                                    error: None,
                                    segments: vec![],
                                },
                            );
                        },
                    ) => res?,
                    _ = cancel_token.cancelled() => {
                        return Ok(());
                    }
                }
            }

            let _ = app.emit(
                "download_progress",
                DownloadProgress {
                    id: item.id.clone(),
                    progress: 100.0,
                    speed: "0 B/s".to_string(),
                    stream_speed_factor: None,
                    indeterminate_progress: Some(false),
                    eta: "Finished".to_string(),
                    status: "finished".to_string(),
                    error: None,
                    segments: vec![],
                },
            );

            if settings.play_sound_on_finish {
                play_finish_sound();
            }

            return Ok(());
        }

        let is_multi_track = item.audio_url.is_some();
        let num_threads = settings.max_threads.max(1);

        let mut video_threads = num_threads;
        if item.url.contains("googlevideo.com") {
            video_threads = video_threads.min(8);
        }

        info!(
            "[Download {}] Mode: {} | Video threads: {} | URL: {}",
            item.id,
            if is_multi_track {
                "MULTI-TRACK (Video + Audio)"
            } else {
                "SINGLE"
            },
            video_threads,
            &item.url[..item.url.len().min(80)]
        );

        let mut video_headers = HeaderMap::new();
        if let Some(h) = item.headers {
            for (k, v) in h {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(k.as_bytes()),
                    HeaderValue::from_str(&v),
                ) {
                    video_headers.insert(name, value);
                }
            }
        }

        // Add cookies from AuthManager if available
        if let Some(auth_manager) = app.try_state::<crate::auth::store::AuthManager>() {
            if let Some(cookies) = auth_manager.get_cookies_as_header().await {
                if let Ok(value) = HeaderValue::from_str(&cookies) {
                    video_headers.insert(reqwest::header::COOKIE, value);
                }
            }
        }

        if !is_multi_track {
            // SINGLE TRACK DOWNLOAD (Existing Logic)
            if item.total_size == 0 {
                let downloader = Arc::new(Downloader::new(
                    item.url.clone(),
                    0,
                    vec![Segment::new(0, 0)],
                    final_output_path.clone(),
                    video_headers,
                    speed_limiter.clone(),
                ));

                let mut speed_calc = SpeedCalculator::new();
                let progress_downloader = downloader.clone();
                let progress_app = app.clone();
                let progress_id = item.id.clone();
                let progress_task = tokio::spawn(async move {
                    let mut last_progress_emit = std::time::Instant::now();
                    let mut visual_progress = 12.0f32;
                    loop {
                        let (current_bytes, finished, segment_states) =
                            snapshot_segments(&progress_downloader.segments).await;

                        if finished {
                            break;
                        }

                        if last_progress_emit.elapsed() >= std::time::Duration::from_millis(500) {
                            let (speed, _) = speed_calc.calculate(current_bytes);
                            visual_progress += 6.0;
                            if visual_progress > 88.0 {
                                visual_progress = 18.0;
                            }

                            let _ = progress_app.emit(
                                "download_progress",
                                DownloadProgress {
                                    id: progress_id.clone(),
                                    progress: visual_progress,
                                    speed: format_speed(speed),
                                    stream_speed_factor: None,
                                    indeterminate_progress: Some(true),
                                    eta: "Unknown size".to_string(),
                                    status: "active".to_string(),
                                    error: None,
                                    segments: segment_states,
                                },
                            );
                            last_progress_emit = std::time::Instant::now();
                        }

                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    }
                });

                tokio::select! {
                    res = downloader.download_segment(0) => {
                        progress_task.abort();
                        res?
                    },
                    _ = cancel_token.cancelled() => {
                        progress_task.abort();
                        downloader.cancel_token.cancel();
                        return Ok(());
                    }
                }
            } else {
                preallocate_file(&final_output_path, item.total_size).await?;
                let segments = calculate_segments(item.total_size, video_threads);
                let downloader = Arc::new(Downloader::new(
                    item.url.clone(),
                    item.total_size,
                    segments.clone(),
                    final_output_path.clone(),
                    video_headers,
                    speed_limiter.clone(),
                ));

                let mut segment_tasks = Vec::new();
                for i in 0..video_threads {
                    let d = downloader.clone();
                    let ct = cancel_token.clone();
                    segment_tasks.push(tokio::spawn(async move {
                        tokio::select! {
                            res = d.download_segment(i as usize) => res,
                            _ = ct.cancelled() => Ok(()),
                        }
                    }));
                }

                let mut speed_calc = SpeedCalculator::new();
                let mut last_progress_emit = std::time::Instant::now();

                while !cancel_token.is_cancelled() {
                    let (current_bytes, finished, segment_states) =
                        snapshot_segments(&downloader.segments).await;

                    if finished {
                        break;
                    }

                    if last_progress_emit.elapsed() >= std::time::Duration::from_millis(500) {
                        let (speed, _) = speed_calc.calculate(current_bytes);
                        let eta = speed_calc.calculate_eta(speed, item.total_size, current_bytes);
                        let progress = (current_bytes as f32 / item.total_size as f32) * 100.0;

                        let _ = app.emit(
                            "download_progress",
                            DownloadProgress {
                                id: item.id.clone(),
                                progress,
                                speed: format_speed(speed),
                                stream_speed_factor: None,
                                indeterminate_progress: Some(false),
                                eta: format_duration(eta),
                                status: "active".to_string(),
                                error: None,
                                segments: segment_states,
                            },
                        );
                        last_progress_emit = std::time::Instant::now();
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }

                if cancel_token.is_cancelled() {
                    downloader.cancel_token.cancel();
                    return Ok(());
                }

                for task in segment_tasks {
                    task.await??;
                }
                merge_segments(final_output_path.clone(), video_threads).await?;
            }
        } else {
            // MULTI-TRACK DOWNLOAD (Video + Audio)
            info!("[Download {}] Starting Multi-Track download", item.id);
            let video_path = final_output_path.with_extension("vdl-temp-video");
            let audio_path = final_output_path.with_extension("vdl-temp-audio");

            let audio_url = item.audio_url.unwrap();
            let total_audio_size = item.audio_size.unwrap_or(0);
            let total_video_size = item.total_size;
            let total_combined_size = total_video_size + total_audio_size;

            let mut audio_headers = HeaderMap::new();
            if let Some(h) = item.audio_headers {
                for (k, v) in h {
                    if let (Ok(name), Ok(value)) = (
                        HeaderName::from_bytes(k.as_bytes()),
                        HeaderValue::from_str(&v),
                    ) {
                        audio_headers.insert(name, value);
                    }
                }
            } else {
                audio_headers = video_headers.clone();
            }

            // Ensure audio_headers also has cookies if not already copied from video_headers
            if let Some(auth_manager) = app.try_state::<crate::auth::store::AuthManager>() {
                if let Some(cookies) = auth_manager.get_cookies_as_header().await {
                    if let Ok(value) = HeaderValue::from_str(&cookies) {
                        audio_headers.insert(reqwest::header::COOKIE, value);
                    }
                }
            }

            if total_video_size > 0 {
                preallocate_file(&video_path, total_video_size).await?;
            }
            if total_audio_size > 0 {
                preallocate_file(&audio_path, total_audio_size).await?;
            }

            let video_segments = if total_video_size > 0 {
                calculate_segments(total_video_size, video_threads)
            } else {
                vec![Segment::new(0, 0)]
            };
            let video_downloader = Arc::new(Downloader::new(
                item.url.clone(),
                total_video_size,
                video_segments,
                video_path.clone(),
                video_headers,
                speed_limiter.clone(),
            ));

            let configured_audio_threads = 4.min(num_threads);
            let audio_segments = if total_audio_size > 0 {
                calculate_segments(total_audio_size, configured_audio_threads)
            } else {
                vec![Segment::new(0, 0)]
            };
            let audio_downloader = Arc::new(Downloader::new(
                audio_url,
                total_audio_size,
                audio_segments,
                audio_path.clone(),
                audio_headers,
                speed_limiter,
            ));

            let mut tasks = Vec::new();
            let video_task_count = if total_video_size > 0 {
                video_threads
            } else {
                1
            };
            for i in 0..video_task_count {
                let d = video_downloader.clone();
                let ct = cancel_token.clone();
                tasks.push(tokio::spawn(async move {
                    tokio::select! {
                        res = d.download_segment(i as usize) => res,
                        _ = ct.cancelled() => Ok(()),
                    }
                }));
            }
            let audio_task_count = if total_audio_size > 0 {
                configured_audio_threads
            } else {
                1
            };
            for i in 0..audio_task_count {
                let d = audio_downloader.clone();
                let ct = cancel_token.clone();
                tasks.push(tokio::spawn(async move {
                    tokio::select! {
                        res = d.download_segment(i as usize) => res,
                        _ = ct.cancelled() => Ok(()),
                    }
                }));
            }

            let mut speed_calc = SpeedCalculator::new();
            let mut last_progress_emit = std::time::Instant::now();

            while !cancel_token.is_cancelled() {
                let (v_bytes, video_finished, video_states) =
                    snapshot_segments(&video_downloader.segments).await;
                let (a_bytes, audio_finished, mut audio_states) =
                    snapshot_segments(&audio_downloader.segments).await;
                let current_bytes = v_bytes + a_bytes;
                let finished = video_finished && audio_finished;

                if finished {
                    break;
                }

                if last_progress_emit.elapsed() >= std::time::Duration::from_millis(500) {
                    let (speed, _) = speed_calc.calculate(current_bytes);
                    let progress = if total_combined_size > 0 {
                        (current_bytes as f32 / total_combined_size as f32) * 100.0
                    } else {
                        0.0
                    };
                    let eta = if total_combined_size > 0 {
                        format_duration(speed_calc.calculate_eta(
                            speed,
                            total_combined_size,
                            current_bytes,
                        ))
                    } else {
                        "Unknown".to_string()
                    };
                    let mut segment_states = video_states;
                    let offset = segment_states.len();
                    for state in &mut audio_states {
                        state.id += offset;
                    }
                    segment_states.extend(audio_states);
                    
                    let _ = app.emit(
                        "download_progress",
                        DownloadProgress {
                            id: item.id.clone(),
                            progress,
                            speed: format_speed(speed),
                            stream_speed_factor: None,
                            indeterminate_progress: Some(false),
                            eta,
                            status: "active".to_string(),
                            error: None,
                            segments: segment_states,
                        },
                    );
                    last_progress_emit = std::time::Instant::now();
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }

            if cancel_token.is_cancelled() {
                video_downloader.cancel_token.cancel();
                audio_downloader.cancel_token.cancel();
                return Ok(());
            }

            for task in tasks {
                task.await??;
            }

            let mut finished_segments = {
                let vs = video_downloader.segments.lock().await;
                let as_ = audio_downloader.segments.lock().await;
                let mut merged = Vec::with_capacity(vs.len() + as_.len());
                for (i, _) in vs.iter().enumerate() {
                    merged.push(SegmentState {
                        id: i,
                        state: "finished".to_string(),
                    });
                }
                let offset = merged.len();
                for (i, _) in as_.iter().enumerate() {
                    merged.push(SegmentState {
                        id: offset + i,
                        state: "finished".to_string(),
                    });
                }
                merged
            };

            let _ = app.emit(
                "download_progress",
                DownloadProgress {
                    id: item.id.clone(),
                    progress: 99.0,
                    speed: "Processing".to_string(),
                    stream_speed_factor: None,
                    indeterminate_progress: Some(false),
                    eta: "Merging downloaded parts".to_string(),
                    status: "processing".to_string(),
                    error: None,
                    segments: finished_segments.clone(),
                },
            );

            // Merge segments of each track first
            if total_video_size > 0 {
                info!(
                    "[Download {}] All video segments complete. Merging video segments...",
                    item.id
                );
                crate::engine::merger::merge_segments_to_file(
                    &video_path,
                    &video_path,
                    video_task_count,
                )
                .await?;
            }
            if total_audio_size > 0 {
                info!(
                    "[Download {}] All audio segments complete. Merging audio segments...",
                    item.id
                );
                crate::engine::merger::merge_segments_to_file(
                    &audio_path,
                    &audio_path,
                    audio_task_count,
                )
                .await?;
            }

            let _ = app.emit(
                "download_progress",
                DownloadProgress {
                    id: item.id.clone(),
                    progress: 99.0,
                    speed: "Processing".to_string(),
                    stream_speed_factor: None,
                    indeterminate_progress: Some(false),
                    eta: "Muxing video and audio".to_string(),
                    status: "processing".to_string(),
                    error: None,
                    segments: std::mem::take(&mut finished_segments),
                },
            );

            // Final Merge with FFmpeg
            info!(
                "[Download {}] Starting FFmpeg mux (video + audio -> final output)",
                item.id
            );
            let ffmpeg_path = crate::extractor::binaries::ensure_ffmpeg(&app).await?;
            crate::engine::merger::merge_multi_track(
                ffmpeg_path,
                video_path,
                audio_path,
                final_output_path.clone(),
            )
            .await?;
            info!(
                "[Download {}] FFmpeg merge complete: {:?}",
                item.id, final_output_path
            );
        }

        // Final emit
        let _ = app.emit(
            "download_progress",
            DownloadProgress {
                id: item.id.clone(),
                progress: 100.0,
                speed: "0 B/s".to_string(),
                stream_speed_factor: None,
                indeterminate_progress: Some(false),
                eta: "Finished".to_string(),
                status: "finished".to_string(),
                error: None,
                segments: vec![],
            },
        );

        if settings.play_sound_on_finish {
            play_finish_sound();
        }

        Ok(())
    }

    pub async fn pause_download(&self, id: &str) {
        let mut active_downloads = self.active_downloads.lock().await;
        if let Some(token) = active_downloads.remove(id) {
            token.cancel();
        }
    }
}

fn format_speed(speed: f64) -> String {
    if speed < 1024.0 {
        format!("{:.1} B/s", speed)
    } else if speed < 1024.0 * 1024.0 {
        format!("{:.1} KB/s", speed / 1024.0)
    } else {
        format!("{:.1} MB/s", speed / (1024.0 * 1024.0))
    }
}

fn format_duration(duration: std::time::Duration) -> String {
    let secs = duration.as_secs();
    if secs == 0 {
        return "Unknown".to_string();
    }
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    }
}
