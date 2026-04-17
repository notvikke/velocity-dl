# VelocityDL

VelocityDL is a desktop download manager built with Tauri, React, and Rust.

It is designed for mixed download workflows:

- direct file downloads
- manifest-based media downloads
- browser handoff from a companion extension
- in-app capture and troubleshooting tools for difficult pages

## Alpha Status

This project is currently being prepared for an early alpha release.

That means:

- features are usable but still under active stabilization
- installer and onboarding flow are still evolving
- some capture paths are more battle-tested than others
- diagnostics and developer tooling are intentionally stronger than polish in some areas

## Current Focus

- reliable browser-to-app handoff
- better failure diagnostics
- safer automatic capture routing
- regression protection for known download patterns
- Windows installer packaging

## Tech Stack

- Tauri 2
- React 19
- TypeScript
- Rust

## Development

Install dependencies:

```powershell
npm install
```

Run the desktop app in development:

```powershell
npm run tauri dev
```

Run a production frontend build:

```powershell
npm run build
```

Build a Windows installer:

```powershell
npm run bundle:windows
```

## Regression Checks

Strategy classification regression matrix:

```powershell
npm run strategy:regression
```

Rust regression test for core classification rules:

```powershell
npm run strategy:test
```

## First-Run Setup

The app includes a first-run setup flow for alpha builds. It lets the user choose initial preferences such as:

- default download folder
- browser capture acceptance
- automatic handling of captured media
- completion sounds

These settings can be changed later from the in-app Settings screen.

## Repository Hygiene

Public-facing documentation in this repository is intentionally generic. Operational support for specific sites or capture patterns is treated as implementation detail rather than product marketing.

## Release Notes

See [docs/alpha-release-checklist.md](/D:/Dev%202026/Tools/VelocityDL/docs/alpha-release-checklist.md) for the current alpha hardening and packaging checklist.

## License

This repository is available under the [MIT License](/D:/Dev%202026/Tools/VelocityDL/LICENSE).

## Support And Reporting

Before posting copied diagnostics publicly, review the guidance in [docs/diagnostics-privacy.md](/D:/Dev%202026/Tools/VelocityDL/docs/diagnostics-privacy.md).

For public alpha tracking, use the GitHub issue templates for:

- app bugs
- Windows installer problems

See [CHANGELOG.md](/D:/Dev%202026/Tools/VelocityDL/CHANGELOG.md) for the current alpha release summary.
