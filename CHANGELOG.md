# Changelog

All notable changes to this project will be documented in this file.

## 0.2.1 - 2026-07-13

Official Chrome Web Store integration bug-fix release.

- Fixed Browser Setup Assistant identity validation so the official Chrome Web Store extension remains supported when manifests are missing, stale, or accompanied by an optional local unpacked ID.
- Bound native-host heartbeat identity to Chromium's caller origin and preserved production access alongside advanced local-extension setup.
- Hardened browser-session, webview, download-reveal, deep-sniff, and native-host flows covered by the new regression checks.
- The official Chrome Web Store extension remains unchanged; no Web Store resubmission is required for this desktop release.

## 0.2.0 - 2026-07-13

Browser compatibility and download reliability release.

- Expanded browser setup and native-messaging support across Chrome, Edge, Helium, Brave, Vivaldi, Opera, Opera GX, and other Chromium-family browsers.
- Staged one stable app-managed extension copy for installed builds and clarified the unpacked fallback flow.
- Improved HLS compatibility for disguised media segments, non-persistent manifest hosts, browser request headers, and master-playlist selection.
- Hardened direct-download probing and ranged transfers against ignored range requests and misleading content lengths.
- Kept failed downloads visible in the active queue and improved browser integration status guidance.
- Updated the VelocityDL Bridge extension package to version 0.1.2.
- Fixed the Browser Setup Assistant falsely rejecting the official Web Store extension when a browser manifest was missing, stale, or configured for an unpacked ID; native manifests now retain production access alongside the optional local identity.
- Bound heartbeat identity to Chromium's native-messaging caller origin instead of trusting the extension's claimed runtime ID alone.

## 0.1.0-beta.3 - 2026-07-11

Browser capture and extension reliability release.

- Improved browser-originated capture routing for direct files, manifests, and ambiguous page captures.
- Added stronger browser session propagation and native-bridge transport reliability across retries and resumes.
- Refined scan overlay, quality selection, extension diagnostics, and release packaging behavior.
- Updated the Chrome Web Store extension package to version 0.1.1.

## 0.1.0-beta.2 - 2026-07-04

Browser takeover reliability and release-packaging hardening update.

- Added a deterministic browser-originated routing flow so direct files, manifests, and ambiguous page captures follow explicit takeover paths instead of drifting through mixed heuristics.
- Added detailed per-download procedure reporting in the app so failures and fallbacks now show what was attempted, what failed, and what succeeded.
- Added a Start Download confirmation path for ambiguous browser captures while keeping auto-start behavior for strong browser-confirmed direct and manifest downloads.
- Improved browser session propagation for downloader, manifest, and extractor flows so referrer and request headers survive handoff, retry, and resume more reliably.
- Improved scan overlay and extension capture routing behavior, including clearer quality-selection handling and less duplicated extension UI.
- Hardened delete flow support so the app can distinguish removing a queue item from removing the downloaded file on disk.
- Switched the default Windows installer path to a lean package that bundles only the essential app components and downloads heavy media tools on demand.
- Added a safe dev-cache cleanup script so local Rust build caches can be removed without losing release installers.

## 0.1.0-alpha.1 - 2026-04-17

Initial public alpha preparation release.

- Added Windows NSIS installer packaging.
- Added first-run onboarding for core preferences.
- Improved browser extension handoff and iframe-aware capture flow.
- Added explicit download strategy routing for direct, HLS, DASH, and metadata flows.
- Routed HLS and DASH downloads through `ffmpeg` with live progress reporting.
- Added app and extension diagnostics copy flows.
- Added regression coverage for strategy classification and browser handoff behavior.

## 0.1.0-beta.1 - 2026-04-18

First public beta candidate focused on browser bridge reliability and setup clarity.

- Fixed extension heartbeat ingestion so the app can correctly detect a connected browser extension from native inbox events.
- Hardened native host setup by staging the host to a stable LocalAppData location and repairing dev-time resource fallback so cleaned workspaces do not break the app.
- Added browser setup diagnostics that surface the detected runtime ID, installed manifest targets, and clearer connection-state messaging.
- Staged the bundled Chromium extension into a stable app-managed folder for installed builds instead of relying on the developer workspace path.
- Improved the browser setup assistant with explicit ID update and repair actions, clearer installed-vs-match language, and guidance about multiple unpacked extension copies.
- Refined the extension popup and scan overlay UI so controls are cleaner and less intrusive on top of page content.

## 0.1.0-alpha.4 - 2026-04-17

Dual-installer stabilization release.

- Fixed a release-blocking browser handoff regression where the first extension capture could be dropped on startup because native inbox polling began late and the initial inbox cursor skipped unread events.
- Added runtime tool update controls for `yt-dlp` and `ffmpeg` with delayed background checking so app startup time is not impacted.
- Added explicit Windows slim/full installer build tracks so slim releases can stay small while full releases carry offline dependencies.
- Alpha.4 ships with two installer assets:
  - slim installer with smaller download size and on-demand runtime/tool setup when needed
  - full installer with bundled offline dependencies for lower first-run failure rate on clean PCs

## 0.1.0-alpha.3 - 2026-04-17

Assisted browser setup and packaging update.

- Added an in-app browser setup assistant from the status bar so users can open Chrome or Edge extension pages, open the bundled extension folder, paste extension IDs, and install the native bridge without PowerShell.
- Bundled the Chromium extension assets and native host executable into Windows installer builds so extension setup can start from the installed app.
- Added direct app-side native messaging registration for Chrome and Edge to reduce first-run setup failures.

## 0.1.0-alpha.2 - 2026-04-17

Installer hardening and browser handoff safety update.

- Fixed the first-run setup modal so it no longer clips on shorter app windows.
- Enforced a single running app instance and refocused the first instance when launched again.
- Fixed tray interaction so the app can be reopened and quit reliably from the tray menu.
- Added onboarding and settings controls for launch on startup.
- Added onboarding and settings controls for browser default handoff mode.
- Synced extension takeover defaults from app settings through the native host.
- Added extension heartbeat and in-app extension health status.
- Added a safer browser-download takeover handshake so the browser keeps the original download when app handoff is rejected or times out.

## Unreleased

- Manifest progress fallback hardening is still in progress.
- DRM and other unsupported protected streams are not supported.
