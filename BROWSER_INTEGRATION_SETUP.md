# Browser Integration Setup

VelocityDL now uses the published Chrome Web Store listing as the primary browser-extension path. Chrome, Helium, Chromium forks, and Edge can all use the same stable extension ID:

- `alnagakehjhbfkdianlkmcncefldpmhm`
- Listing: `https://chromewebstore.google.com/detail/velocitydl-bridge/alnagakehjhbfkdianlkmcncefldpmhm`

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

## Preferred setup
1. Open the Chrome Web Store listing:
   - `https://chromewebstore.google.com/detail/velocitydl-bridge/alnagakehjhbfkdianlkmcncefldpmhm`
2. Install `VelocityDL Bridge` in Chrome, Helium, or another Chromium-based browser.
3. In Edge, the same listing can be used, but Edge may first ask you to allow extensions from other stores.
4. Open VelocityDL and use the Browser Setup Assistant to install or repair the native bridge.
5. Click the extension popup once so it sends a heartbeat to the app.

## Manual script fallback
If you need to register the native host manually, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-messaging\install-native-host.ps1 `
  -HostExePath "D:\Dev 2026\Tools\VelocityDL\src-tauri\target\debug\vdl_native_host.exe"
```

If `-ChromeExtensionId` is omitted, the script defaults to the published web-store ID `alnagakehjhbfkdianlkmcncefldpmhm`. If `-EdgeExtensionId` is also omitted, it defaults to the same stable ID so Edge gets registered too.

This writes manifests to:
- `%APPDATA%\com.velocitydl.desktop\native-messaging\...`

And registry keys:
- `HKCU\Software\Chromium\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\Chromium\NativeMessagingHosts` value `com.velocitydl.native_host`
- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\imput\Helium\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\imput\Helium\NativeMessagingHosts` value `com.velocitydl.native_host`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.velocitydl.native_host` (if Edge id provided)

Chromium forks can consult both their browser-specific root and the generic Chromium root. If a browser still shows `Access to the specified native messaging host is forbidden`, check that the Chromium and browser-specific entries all point at `%APPDATA%\com.velocitydl.desktop\native-messaging\com.velocitydl.native_host.chrome.json` instead of any older `com.velocitydl.app` path.

## Unpacked development fallback
If you intentionally want to test an unpacked local extension copy instead of the web-store build:

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable Developer mode
3. Load unpacked: select `chromium-extension`
4. Copy the runtime extension ID shown by the browser
5. In VelocityDL, use the setup assistant's manual fallback section to apply that ID

## Use in app
In VelocityDL Settings:
- `Accept browser extension captures` must be enabled.

In extension Options:
- `Take over browser downloads` enables IDM-like default browser handoff.

## Notes
- This is browser-level defaulting (Chromium + extension), not global OS/network interception.
- If the native host is unavailable, browser downloads continue normally unless cancellation succeeds first.
- Request-context takeover requires the declared `webRequest`, `cookies`, and `<all_urls>` permissions. These are used locally to reproduce authenticated downloads and to refresh a session after a 401/403; captured secrets are not logged or sent to a remote service.
- DRM-protected media, browser-internal pages, opaque service-worker responses, and request bodies Chromium does not expose cannot be downloaded by the bridge. See `docs/browser-capture-architecture.md` for the full support matrix.
