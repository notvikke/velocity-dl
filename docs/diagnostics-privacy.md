# Diagnostics Privacy And Support

VelocityDL includes optional diagnostics copy actions to help with troubleshooting alpha builds.

## What diagnostics may include

- app version and runtime environment details
- configured download path and selected app settings
- binary/tool availability checks used by the app
- recent download strategy telemetry
- recent frontend warning and error messages captured in the app session
- the context label of the screen or action where diagnostics were copied

## What diagnostics are intended for

- reproducing install, startup, metadata, capture, and download failures
- identifying whether a failure came from app state, browser handoff, or external tools
- reducing back-and-forth during alpha bug reports

## Things to review before sharing

- local filesystem paths may appear in diagnostics output
- URLs associated with the failed action may appear in diagnostics context
- browser extension or request metadata may be present when capture debugging is involved
- recent console error text may include page-specific or file-specific details

If you do not want those details shared, review and redact the copied diagnostics text before posting it in a public issue.

## Support Expectations

Alpha support is best-effort.

When filing a report, include:

- what you were trying to do
- how you triggered the failure
- whether the issue is reproducible
- the copied diagnostics text after reviewing and redacting it as needed
- whether the problem happened in a packaged install or a development build
