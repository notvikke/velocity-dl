# Regression Harness

This repo now keeps a small regression harness for URL strategy classification so site-specific fixes do not silently undo earlier progress.

## What it protects

- Direct-file detection for ordinary media and generic downloadable files
- HLS and DASH manifest recognition
- Known page/embed URLs staying metadata-driven instead of being misclassified as direct downloads

## Commands

Run the fixture-driven matrix:

```powershell
npm run strategy:regression
```

Run the Rust unit tests for classification regressions:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml strategy_classification_regression_examples
```

## Fixture file

The checked-in matrix lives at:

- [scripts/strategy-targets.regression.csv](/D:/Dev%202026/Tools/VelocityDL/scripts/strategy-targets.regression.csv)

Each row uses:

- `label`
- `url`
- `expected_strategy`
- `skip`
- `note`

Supported strategies:

- `direct_file`
- `hls_manifest`
- `dash_manifest`
- `metadata_extractor`

## How to extend it

When a new site or capture pattern is debugged successfully:

1. Add a representative URL to the regression CSV.
2. Choose the expected strategy that must remain stable.
3. Add a short note explaining what regression the row is guarding.
4. If the case represents a core rule rather than just a fixture, add a Rust unit-test example too.

## Current limitation

This harness validates strategy classification only. It does not yet replay live browser capture flows, cookies, or network-dependent extraction. That is still useful because a large class of regressions comes from URL misclassification before any site-specific extraction even begins.
