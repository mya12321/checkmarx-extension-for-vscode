# Checkmarx Local Scan & MCP for VS Code

Run Checkmarx scans directly from VS Code with an API key, including **local ASCA scans** that do not require the official extension's Developer Assist / Direct Scan entitlements, and an **MCP server** that lets AI agents read findings and verify fixes.

The extension is intentionally independent from the official `checkmarx.ast-results` and `checkmarx.cx-dev-assist` extensions. It talks to the public `cx` CLI, keeps results in the workspace, and exposes them to VS Code's language model tools through a local MCP bridge.

## Features

- **API-key sign-in** using VS Code SecretStorage. The key is passed to the CLI through environment variables, never argv.
- **Three scan modes**
  1. **Whole project** — a Checkmarx One cloud scan (SAST/SCA/IaC/API findings) or a fully local ASCA project scan.
  2. **Single file** — local ASCA scan, with an optional filtered cloud-scan fallback.
  3. **Real-time** — scan the current file on save or while typing (debounced), with Problems diagnostics and gutter-visible results.
- **MCP server registered with VS Code** via `vscode.lm.registerMcpServerDefinitionProvider`.
  - Trigger scans, list findings, read remediation/data flow, open files, and rescan after edits.
  - Works with GitHub Copilot Chat agent mode and other MCP clients.
- **AI fix workflow** — "Fix with AI" builds a focused prompt with the finding, data flow, code context, remediation guidance, and a mandatory rescan step.
- **Results UI** — severity/file/type grouping, deep finding details, scan history, code context, diagnostics, status bar, and JSON/Markdown/CSV export.
- **CLI management** — finds `cx` on `PATH`, uses the CLI bundled with the official extension, or downloads the official CLI into extension storage (checksum-verified when available).

## Activity Bar dashboard

Click the **Checkmarx** icon in the Activity Bar. The **Dashboard** view opens first and provides one-click controls for the whole workflow:

- Embedded API-key sign-in form (region, base URI, IAM URI, tenant, API key) and sign-out.
- **Project scan → Upload to cloud** and **Project scan → Local ASCA**; the cloud card includes **Set / Change** for the required Checkmarx One application association.
- **Current file → Upload to cloud** and **Current file → Local ASCA**. The buttons are disabled when no editor file is active.
- Real-time scanning switch (`onSave` / `onType` according to settings).
- Live scan progress with a cancel button.
- Severity summary, latest scan, **Open results**, and **Clear**.
- CLI status with **Install / update** and **Select path**, plus MCP status and **Restart MCP**.

Results and Scans remain available as separate views below the dashboard in the same Checkmarx Activity Bar container.

## Requirements

- VS Code **1.101 or newer** (MCP server definition provider API).
- A Checkmarx One tenant and an API key for cloud scans.
- The Checkmarx CLI (`cx`). The extension can download it automatically, or you can point `checkmarxLocal.cliPath` at an existing binary.
- For local ASCA scans: the CLI downloads the local engine on first use (internet access and a writable home directory are required). The engine is cached under `~/.checkmarx/CxVorpal`.

> **Licensing:** use this extension only with a Checkmarx account and tenant you are authorized to use. Cloud scan types and local engines remain subject to your Checkmarx subscription and tenant configuration. Local ASCA scans run entirely on your machine; cloud scans upload source code to Checkmarx One.

## Install

### From a VSIX

```bash
npm install
npm run package
code --install-extension checkmarx-local-0.1.3.vsix
```

Reload VS Code, open a folder, then run **Checkmarx: Sign In with API Key** from the Command Palette.

### From source

```bash
npm install
npm run build
```

Press `F5` in VS Code with this repository open to launch the Extension Development Host.

## Sign in

1. Run **Checkmarx: Sign In with API Key**.
2. Pick a region (US, EU, or custom/on-premises).
3. Confirm the Checkmarx One base URI and IAM URI.
4. Enter your tenant and API key.

The key is validated with `cx auth validate` and stored in VS Code SecretStorage. If you cannot reach the tenant right now you can choose **Save anyway**; local ASCA scans do not need the API key, and cloud scans can be retried later. Existing `CX_APIKEY` / `CX_BASE_URI` / `CX_TENANT` environment variables are also honored when no secret is stored.

The equivalent settings are:

| Setting | Example |
| --- | --- |
| `checkmarxLocal.baseUri` | `https://ast.checkmarx.net` |
| `checkmarxLocal.baseAuthUri` | `https://iam.checkmarx.net` |
| `checkmarxLocal.tenant` | `my-tenant` |

## Scan modes

### 1. Whole project

Run **Checkmarx: Scan Project**. The engine is selected by `checkmarxLocal.scan.projectEngine`:

- **`cloud`** (default) — `cx scan create` uploads the workspace, waits for the scan, downloads the JSON report, and normalizes SAST/SCA/IaC/Secrets/API findings. Configure scan types with `checkmarxLocal.scan.scanTypes`.
- **`local`** — the extension discovers source files (respecting `.gitignore` when available and `checkmarxLocal.scan.exclude`), runs the ASCA engine file-by-file with bounded concurrency, and aggregates the findings. Nothing is uploaded.

You can run either engine explicitly from the Command Palette:

- **Checkmarx: Scan Project (Checkmarx One cloud)**
- **Checkmarx: Scan Project (local ASCA engine)**

Cloud scans are confirmed once per session because they upload source code. The same confirmation applies when an AI agent asks the MCP server to start a cloud scan; declining keeps the code local.

### 2. Single file

- Run **Checkmarx: Scan Current File**, or use the editor title button.
- Right-click a file in the Explorer and choose **Checkmarx: Scan File...**.

Single-file scans use the local ASCA engine by default, which is fast and does not upload code. If ASCA fails and `checkmarxLocal.scan.fileFallbackToCloud` is enabled (off by default), the extension retries as a filtered cloud scan (`--file-filter`) of that one file. Enabling that fallback is an explicit opt-in to uploading the file.

### 3. Real-time

Run **Checkmarx: Toggle Real-time Scan** or enable `checkmarxLocal.realtime.enabled`.

- `checkmarxLocal.realtime.trigger` = `onSave` (default) or `onType`.
- `onType` scans a temporary snapshot of the unsaved editor content, debounced by `checkmarxLocal.realtime.debounceMs`.
- Large, generated, minified, excluded, and unsupported files are skipped.
- Results for a file replace older results for that file, so fixing code and rescanning clears stale diagnostics.

## MCP integration and AI auto-fix

The extension starts a loopback HTTP bridge and registers a stdio MCP server named **Checkmarx Local Scan** with VS Code. No manual `mcp.json` is required in VS Code.

### Use with Copilot Chat

1. Open **Copilot Chat** in Agent mode.
2. Open the tools picker and enable the **Checkmarx Local Scan** tools (the server is listed under MCP servers).
3. Ask, for example:

```text
Scan this project locally and fix the highest-severity findings.
After each edit, rescan the changed file and verify the finding is gone.
```

Or use the built-in `/mcp.checkmarxLocal.fix_findings` prompt if your client exposes MCP prompts.

AI-initiated cloud scans require a confirmation modal in VS Code. Local scans do not upload anything and do not prompt. `checkmarx_scan_file` defaults to `engine="local"`, so post-edit rescans stay local unless the agent explicitly requests `engine="cloud"`.

The MCP server instructions require the agent to:

1. Fetch findings before editing.
2. Read full details, remediation, and data flow.
3. Fix the root cause without suppressing diagnostics.
4. Rescan each changed file and iterate until clean.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `checkmarx_get_state` | Auth/CLI state, latest scan, counts, active scan progress. |
| `checkmarx_scan_project` | Start a project scan with `engine="local"` or `"cloud"` (defaults to the extension setting), optionally wait. |
| `checkmarx_scan_file` | Scan one file; `engine="local"` is the default for fix verification, `engine="cloud"` uploads that file after confirmation. |
| `checkmarx_get_results` | List findings with severity/type/file filters. |
| `checkmarx_get_finding` | Full details, data flow, and surrounding code. |
| `checkmarx_get_file_findings` | Findings for one file, with optional code context. |
| `checkmarx_list_scans` | Recent scan summaries. |
| `checkmarx_get_files` | Files with current findings and counts. |
| `checkmarx_cancel_scan` | Cancel the active scan. |
| `checkmarx_open_finding` | Reveal a finding in the editor. |

### Use with another MCP client

Run **Checkmarx: Show MCP Server Info** and copy the generated configuration. It contains the stdio command, the bridge URL, and a per-process bridge token. Treat that token as a secret.

The bridge only listens on `127.0.0.1`, requires the token for every request, and refuses non-loopback connections.

## Commands

| Command | Description |
| --- | --- |
| `Checkmarx: Sign In with API Key` | Configure tenant/URLs and store the API key. |
| `Checkmarx: Sign Out` | Remove the stored API key. Local scans still work. |
| `Checkmarx: Scan Project` | Scan using the configured project engine. |
| `Checkmarx: Scan Project (Checkmarx One cloud)` | Force a cloud project scan. |
| `Checkmarx: Scan Project (local ASCA engine)` | Force a local project scan. |
| `Checkmarx: Open Dashboard` | Focus the Activity Bar dashboard. |
| `Checkmarx: Set Application Name` | Set the Checkmarx One application for cloud scans (CODE 225). |
| `Checkmarx: Scan Current File` | Scan the active editor file using the configured file engine. |
| `Checkmarx: Scan Current File (Cloud)` | Force a cloud scan of the active file. |
| `Checkmarx: Scan Current File (Local ASCA)` | Force a local ASCA scan of the active file. |
| `Checkmarx: Scan File...` | Pick a file and use the configured engine. |
| `Checkmarx: Scan File... (Cloud)` | Pick a file and upload it for a filtered cloud scan. |
| `Checkmarx: Scan File... (Local ASCA)` | Pick a file and scan it locally. |
| `Checkmarx: Toggle Real-time Scan` | Enable/disable scans while editing. |
| `Checkmarx: Cancel Scan` | Abort the active scan. |
| `Checkmarx: Clear Results` | Remove current findings (history summaries remain). |
| `Checkmarx: Fix Finding with AI` | Build a fix prompt and open chat. |
| `Checkmarx: Fix File Findings with AI` | Fix all findings in one file. |
| `Checkmarx: Copy AI Fix Prompt` | Copy the prompt without opening chat. |
| `Checkmarx: Export Results...` | Export JSON, Markdown, or CSV. |
| `Checkmarx: Install / Update CLI` | Download the official CLI into extension storage. |
| `Checkmarx: Select CLI Path...` | Use an existing `cx` binary. |
| `Checkmarx: Show MCP Server Info` | Show/copy MCP configuration. |
| `Checkmarx: Run Diagnostics` | Check CLI, auth, MCP, and real-time state. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `checkmarxLocal.baseUri` | `""` | Checkmarx One base URI. |
| `checkmarxLocal.baseAuthUri` | `""` | Checkmarx IAM base URI. |
| `checkmarxLocal.tenant` | `""` | Tenant name. |
| `checkmarxLocal.cliPath` | `auto` | `cx` binary path; `auto` searches PATH, managed storage, and the official extension bundle. |
| `checkmarxLocal.cliExtraArgs` | `[]` | Extra global CLI flags. |
| `checkmarxLocal.cliAutoInstall` | `true` | Offer to download the CLI when missing. |
| `checkmarxLocal.project.name` | `""` | Project name; defaults to the workspace folder name. |
| `checkmarxLocal.project.applicationName` | `""` | Existing Checkmarx One application associated with cloud scans (required for CODE 225). |
| `checkmarxLocal.project.branch` | `""` | Branch; defaults to the Git branch or `main`. |
| `checkmarxLocal.scan.projectEngine` | `cloud` | `cloud` or `local`. |
| `checkmarxLocal.scan.scanTypes` | `["sast"]` | Cloud scan types. |
| `checkmarxLocal.scan.fileEngine` | `local` | Single-file engine. |
| `checkmarxLocal.scan.fileFallbackToCloud` | `false` | Retry a failed local file scan in the cloud. |
| `checkmarxLocal.scan.localConcurrency` | `2` | Parallel ASCA file scans. |
| `checkmarxLocal.scan.localMaxFiles` | `2000` | Local project scan file limit. |
| `checkmarxLocal.scan.exclude` | common build dirs | Excluded globs. |
| `checkmarxLocal.scan.timeoutMinutes` | `30` | Cloud scan timeout. |
| `checkmarxLocal.scan.pollIntervalSeconds` | `5` | Cloud scan polling interval. |
| `checkmarxLocal.realtime.enabled` | `false` | Real-time scanning. |
| `checkmarxLocal.realtime.trigger` | `onSave` | `onSave` or `onType`. |
| `checkmarxLocal.realtime.debounceMs` | `1200` | Debounce. |
| `checkmarxLocal.realtime.maxFileSizeKb` | `512` | Size limit. |
| `checkmarxLocal.realtime.extensions` | common code extensions | Scannable extensions. |
| `checkmarxLocal.diagnostics.enabled` | `true` | Publish Problems diagnostics. |
| `checkmarxLocal.diagnostics.minSeverity` | `LOW` | Minimum severity. |
| `checkmarxLocal.results.groupBy` | `severity` | `severity`, `file`, or `type`. |
| `checkmarxLocal.mcp.enabled` | `true` | Register the MCP server. |
| `checkmarxLocal.ai.openChatAfterFixPrompt` | `true` | Open chat when fixing with AI. |

## Architecture

```text
VS Code
  ├── Extension host
  │   ├── ScanService ── CLI runner ── cx CLI ── local ASCA engine / Checkmarx One API
  │   ├── Diagnostics + tree views + status bar
  │   └── McpBridge (127.0.0.1, bearer token)
  │
  └── Copilot / MCP client
      └── dist/mcp-server.js (stdio) ── HTTP ── McpBridge
```

- Cloud scans use `cx scan create --async --scan-info-format json`, poll `cx scan show`, and download the JSON report with `cx results show --report-format json`.
- Local scans use `cx scan asca -s <file>`. The extension deliberately does not set `--agent` for local scans, so the CLI's local default path is used. Cloud scans never include credentials in argv; the API key travels in `CX_APIKEY`.
- Results are normalized into a single `Finding` model and persisted per workspace under extension global storage. Raw CLI payloads are dropped from persistence.
- The MCP bridge is loopback-only and authenticated with a random per-process token. The MCP server receives the token through its environment and can reload it from a mode-0600 bridge file if the extension restarts.

## Limitations

- Only the **first workspace folder** is scanned; multi-root workspaces should be opened as separate windows.
- Local project scans run the ASCA engine file-by-file and are capped by `checkmarxLocal.scan.localMaxFiles` (default 2000). They are best for focused projects; use the cloud engine for complete SCA/IaC coverage.
- Persisted results are capped to keep workspace storage bounded. The full in-memory result set is available until the window reloads.
- The MCP tools are a wrapper around this extension's results; triage/state updates and ignore management remain in the official Checkmarx UI.

## Troubleshooting

### "Checkmarx CLI (cx) was not found"

Run **Checkmarx: Install / Update CLI** or **Checkmarx: Select CLI Path...**. On corporate networks set `HTTPS_PROXY` / `HTTP_PROXY` before starting VS Code; the downloader honors them.

### Local ASCA scan fails while installing the engine

The CLI installs the engine into `~/.checkmarx/CxVorpal`. Make sure your home directory is writable and you can reach `download.checkmarx.com`. If you use a custom engine location, pass it via `checkmarxLocal.cliExtraArgs` (`--asca-location ...`).

### Cloud scan fails with `CODE: 225, Missing Associated Application`

Cloud project creation requires an application association in your tenant. Set `checkmarxLocal.project.applicationName` to an existing application name (or click **Set** / **Change** in the dashboard's Project scan card). The name must match exactly and the API key must have access to it. If the tenant has no application yet, create one in **Checkmarx One → Applications** first.

### Cloud scan fails with a permission error

Your API key may not have scan permission, the project may be restricted, or the tenant may not license the requested scan type. Switch `checkmarxLocal.scan.projectEngine` to `local` to scan without uploading.

### MCP tools do not appear

- Confirm `checkmarxLocal.mcp.enabled` is on.
- Run **Checkmarx: Restart MCP Server**, then reload the chat view.
- In Copilot Chat, open the tools picker and check that **Checkmarx Local Scan** is enabled.
- In remote SSH/Codespaces, ensure the MCP server runs in the workspace environment (the extension is declared `extensionKind: workspace`).
- Run **Checkmarx: Run Diagnostics** and inspect the output channel.

### "No scannable source files were found"

Check `checkmarxLocal.realtime.extensions` and `checkmarxLocal.scan.exclude`. Local project scans use `git ls-files` when the workspace is a Git repository, so untracked but non-ignored files are included.

### Coexistence with the official Checkmarx extensions

This extension uses a separate activity bar container, output channel, diagnostics source, storage, and command namespace. It can reuse the CLI bundled with the official extension but does not modify the official extension's settings or results. The official extension may still show its own diagnostics and status bar.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run package
```

The extension has no runtime VS Code dependency in its MCP server or scan-normalization core, which keeps the MCP process small and testable.

## License

MIT. Checkmarx and Checkmarx One are trademarks of Checkmarx Ltd. This project is not affiliated with or endorsed by Checkmarx.