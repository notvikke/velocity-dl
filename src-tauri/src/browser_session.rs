// Browser-session refresh mailbox. The native host and downloader share these
// JSON files because Chrome MV3 cannot accept inbound native connections.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRefreshRequest {
    pub refresh_id: String,
    pub url: String,
    pub network_request_id: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRefreshResponse {
    pub refresh_id: String,
    pub headers: HashMap<String, String>,
    pub captured_at_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn request_dir(root: &Path) -> PathBuf { root.join("browser_session_refresh_requests") }
fn response_dir(root: &Path) -> PathBuf { root.join("browser_session_refresh_responses") }

fn atomic_json_write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "mailbox path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, serde_json::to_vec(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

pub fn take_pending_refresh_requests(root: &Path) -> Result<Vec<SessionRefreshRequest>, String> {
    let dir = request_dir(root);
    if !dir.exists() { return Ok(Vec::new()); }
    let mut requests = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
        let raw = fs::read(&path).map_err(|e| e.to_string())?;
        let request: SessionRefreshRequest = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&path);
        if now_ms().saturating_sub(request.created_at_ms) <= 2 * 60_000 { requests.push(request); }
    }
    requests.sort_by_key(|request| request.created_at_ms);
    Ok(requests)
}

pub fn write_refresh_response(root: &Path, response: &SessionRefreshResponse) -> Result<(), String> {
    atomic_json_write(&response_dir(root).join(format!("{}.json", response.refresh_id)), response)
}

pub async fn request_session_refresh(
    root: &Path,
    url: &str,
    network_request_id: &str,
) -> Result<SessionRefreshResponse, String> {
    request_session_refresh_with_timeout(root, url, network_request_id, Duration::from_secs(70)).await
}

pub async fn request_session_refresh_with_timeout(
    root: &Path,
    url: &str,
    network_request_id: &str,
    timeout: Duration,
) -> Result<SessionRefreshResponse, String> {
    let refresh_id = uuid::Uuid::new_v4().to_string();
    let request = SessionRefreshRequest {
        refresh_id: refresh_id.clone(),
        url: url.to_string(),
        network_request_id: network_request_id.to_string(),
        created_at_ms: now_ms(),
    };
    atomic_json_write(&request_dir(root).join(format!("{refresh_id}.json")), &request)?;
    let response_path = response_dir(root).join(format!("{refresh_id}.json"));
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if let Ok(raw) = tokio::fs::read(&response_path).await {
            let response = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            let _ = tokio::fs::remove_file(&response_path).await;
            return Ok(response);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Timed out waiting for the browser extension to refresh session context".to_string())
}

#[cfg(test)]
mod tests {
    use super::{request_session_refresh_with_timeout, take_pending_refresh_requests, write_refresh_response, SessionRefreshResponse};
    use std::collections::HashMap;
    use std::time::Duration;

    #[tokio::test]
    async fn downloader_round_trips_a_refresh_request_through_the_mailbox() {
        let root = std::env::temp_dir().join(format!("vdl-refresh-test-{}", uuid::Uuid::new_v4()));
        let waiter_root = root.clone();
        let waiter = tokio::spawn(async move {
            request_session_refresh_with_timeout(
                &waiter_root,
                "https://cdn.test/file",
                "network-1",
                Duration::from_secs(2),
            ).await.unwrap()
        });
        let requests = loop {
            let requests = take_pending_refresh_requests(&root).unwrap();
            if !requests.is_empty() { break requests; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(requests[0].network_request_id, "network-1");
        write_refresh_response(&root, &SessionRefreshResponse {
            refresh_id: requests[0].refresh_id.clone(),
            headers: HashMap::from([("Cookie".to_string(), "sid=fresh".to_string())]),
            captured_at_ms: 1,
        }).unwrap();
        let response = waiter.await.unwrap();
        assert_eq!(response.headers.get("Cookie").map(String::as_str), Some("sid=fresh"));
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
