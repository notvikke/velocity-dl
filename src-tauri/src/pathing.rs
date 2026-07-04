use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

pub fn config_dir_for_app<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

pub fn app_data_dir_for_app<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}
