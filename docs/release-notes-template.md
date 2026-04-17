# Release Notes Template

Use this template when publishing a new GitHub release.

## Title

`VelocityDL <version>`

Example:

`VelocityDL 0.1.0-beta.1`

## Notes Template

```md
<release type> release.

Highlights:
- <highest-signal user-facing fix>
- <second important stability or UX improvement>
- <installer or packaging change, if relevant>

Installer choices:
- Slim installer: smaller download, best when the PC already has WebView2 and can fetch runtime tools as needed.
- Full installer: larger download, bundles offline dependencies for lower first-run failure rate.

Known limitations:
- Browser extension still requires one-time setup and extension ID registration.
- DRM-protected or otherwise unsupported streams are not supported.
```

## Asset Naming

Preferred Windows asset names:

- `VelocityDL_<version>_x64-setup-slim.exe`
- `VelocityDL_<version>_x64-setup-full.exe`

## Pre-Publish Checks

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run bundle:windows:slim`
- `npm run bundle:windows:full`
- Confirm both installers exist in `src-tauri/target/release/bundle/nsis`
- Confirm release notes mention any installer-affecting bug fixes
- Confirm changelog and README are aligned with the actual shipped release
