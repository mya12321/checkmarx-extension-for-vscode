# Changelog

## 0.1.4

- **Scans** lists cloud and local runs newest first, with scope (project / single file) and engine (cloud / local) filters that default to cloud project scans and are remembered per workspace. Clicking a scan shows its findings in **Results** (the latest scan is shown by default); an inline graph button opens the scan summary instead of opening it on click.
- **Results** shows exactly one scan with no merging: the latest project scan by default, or the scan you click. Older cloud scans are re-downloaded on demand; local scans are shown while their findings are still in memory. Real-time findings moved to their own **Realtime Results** view (grouped by file), while Problems keeps showing the latest combined results.
- MCP results are no longer merged: `checkmarx_get_results` returns one scan, the new `checkmarx_get_realtime_results` returns real-time findings only, `checkmarx_get_file_findings` and `checkmarx_get_files` take `source="scan" | "realtime"`, and `checkmarx_get_state` reports scan and real-time counts separately.
- Refresh now looks up the project in Checkmarx One and adopts its latest completed scan, so scans started from the web UI or CI appear without re-scanning; the Results toolbar exposes separate cloud and local scan buttons, and Scans moved above Results in the Activity Bar.
- Cloud project scans evaluate every nested `.gitignore` and forward ignored paths as `--file-filter-ext` exclusions, and pass `--exclude-git-folder`.
- Fixed file-level rescans erasing project findings produced by a different engine or scan type (for example a local ASCA rescan removing Critical cloud SAST findings).

## 0.1.3

- Added an explicit `engine` parameter to the MCP `checkmarx_scan_file` tool. It now defaults to `local`; `engine="cloud"` performs a filtered cloud upload after the normal confirmation. `checkmarx_scan_project` already exposed `engine="local" | "cloud"`.
- Updated MCP instructions and documentation to make the local/cloud distinction explicit.

## 0.1.2

- Fixed cloud scans failing with `CODE: 225, Missing Associated Application` by adding `checkmarxLocal.project.applicationName`, passing `--application-name` to `cx scan create`, prompting before the first cloud scan, and adding a **Set application** control to the dashboard.
- Added an early, actionable error for MCP/AI-initiated cloud scans when no application is configured.

## 0.1.1

- Added an Activity Bar **Dashboard** webview with embedded API-key sign-in, project/file cloud and local ASCA scan buttons, real-time toggle, live progress, cancel, severity summary, CLI/MCP controls, and an Activity Bar finding badge.
- Added explicit cloud/local single-file commands and dashboard login form.

## 0.1.0

- API-key authentication with SecretStorage and `cx auth validate`.
- Automatic Checkmarx CLI discovery (PATH, managed install, official extension bundle) and download.
- Whole-project scans:
  - Checkmarx One cloud scan with polling and JSON report import.
  - Local ASCA project scan with gitignore-aware file discovery and bounded concurrency.
- Single-file scans with local ASCA and optional filtered cloud fallback.
- Real-time scanning on save or while typing, with per-file result replacement.
- Unified finding model for SAST, SCA, IaC, secrets, and other engine results.
- VS Code Problems diagnostics, severity/file/type result tree, scan history, status bar, and details webview.
- MCP server registration through `vscode.lm.registerMcpServerDefinitionProvider`.
- Loopback MCP bridge with per-process bearer token, including tool calls for scans, results, details, file findings, cancellation, and navigation.
- AI fix prompts and "Fix with AI" commands for findings, files, and scans.
- JSON, Markdown, and CSV export.
- Unit and end-to-end MCP tests.