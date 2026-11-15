# Changelog

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