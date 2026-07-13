use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub use crate::window_activation_policy::{should_reveal_for_new_download, NewDownloadRevealState};

const REVEAL_BATCH_DELAY: Duration = Duration::from_millis(140);
#[cfg(windows)]
const WINDOWS_FOCUS_CHECK_DELAY: Duration = Duration::from_millis(80);
#[cfg(windows)]
const WINDOWS_TOPMOST_PULSE: Duration = Duration::from_millis(80);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NewDownloadRevealed {
    download_id: String,
}

pub fn reveal_main_window<R: Runtime>(
    app: &AppHandle<R>,
    download_id: Option<&str>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    if window.is_minimized().unwrap_or(false) {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    if !window.is_visible().unwrap_or(false) {
        window.show().map_err(|error| error.to_string())?;
    }
    window.set_focus().map_err(|error| error.to_string())?;

    if let Some(download_id) = download_id {
        window
            .emit(
                "new_download_revealed",
                NewDownloadRevealed {
                    download_id: download_id.to_string(),
                },
            )
            .map_err(|error| error.to_string())?;
    }

    #[cfg(windows)]
    {
        let fallback_window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WINDOWS_FOCUS_CHECK_DELAY).await;
            if fallback_window.is_focused().unwrap_or(false) {
                return;
            }
            let was_always_on_top = fallback_window.is_always_on_top().unwrap_or(false);
            if !was_always_on_top {
                let _ = fallback_window.set_always_on_top(true);
            }
            let _ = fallback_window.set_focus();
            tokio::time::sleep(WINDOWS_TOPMOST_PULSE).await;
            if !was_always_on_top {
                let _ = fallback_window.set_always_on_top(false);
            }
        });
    }
    Ok(())
}

pub fn reveal_main_window_for_new_download<R: Runtime>(
    app: &AppHandle<R>,
    download_id: &str,
    reveal_on_accept: bool,
    origin: Option<&str>,
) {
    if !should_reveal_for_new_download(reveal_on_accept, origin) {
        return;
    }
    let generation = app
        .state::<NewDownloadRevealState>()
        .enqueue(download_id.to_string());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_BATCH_DELAY).await;
        let download_id = app
            .state::<NewDownloadRevealState>()
            .take_if_current(generation);
        if let Some(download_id) = download_id {
            if let Err(error) = reveal_main_window(&app, Some(&download_id)) {
                log::warn!("Failed to reveal main window for accepted download: {error}");
            }
        }
    });
}
