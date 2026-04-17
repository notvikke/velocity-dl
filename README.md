# VelocityDL

VelocityDL is a desktop download manager built with Tauri, React, and Rust.

It is designed for mixed download workflows:

- direct file downloads
- manifest-based media downloads
- browser handoff from a companion extension
- in-app capture and troubleshooting tools for difficult pages

## Beta Status

This project is currently being prepared for its first public beta release.

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

## Release Variants

 Windows beta builds ship in two variants:

- Slim installer:
  - smaller download than the full package
  - best when the target machine already has WebView2 or reliable internet
  - downloads some runtime dependencies only when needed
- Full installer:
  - much larger download because it carries offline dependencies
  - bundles WebView2 offline install and bundled media tools
  - lower first-run failure rate on clean or offline-leaning machines

The browser handoff fix for early extension requests is included in both tracks.

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

Build the slim Windows installer:

```powershell
npm run bundle:windows:slim
```

Build the full Windows installer:

```powershell
npm run bundle:windows:full
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

The app includes a first-run setup flow for beta builds. It lets the user choose initial preferences such as:

- default download folder
- browser capture acceptance
- automatic handling of captured media
- completion sounds

These settings can be changed later from the in-app Settings screen.

## Repository Hygiene

Public-facing documentation in this repository is intentionally generic. Operational support for specific sites or capture patterns is treated as implementation detail rather than product marketing.

## Release Notes

See [docs/alpha-release-checklist.md](/D:/Dev%202026/Tools/VelocityDL/docs/alpha-release-checklist.md) for the current release hardening and packaging checklist.

## License

This repository is available under the [MIT License](/D:/Dev%202026/Tools/VelocityDL/LICENSE).

## Support And Reporting

Before posting copied diagnostics publicly, review the guidance in [docs/diagnostics-privacy.md](/D:/Dev%202026/Tools/VelocityDL/docs/diagnostics-privacy.md).

For public beta tracking, use the GitHub issue templates for:

- app bugs
- Windows installer problems

Known beta-stage bugs worth reporting with diagnostics:

- browser extension handoff does not reach the desktop app
- installer succeeds but app fails to open on a clean Windows PC
- bundled or updated tool status looks wrong in Settings
- browser capture works in one release track but not the other

See [CHANGELOG.md](/D:/Dev%202026/Tools/VelocityDL/CHANGELOG.md) for the current beta release summary.
