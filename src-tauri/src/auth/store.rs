use crate::auth::dpapi_win;
use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use anyhow::{Context, Result};
use base64::Engine;
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookieStore {
    pub cookies: HashMap<String, String>,
}

pub struct AuthManager {
    pub store: Arc<Mutex<CookieStore>>,
}

impl AuthManager {
    pub fn new() -> Self {
        Self {
            store: Arc::new(Mutex::new(CookieStore {
                cookies: HashMap::new(),
            })),
        }
    }

    pub async fn add_cookie(&self, name: String, value: String) {
        let mut store = self.store.lock().await;
        store.cookies.insert(name, value);
    }

    pub async fn get_cookies_as_header(&self) -> Option<String> {
        let store = self.store.lock().await;
        if store.cookies.is_empty() {
            return None;
        }
        let header = store
            .cookies
            .iter()
            .map(|(name, value)| format!("{}={}", name, value))
            .collect::<Vec<String>>()
            .join("; ");
        Some(header)
    }

    pub async fn load_webview_cookies<R: tauri::Runtime>(
        &self,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<()> {
        let app_data = app_handle
            .path()
            .app_data_dir()
            .context("Failed to get app data dir")?;
        let ebwebview_dir = app_data.join("EBWebView");

        let local_state_path = ebwebview_dir.join("Local State");
        let cookies_db_path = ebwebview_dir
            .join("Default")
            .join("Network")
            .join("Cookies");

        if !local_state_path.exists() || !cookies_db_path.exists() {
            return Err(anyhow::anyhow!(
                "WebView2 data not found. Please log in via the Deep Sniff browser first."
            ));
        }

        info!("Loading WebView2 cookies from SQLite DB...");

        // All blocking I/O wrapped in spawn_blocking to avoid freezing the Tauri UI
        let extracted_cookies =
            tokio::task::spawn_blocking(move || -> Result<Vec<(String, String)>> {
                // 1. Get the AES Key from Local State
                let local_state_content = std::fs::read_to_string(&local_state_path)?;
                let local_state: serde_json::Value = serde_json::from_str(&local_state_content)?;
                let encrypted_key_b64 = local_state["os_crypt"]["encrypted_key"]
                    .as_str()
                    .context("Failed to find encrypted_key in Local State")?;

                let encrypted_key =
                    base64::engine::general_purpose::STANDARD.decode(encrypted_key_b64)?;

                let master_key = dpapi_win::decrypt_data(&encrypted_key[5..])?;

                // 2. Open the SQLite Cookies DB (copy first to avoid locking issues)
                let temp_db = std::env::temp_dir().join("vdl_webview_cookies.db");
                std::fs::copy(&cookies_db_path, &temp_db)?;

                let cookies = {
                    let conn = rusqlite::Connection::open(&temp_db)?;
                    let mut stmt =
                        conn.prepare("SELECT host_key, name, encrypted_value FROM cookies")?;

                    let mut cookies = Vec::new();
                    let mut success_count = 0u32;
                    let mut fail_count = 0u32;
                    let mut rows = stmt.query([])?;
                    while let Some(row) = rows.next()? {
                        let _host: String = row.get(0)?;
                        let name: String = row.get(1)?;
                        let encrypted: Vec<u8> = row.get(2)?;

                        if !encrypted.is_empty() {
                            if let Ok(decrypted) = decrypt_cookie_value(&encrypted, &master_key) {
                                cookies.push((name, decrypted));
                                success_count += 1;
                            } else {
                                fail_count += 1;
                            }
                        }
                    }
                    info!(
                        "Cookie extraction complete: {} decrypted successfully, {} failed",
                        success_count, fail_count
                    );
                    cookies
                };

                let _ = std::fs::remove_file(&temp_db);
                Ok(cookies)
            })
            .await??;

        info!(
            "Storing {} extracted cookies into AuthManager",
            extracted_cookies.len()
        );
        for (name, value) in extracted_cookies {
            self.add_cookie(name, value).await;
        }

        Ok(())
    }
}

/// Standalone function for use inside spawn_blocking (no &self needed)
fn decrypt_cookie_value(data: &[u8], master_key: &[u8]) -> Result<String> {
    if data.starts_with(b"v10") || data.starts_with(b"v11") {
        // AES-GCM decryption
        let nonce = &data[3..15];
        let ciphertext = &data[15..];

        let key = Key::<Aes256Gcm>::from_slice(master_key);
        let cipher = Aes256Gcm::new(key);
        let nonce_obj = Nonce::from_slice(nonce);

        let decrypted = cipher
            .decrypt(nonce_obj, ciphertext)
            .map_err(|e| anyhow::anyhow!("AES-GCM decryption failed: {}", e))?;

        Ok(String::from_utf8_lossy(&decrypted).to_string())
    } else {
        // Old school DPAPI
        let decrypted = dpapi_win::decrypt_data(data)?;
        Ok(String::from_utf8_lossy(&decrypted).to_string())
    }
}
