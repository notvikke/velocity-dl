# Release Checklist

This checklist is for preparing a public release build of VelocityDL.

## Before Packaging

- Run `npm run build`
- Run `cargo check --manifest-path src-tauri/Cargo.toml`
- Run `npm run strategy:regression`
- Run `npm run strategy:test`
- Verify the app starts cleanly from a fresh dev build
- Verify first-run setup appears when settings are new
- Verify browser handoff can be disabled and re-enabled from settings
- Verify diagnostics copy works from both settings and failure surfaces
- Verify direct file downloads do not get replaced with landing-page HTML
- Verify extension captures do not auto-queue bad embed or player page URLs

## Windows Packaging

- Build the NSIS installer with `npm run bundle:windows`
- Install on a clean Windows user profile if possible
- Verify the installed app launches correctly
- Verify first-run setup appears after install
- Verify the install does not require manual dependency downloads beyond WebView2 handling from Tauri
- Verify uninstall removes the app cleanly

## Public Repo Preparation

- Keep README and docs generic
- Avoid public-facing marketing text that names implementation-specific target sites
- Remove temporary debug assets and one-off local test notes
- Add a license before publishing
- Add screenshots only if they do not reveal sensitive test material

## Nice-to-Have Before Release

- Add more regression coverage for extension handoff cases
- Add a simple changelog or release notes entry
- Add GitHub issue templates for bug reports and installer problems
- Add a short privacy/support note explaining what diagnostics capture includes
