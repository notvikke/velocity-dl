use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
struct NativeMessage {
    action: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    scan_auto_open_quality_picker: Option<bool>,
    #[serde(default)]
    capture_type: Option<String>,
    #[serde(default)]
    raw_media_url: Option<String>,
    #[serde(default)]
    headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct NativeResponse {
    ok: bool,
    message: String,
}

fn app_config_dir() -> Result<PathBuf, String> {
    let appdata = env::var("APPDATA").map_err(|e| format!("APPDATA not set: {}", e))?;
    Ok(PathBuf::from(appdata).join("com.velocitydl.desktop"))
}

fn write_json_response(resp: &NativeResponse) -> Result<(), String> {
    let bytes = serde_json::to_vec(resp).map_err(|e| e.to_string())?;
    let len = (bytes.len() as u32).to_le_bytes();
    let mut stdout = io::stdout();
    stdout.write_all(&len).map_err(|e| e.to_string())?;
    stdout.write_all(&bytes).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

fn read_native_message() -> Result<Option<NativeMessage>, String> {
    let mut stdin = io::stdin();
    let mut len_buf = [0u8; 4];
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(format!("Failed to read message length: {}", e)),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > 4 * 1024 * 1024 {
        return Err(format!("Invalid native message length: {}", len));
    }
    let mut data = vec![0u8; len];
    stdin
        .read_exact(&mut data)
        .map_err(|e| format!("Failed to read native message: {}", e))?;
    let parsed = serde_json::from_slice::<NativeMessage>(&data)
        .map_err(|e| format!("Invalid native JSON: {}", e))?;
    Ok(Some(parsed))
}

fn append_to_inbox(msg: &NativeMessage) -> Result<(), String> {
    let config_dir = app_config_dir()?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let inbox = config_dir.join("native_inbox.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&inbox)
        .map_err(|e| format!("Failed to open native inbox '{}': {}", inbox.display(), e))?;
    let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())
}

fn main() -> Result<(), String> {
    loop {
        let message = match read_native_message()? {
            Some(m) => m,
            None => break,
        };

        if message.action == "ping" {
            write_json_response(&NativeResponse {
                ok: true,
                message: "pong".to_string(),
            })?;
            continue;
        }

        if message.action == "capture" {
            if message
                .url
                .as_ref()
                .map(|u| u.starts_with("http://") || u.starts_with("https://"))
                != Some(true)
            {
                write_json_response(&NativeResponse {
                    ok: false,
                    message: "capture requires an http(s) url".to_string(),
                })?;
                continue;
            }
            append_to_inbox(&message)?;
            write_json_response(&NativeResponse {
                ok: true,
                message: "queued".to_string(),
            })?;
            continue;
        }

        write_json_response(&NativeResponse {
            ok: false,
            message: format!("unsupported action '{}'", message.action),
        })?;
    }
    Ok(())
}
