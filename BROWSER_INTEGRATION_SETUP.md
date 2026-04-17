# Chromium Integration Setup (IDM-style)

This adds optional browser-extension handoff so Chromium downloads can be redirected to VelocityDL.

## What is implemented
- Chromium MV3 extension:
  - `chromium-extension/manifest.json`
  - `chromium-extension/background.js`
  - `chromium-extension/options.html`
  - `chromium-extension/options.js`
- Native messaging host executable:
  - Rust binary: `src-tauri/src/bin/vdl_native_host.rs`
- App-side native inbox listener:
  - Emits `external_download_request` events from `native_inbox.jsonl`
- Frontend auto-queue:
  - App queues browser-captured URLs when setting is enabled.

## 1) Build native host executable
From `src-tauri`:

```powershell
cargo build --bin vdl_native_host
```

Output path (debug):
- `src-tauri\target\debug\vdl_native_host.exe`

## 2) Load extension in Chrome/Edge
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable Developer mode
3. Load unpacked: select `chromium-extension`
4. Copy the extension ID shown in the browser

## 3) Register native host manifest
Run script:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-messaging\install-native-host.ps1 `
  -HostExePath "D:\Dev 2026\Tools\VelocityDL\src-tauri\target\debug\vdl_native_host.exe" `
  -ChromeExtensionId "<your_chrome_extension_id>" `
  -EdgeExtensionId "<your_edge_extension_id_optional>"
```

This writes manifests to:
- `%APPDATA%\com.velocitydl.desktop\native-messaging\...`

And registry keys:
- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.velocitydl.native_host` (if Edge id provided)

## 4) Use in app
In VelocityDL Settings:
- `Accept browser extension captures` must be enabled.

In extension Options:
- `Take over browser downloads` enables IDM-like default browser handoff.

## Notes
- This is browser-level defaulting (Chromium + extension), not global OS/network interception.
- If the native host is unavailable, browser downloads continue normally unless cancellation succeeds first.
