use crate::engine::segmenter::Segment;
use crate::engine::rate_limiter::GlobalSpeedLimiter;
use anyhow::anyhow;
use anyhow::{Context, Result};
use futures_util::StreamExt;
use log::{error, warn};
use reqwest::StatusCode;
use reqwest::{header, Client};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, timeout, Duration};
use tokio_util::sync::CancellationToken;

pub const APP_USER_AGENT: &str = crate::request_context::DEFAULT_USER_AGENT;
const MAX_SEGMENT_RETRIES: usize = 5;
const SEGMENT_STALL_TIMEOUT: Duration = Duration::from_secs(25);
const RETRY_BASE_DELAY_MS: u64 = 1200;

pub struct Downloader {
    client: Client,
    pub segments: Arc<Mutex<Vec<Segment>>>,
    pub total_size: u64,
    pub output_path: PathBuf,
    pub url: String,
    pub headers: Arc<RwLock<header::HeaderMap>>,
    request_method: reqwest::Method,
    request_body: Option<bytes::Bytes>,
    pub cancel_token: CancellationToken,
    speed_limiter: GlobalSpeedLimiter,
    session_refresh: Option<SessionRefreshContext>,
    session_refresh_attempted: Arc<AtomicBool>,
}

#[derive(Clone)]
struct SessionRefreshContext {
    config_dir: PathBuf,
    network_request_id: String,
}

impl Downloader {
    pub fn new(
        url: String,
        total_size: u64,
        segments: Vec<Segment>,
        output_path: PathBuf,
        headers: header::HeaderMap,
        speed_limiter: GlobalSpeedLimiter,
    ) -> Self {
        Self::new_with_request(
            url,
            total_size,
            segments,
            output_path,
            headers,
            speed_limiter,
            reqwest::Method::GET,
            None,
        )
    }

    pub fn new_with_request(
        url: String,
        total_size: u64,
        segments: Vec<Segment>,
        output_path: PathBuf,
        headers: header::HeaderMap,
        speed_limiter: GlobalSpeedLimiter,
        request_method: reqwest::Method,
        request_body: Option<Vec<u8>>,
    ) -> Self {
        Self {
            client: Client::builder()
                .pool_max_idle_per_host(32)
                .timeout(std::time::Duration::from_secs(30))
                .tcp_keepalive(Some(std::time::Duration::from_secs(60)))
                .build()
                .unwrap(),
            segments: Arc::new(Mutex::new(segments)),
            total_size,
            output_path,
            url,
            headers: Arc::new(RwLock::new(headers)),
            request_method,
            request_body: request_body.map(bytes::Bytes::from),
            cancel_token: CancellationToken::new(),
            speed_limiter,
            session_refresh: None,
            session_refresh_attempted: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_session_refresh(mut self, config_dir: PathBuf, network_request_id: String) -> Self {
        self.session_refresh = Some(SessionRefreshContext { config_dir, network_request_id });
        self
    }

    async fn send_segment_request(&self, segment: &Segment) -> Result<reqwest::Response> {
        let mut request = self.client.request(self.request_method.clone(), &self.url);
        if let Some(body) = &self.request_body { request = request.body(body.clone()); }
        let headers = self.headers.read().await;
        let mut has_ua = false;
        let mut has_referer = false;
        for (key, value) in headers.iter() {
            has_ua |= key == header::USER_AGENT;
            has_referer |= key == header::REFERER;
            request = request.header(key, value);
        }
        drop(headers);
        if !has_ua { request = request.header(header::USER_AGENT, APP_USER_AGENT); }
        if !has_referer && self.url.contains("googlevideo.com") {
            request = request.header(header::REFERER, "https://www.youtube.com/");
        }
        if self.total_size > 0 {
            request = request.header(header::RANGE, format!("bytes={}-{}", segment.current, segment.end));
        }
        request.send().await.context("Failed to send captured browser request")
    }

    pub async fn download_segment(&self, segment_index: usize) -> Result<()> {
        let mut attempt = 0usize;
        loop {
            if self.cancel_token.is_cancelled() {
                return Ok(());
            }

            match self.download_segment_once(segment_index).await {
                Ok(()) => return Ok(()),
                Err(err) => {
                    // Unknown-size single-stream path cannot be retried safely via append-only writes.
                    if self.total_size == 0 {
                        return Err(err);
                    }
                    if attempt >= MAX_SEGMENT_RETRIES {
                        return Err(err.context(format!(
                            "Segment {} exhausted retries ({})",
                            segment_index, MAX_SEGMENT_RETRIES
                        )));
                    }
                    attempt += 1;
                    let backoff_ms =
                        RETRY_BASE_DELAY_MS.saturating_mul(1u64 << (attempt.saturating_sub(1) as u32));
                    warn!(
                        "Segment {} retry {}/{} after error: {}",
                        segment_index, attempt, MAX_SEGMENT_RETRIES, err
                    );
                    sleep(Duration::from_millis(backoff_ms.min(10_000))).await;
                }
            }
        }
    }

    async fn download_segment_once(&self, segment_index: usize) -> Result<()> {
        if self.cancel_token.is_cancelled() {
            return Ok(());
        }

        // Add a small jittered delay for YouTube to avoid immediate throttling
        if self.url.contains("googlevideo.com") {
            let delay = 100 + (segment_index as u64 * 50);
            sleep(Duration::from_millis(delay)).await;
        }

        let mut segment = {
            let segments = self.segments.lock().await;
            segments[segment_index].clone()
        };

        if segment.finished {
            return Ok(());
        }

        let temp_path = if self.total_size > 0 {
            segment_part_path(&self.output_path, segment_index)?
        } else {
            self.output_path.clone()
        };

        if self.total_size > 0 {
            let expected_segment_len = segment.end.saturating_sub(segment.start).saturating_add(1);
            if let Ok(metadata) = tokio::fs::metadata(&temp_path).await {
                let existing_len = metadata.len();
                if existing_len >= expected_segment_len {
                    let mut segments = self.segments.lock().await;
                    segments[segment_index].current = segment.end.saturating_add(1);
                    segments[segment_index].finished = true;
                    return Ok(());
                }
                let resumed_current = segment.start.saturating_add(existing_len);
                if resumed_current > segment.current {
                    segment.current = resumed_current;
                    let mut segments = self.segments.lock().await;
                    segments[segment_index].current = resumed_current;
                }
            }
        }

        if self.total_size > 0 && self.request_method != reqwest::Method::GET {
            return Err(anyhow!("Ranged downloads require GET; captured request used {}", self.request_method));
        }
        let requested_range_start = segment.current;
        let mut response = self.send_segment_request(&segment).await
            .with_context(|| format!("Failed to send request for segment {}", segment_index))?;
        if matches!(response.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            if let Some(refresh) = self.session_refresh.as_ref()
                .filter(|_| !self.session_refresh_attempted.swap(true, Ordering::AcqRel))
            {
                let fresh = crate::browser_session::request_session_refresh(
                    &refresh.config_dir,
                    &self.url,
                    &refresh.network_request_id,
                ).await.map_err(anyhow::Error::msg)?;
                let fresh_headers = crate::request_context::to_headermap(Some(&fresh.headers));
                let mut headers = self.headers.write().await;
                for (name, value) in fresh_headers { if let Some(name) = name { headers.insert(name, value); } }
                drop(headers);
                response = self.send_segment_request(&segment).await?;
            }
        }

        let status = response.status();

        if self.total_size > 0
            && requested_range_start > segment.start
            && status != StatusCode::PARTIAL_CONTENT
        {
            return Err(anyhow!(
                "Server did not honor range resume for segment {} (status {}).",
                segment_index,
                status
            ));
        }

        if !status.is_success() {
            let err_msg = format!(
                "Segment {} failed with status {}. URL: {}",
                segment_index, status, self.url
            );
            error!("{}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }

        let truncate_existing = should_truncate_segment_output(self.total_size, segment_index);
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(!truncate_existing)
            .truncate(truncate_existing)
            .open(&temp_path)
            .await
            .with_context(|| format!("Failed to open temp file: {:?}", temp_path))?;

        let mut writer = BufWriter::new(file);
        let mut stream = response.bytes_stream();
        let mut wrote_any_bytes = false;

        loop {
            if self.cancel_token.is_cancelled() {
                writer.flush().await?;
                return Ok(());
            }

            match timeout(SEGMENT_STALL_TIMEOUT, stream.next()).await {
                Ok(Some(item)) => {
                    let chunk = item.with_context(|| {
                        format!("Error while streaming segment {}", segment_index)
                    })?;
                    self.speed_limiter.acquire(chunk.len()).await;
                    writer.write_all(&chunk).await?;
                    if !chunk.is_empty() {
                        wrote_any_bytes = true;
                    }
                    let mut segments = self.segments.lock().await;
                    segments[segment_index].current += chunk.len() as u64;
                }
                Ok(None) => break,
                Err(_) => {
                    writer.flush().await?;
                    return Err(anyhow!(
                        "Segment {} stalled for {}s with no progress",
                        segment_index,
                        SEGMENT_STALL_TIMEOUT.as_secs()
                    ));
                }
            }
        }

        writer.flush().await?;

        if self.total_size == 0 && !wrote_any_bytes {
            return Err(anyhow!(
                "Segment {} returned an empty response body",
                segment_index
            ));
        }

        let mut segments = self.segments.lock().await;
        segments[segment_index].finished = true;

        Ok(())
    }
}

fn segment_part_path(base_path: &PathBuf, segment_index: usize) -> Result<PathBuf> {
    let file_name = base_path
        .file_name()
        .ok_or_else(|| anyhow!("Invalid output path (missing file name): {:?}", base_path))?
        .to_string_lossy();
    Ok(base_path.with_file_name(format!("{file_name}.vdl-part{segment_index}")))
}

fn should_truncate_segment_output(total_size: u64, segment_index: usize) -> bool {
    total_size == 0 && segment_index == 0
}

#[cfg(test)]
mod tests {
    use super::{should_truncate_segment_output, Downloader};
    use crate::engine::rate_limiter::GlobalSpeedLimiter;
    use crate::engine::segmenter::Segment;
    use reqwest::header::HeaderMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn unknown_size_single_stream_starts_from_clean_file() {
        assert!(should_truncate_segment_output(0, 0));
    }

    #[test]
    fn ranged_segment_downloads_keep_append_resume_behavior() {
        assert!(!should_truncate_segment_output(1024, 0));
        assert!(!should_truncate_segment_output(1024, 1));
    }

    #[tokio::test]
    async fn unknown_size_single_stream_rejects_empty_success_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });

        let temp_path = std::env::temp_dir().join(format!(
            "velocitydl-empty-direct-{}.bin",
            uuid::Uuid::new_v4()
        ));
        let downloader = Downloader::new(
            format!("http://{addr}/empty.bin"),
            0,
            vec![Segment::new(0, 0)],
            temp_path.clone(),
            HeaderMap::new(),
            GlobalSpeedLimiter::new(),
        );

        let result = downloader.download_segment(0).await;
        server.await.unwrap();
        let _ = tokio::fs::remove_file(&temp_path).await;

        assert!(result.is_err());
        let message = format!("{:#}", result.unwrap_err());
        assert!(message.contains("empty response body"), "{message}");
    }

    #[tokio::test]
    async fn unknown_size_single_stream_replays_post_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 2048];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("POST /export HTTP/1.1"), "{request}");
            assert!(request.ends_with("format=csv"), "{request}");
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na,b").await.unwrap();
        });
        let temp_path = std::env::temp_dir().join(format!("velocitydl-post-{}.csv", uuid::Uuid::new_v4()));
        let downloader = Downloader::new_with_request(
            format!("http://{addr}/export"),
            0,
            vec![Segment::new(0, 0)],
            temp_path.clone(),
            HeaderMap::new(),
            GlobalSpeedLimiter::new(),
            reqwest::Method::POST,
            Some(b"format=csv".to_vec()),
        );
        downloader.download_segment(0).await.unwrap();
        server.await.unwrap();
        let body = tokio::fs::read(&temp_path).await.unwrap();
        let _ = tokio::fs::remove_file(&temp_path).await;
        assert_eq!(body, b"a,b");
    }
}
