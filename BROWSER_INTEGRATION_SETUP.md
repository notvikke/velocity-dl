# Browser Integration Setup

VelocityDL uses one published Chrome Web Store extension for every supported Chromium browser. Chrome, Edge, Brave, Vivaldi, Opera, Opera GX, Helium, and Chromium forks all use the same extension files and stable ID:

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

## Browser-specific setup

| Browser | Extension installation | Native bridge registration | Extensions page |
| --- | --- | --- | --- |
| Chrome | Install from the Chrome Web Store | Chrome registration | `chrome://extensions` |
| Edge | Enable “Allow extensions from other stores,” then use the Chrome Web Store | Edge registration plus Chromium/Chrome fallback | `edge://extensions` |
| Brave | Install from the Chrome Web Store | Dedicated Brave registration | `brave://extensions` |
| Vivaldi | Install from the Chrome Web Store | Shared Chrome-compatible registration | `vivaldi://extensions` |
| Opera / Opera GX | Install from the Chrome Web Store | Shared Chrome-compatible registration | `opera://extensions` |
| Helium | Install from the Chrome Web Store | Dedicated Helium registration plus generic Chromium fallback | `chrome://extensions` |
| Other Chromium forks | Install from the Chrome Web Store when supported | Generic Chromium and Chrome-compatible registration | Usually `chrome://extensions` |

There is no browser-specific extension build. Browser differences are handled only by executable detection, the extensions-page URL, and native-messaging registration.

## Manual script fallback
If you need to register the native host manually, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-messaging\install-native-host.ps1 `
  -HostExePath "D:\Dev 2026\Tools\VelocityDL\src-tauri\target\debug\vdl_native_host.exe"
```

The published Web Store ID `alnagakehjhbfkdianlkmcncefldpmhm` is always registered first. `-ChromeExtensionId` and `-EdgeExtensionId` are optional advanced values for an unpacked extension; when supplied, the validated local ID is added without replacing production access.

This writes manifests to:
- `%APPDATA%\com.velocitydl.desktop\native-messaging\...`

And registry keys:
- `HKCU\Software\Chromium\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\Chromium\NativeMessagingHosts` value `com.velocitydl.native_host`
- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\imput\Helium\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\imput\Helium\NativeMessagingHosts` value `com.velocitydl.native_host`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.velocitydl.native_host`
- `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.velocitydl.native_host`
- Chrome-compatible fallback registration used by Vivaldi, Opera, and Opera GX

Chromium forks can consult both their browser-specific root and the generic Chromium root. If a browser still shows `Access to the specified native messaging host is forbidden`, check that the Chromium and browser-specific entries all point at `%APPDATA%\com.velocitydl.desktop\native-messaging\com.velocitydl.native_host.chrome.json` instead of any older `com.velocitydl.app` path.

## App-managed unpacked fallback

Installed builds stage one extension copy at:

- `%LOCALAPPDATA%\VelocityDL\chromium-extension`

Use this folder while the Web Store listing is unavailable or when diagnosing a browser-specific installation. Do not load the extension from the development checkout, and do not create separate copies for each browser.

To load the fallback:

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable Developer mode
3. Load unpacked: select `%LOCALAPPDATA%\VelocityDL\chromium-extension`
4. Copy the runtime extension ID shown by the browser
5. In VelocityDL, use the setup assistant's manual fallback section to apply that ID

The setup assistant classifies a connected identity in the trusted backend:

- `Chrome Web Store`: the production ID above; supported, production, and recommended.
- `Local/unpacked`: a different valid ID explicitly written to the native-host manifest through the advanced flow; supported for development, but never labelled official or recommended.
- `Unsupported`: any ID that is neither production nor present in the installed native-host manifests; shown as a genuine mismatch.

Chromium passes the caller extension origin to the native-host process. The host derives the runtime ID from that origin and rejects a heartbeat if its payload claims a different ID. The browser's exact `allowed_origins` check remains in force; there are no wildcards and the renderer cannot mark an extension official.

The RSA `key` in `chromium-extension/manifest.json` deterministically produces the production ID `alnagakehjhbfkdianlkmcncefldpmhm`. This identity fix does not change that key, the Web Store listing, or extension package contents, so it requires a desktop/native-host release but no Chrome Web Store resubmission.

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
