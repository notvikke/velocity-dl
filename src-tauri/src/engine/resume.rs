use crate::engine::segmenter::Segment;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

#[derive(Serialize, Deserialize, Debug)]
pub struct DownloadState {
    pub url: String,
    pub total_size: u64,
    pub segments: Vec<Segment>,
    pub headers: HashMap<String, String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub output_path: PathBuf,
}

impl DownloadState {
    pub async fn save(&self, path: &PathBuf) -> Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        fs::write(path, json).await?;
        Ok(())
    }

    pub async fn load(path: &PathBuf) -> Result<Self> {
        let content = fs::read_to_string(path).await?;
        let state = serde_json::from_str(&content)?;
        Ok(state)
    }
}
