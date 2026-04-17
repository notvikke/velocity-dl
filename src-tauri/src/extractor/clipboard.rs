use arboard::Clipboard;
use regex::Regex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::time::sleep;

pub async fn start_clipboard_polling<R: Runtime>(app: AppHandle<R>) {
    let media_regex = Regex::new(r"(?i)\.(mp4|mkv|webm|m3u8|mpd|mp3|aac|flac|ts|zip|rar|exe)$|youtube\.com/watch\?v=|youtu\.be/").unwrap();
    let mut last_clipboard = String::new();

    // Initialize clipboard outside the loop if possible, or handle errors inside
    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to initialize clipboard: {}", e);
            return;
        }
    };

    tokio::spawn(async move {
        loop {
            if let Ok(clipboard_text) = clipboard.get_text() {
                let trimmed = clipboard_text.trim().to_string();
                if !trimmed.is_empty() && trimmed != last_clipboard {
                    if media_regex.is_match(&trimmed) {
                        // Emit to frontend
                        if let Err(e) = app.emit("media_detected", &trimmed) {
                            log::error!("Failed to emit media_detected event: {}", e);
                        }
                    }
                    last_clipboard = trimmed;
                }
            }
            sleep(Duration::from_millis(1500)).await;
        }
    });
}
