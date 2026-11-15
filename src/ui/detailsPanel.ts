import * as vscode from 'vscode';
import type { FindingDetails, ScanSummary } from '../types';
import { formatCounts } from '../severity';
import { SEVERITIES } from '../types';
import { modeLabel, severityLabel, typeLabel } from './icons';

export interface DetailsPanelActions {
  openFinding: (key: string) => Promise<void>;
  fixWithAi: (key: string) => Promise<void>;
  copyPrompt: (key: string) => Promise<void>;
  rescanFile: (file: string) => Promise<void>;
}

export class DetailsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: DetailsPanelActions
  ) {}

  async showFinding(details: FindingDetails): Promise<void> {
    const panel = this.ensurePanel('Checkmarx Finding');
    panel.title = details.finding.title;
    panel.webview.html = this.findingHtml(panel.webview, details);
  }

  async showScan(scan: ScanSummary): Promise<void> {
    const panel = this.ensurePanel('Checkmarx Scan');
    panel.title = `Checkmarx Scan ${scan.id}`;
    panel.webview.html = this.scanHtml(panel.webview, scan);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(title: string): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      'checkmarxLocal.details',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
      }
    );
    this.panel = panel;

    panel.onDidDispose(
      () => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
      },
      undefined
    );

    panel.webview.onDidReceiveMessage(
      async (message: { type?: string; key?: string; file?: string }) => {
        try {
          if (message.type === 'open' && message.key) {
            await this.actions.openFinding(message.key);
          } else if (message.type === 'fix' && message.key) {
            await this.actions.fixWithAi(message.key);
          } else if (message.type === 'copy' && message.key) {
            await this.actions.copyPrompt(message.key);
          } else if (message.type === 'rescan' && message.file) {
            await this.actions.rescanFile(message.file);
          }
        } catch (error) {
          void vscode.window.showErrorMessage(`Checkmarx: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      undefined
    );

    return panel;
  }

  private findingHtml(webview: vscode.Webview, details: FindingDetails): string {
    const finding = details.finding;
    const nonce = randomNonce();
    const location = `${finding.relativeFile ?? finding.file ?? 'Unknown file'}${finding.line ? `:${finding.line}` : ''}`;
    const flow = (finding.nodes ?? [])
      .map((node, index) => {
        const nodeLocation = `${node.file ?? node.fileName ?? 'unknown'}${node.line ? `:${node.line}` : ''}`;
        return `<li><span class="flow-index">${index + 1}</span><span class="flow-name">${escapeHtml(node.name ?? node.domType ?? 'flow step')}</span><code>${escapeHtml(nodeLocation)}</code></li>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(finding.title)}</title>
<style>${baseCss()}</style>
</head>
<body>
<header>
  <span class="badge ${finding.severity.toLowerCase()}">${escapeHtml(severityLabel(finding.severity))}</span>
  <h1>${escapeHtml(finding.title)}</h1>
  <div class="subtitle">${escapeHtml(location)} · ${escapeHtml(typeLabel(finding.type))} · ${escapeHtml(finding.engine)} ${escapeHtml(modeLabel(finding.mode))}</div>
</header>

<section class="actions">
  <button data-action="open" data-key="${escapeHtml(finding.key)}">Open file</button>
  <button data-action="fix" data-key="${escapeHtml(finding.key)}" class="primary">Fix with AI</button>
  <button data-action="copy" data-key="${escapeHtml(finding.key)}">Copy fix prompt</button>
  ${finding.file ? `<button data-action="rescan" data-file="${escapeHtml(finding.file)}">Rescan file</button>` : ''}
</section>

<section class="grid">
  <div><span class="label">Finding id</span><span>${escapeHtml(finding.id)}</span></div>
  <div><span class="label">Severity</span><span>${escapeHtml(finding.severity)}</span></div>
  ${finding.cweId ? `<div><span class="label">CWE</span><span>${escapeHtml(finding.cweId)}</span></div>` : ''}
  ${finding.cveId ? `<div><span class="label">CVE</span><span>${escapeHtml(finding.cveId)}</span></div>` : ''}
  ${finding.packageName ? `<div><span class="label">Package</span><span>${escapeHtml(finding.packageName)}${finding.packageVersion ? `@${escapeHtml(finding.packageVersion)}` : ''}</span></div>` : ''}
  ${finding.recommendedVersion ? `<div><span class="label">Recommended</span><span>${escapeHtml(finding.recommendedVersion)}</span></div>` : ''}
  ${finding.state ? `<div><span class="label">State</span><span>${escapeHtml(finding.state)}</span></div>` : ''}
  <div><span class="label">Scan</span><span>${escapeHtml(finding.scanId)}</span></div>
</section>

${finding.description ? `<section><h2>Description</h2><p>${escapeHtml(finding.description).replace(/\n/g, '<br>')}</p></section>` : ''}
${finding.remediation ? `<section><h2>Remediation</h2><p>${escapeHtml(finding.remediation).replace(/\n/g, '<br>')}</p></section>` : ''}
${details.codeContext ? `<section><h2>Code</h2><pre class="code">${escapeHtml(details.codeContext)}</pre></section>` : finding.codeSnippet ? `<section><h2>Code</h2><pre class="code">${escapeHtml(finding.codeSnippet)}</pre></section>` : ''}
${flow ? `<section><h2>Data flow</h2><ol class="flow">${flow}</ol></section>` : ''}

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('button[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    vscode.postMessage({
      type: button.getAttribute('data-action'),
      key: button.getAttribute('data-key'),
      file: button.getAttribute('data-file')
    });
  });
});
</script>
</body>
</html>`;
  }

  private scanHtml(webview: vscode.Webview, scan: ScanSummary): string {
    const nonce = randomNonce();
    const bars = SEVERITIES.map((severity) => {
      const count = scan.counts[severity];
      const percent = scan.totalFindings > 0 ? Math.round((count / scan.totalFindings) * 100) : 0;
      return `<div class="bar-row"><span class="bar-label">${severityLabel(severity)}</span><div class="bar"><div class="fill ${severity.toLowerCase()}" style="width:${percent}%"></div></div><span class="bar-count">${count}</span></div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Checkmarx scan ${escapeHtml(scan.id)}</title>
<style>${baseCss()}</style>
</head>
<body>
<header>
  <span class="badge ${scan.status === 'completed' ? 'low' : 'medium'}">${escapeHtml(scan.status)}</span>
  <h1>${escapeHtml(modeLabel(scan.mode))} scan</h1>
  <div class="subtitle">${escapeHtml(scan.engine)} · ${escapeHtml(scan.startedAt)}${scan.finishedAt ? ` → ${escapeHtml(scan.finishedAt)}` : ''}</div>
</header>

<section class="grid">
  <div><span class="label">Scan id</span><span>${escapeHtml(scan.id)}</span></div>
  ${scan.cloudScanId ? `<div><span class="label">Cloud scan id</span><span>${escapeHtml(scan.cloudScanId)}</span></div>` : ''}
  ${scan.projectName ? `<div><span class="label">Project</span><span>${escapeHtml(scan.projectName)}</span></div>` : ''}
  ${scan.branch ? `<div><span class="label">Branch</span><span>${escapeHtml(scan.branch)}</span></div>` : ''}
  ${scan.relativeFile ?? scan.file ? `<div><span class="label">File</span><span>${escapeHtml(scan.relativeFile ?? scan.file ?? '')}</span></div>` : ''}
  <div><span class="label">Findings</span><span>${scan.totalFindings}${scan.totalFindings > 0 ? ` (${escapeHtml(formatCounts(scan.counts))})` : ''}</span></div>
</section>

${scan.error ? `<section><h2>Error</h2><p class="error">${escapeHtml(scan.error)}</p></section>` : ''}
${scan.totalFindings > 0 ? `<section><h2>Severity distribution</h2>${bars}</section>` : ''}
</body>
</html>`;
  }
}

function baseCss(): string {
  return `
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 28px 48px; line-height: 1.55; }
  h1 { font-size: 24px; margin: 10px 0 6px; font-weight: 600; }
  h2 { font-size: 15px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); font-weight: 600; }
  header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; margin-bottom: 18px; }
  section { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; margin: 14px 0; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 13px; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .04em; color: #fff; background: var(--vscode-badge-background); }
  .badge.critical, .badge.high { background: #d13438; }
  .badge.medium { background: #b87500; }
  .badge.low, .badge.info { background: #5a7d9a; }
  .actions { background: transparent; border: 0; padding: 0; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 3px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; }
  .grid > div { display: flex; flex-direction: column; gap: 2px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
  pre.code { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .flow { list-style: none; margin: 0; padding: 0; }
  .flow li { display: grid; grid-template-columns: 22px 1fr; gap: 2px 10px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .flow li:last-child { border-bottom: 0; }
  .flow-index { color: var(--vscode-descriptionForeground); }
  .flow code { grid-column: 2; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .bar-row { display: grid; grid-template-columns: 80px 1fr 40px; gap: 10px; align-items: center; margin: 6px 0; }
  .bar { height: 8px; background: var(--vscode-progressBar-background); border-radius: 4px; overflow: hidden; opacity: .35; }
  .fill { height: 100%; }
  .fill.critical, .fill.high { background: #d13438; }
  .fill.medium { background: #b87500; }
  .fill.low, .fill.info { background: #5a7d9a; }
  .bar-label, .bar-count { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .bar-count { text-align: right; }
  .error { color: var(--vscode-errorForeground); }
  p { margin: 0; }
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}