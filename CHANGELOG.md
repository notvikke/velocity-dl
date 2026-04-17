# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0-alpha.1 - 2026-04-17

Initial public alpha preparation release.

- Added Windows NSIS installer packaging.
- Added first-run onboarding for core preferences.
- Improved browser extension handoff and iframe-aware capture flow.
- Added explicit download strategy routing for direct, HLS, DASH, and metadata flows.
- Routed HLS and DASH downloads through `ffmpeg` with live progress reporting.
- Added app and extension diagnostics copy flows.
- Added regression coverage for strategy classification and browser handoff behavior.

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
