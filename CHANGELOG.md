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

## Unreleased

- Manifest progress fallback hardening is still in progress.
- DRM and other unsupported protected streams are not supported.
