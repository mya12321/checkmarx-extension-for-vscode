import * as vscode from 'vscode';
import type { ScanSummary } from '../types';
import { formatCounts } from '../severity';
import { applyScanFilters, DEFAULT_SCAN_FILTERS, type ScanListFilters } from '../scans/scanFilters';
import { statusIcon } from './icons';

export class ScansTreeProvider implements vscode.TreeDataProvider<ScanSummary>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ScanSummary | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly getHistory: () => ScanSummary[],
    private readonly getSelectedId: () => string | undefined = () => undefined,
    private readonly getFilters: () => ScanListFilters = () => DEFAULT_SCAN_FILTERS
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(element?: ScanSummary): ScanSummary[] {
    if (element) {
      return [];
    }
    return applyScanFilters(this.getHistory(), this.getFilters());
  }

  getTreeItem(scan: ScanSummary): vscode.TreeItem {
    const engine = scan.engine === 'cloud' ? 'Checkmarx One' : 'ASCA local';
    const kind = scan.mode === 'project' ? 'project' : 'file';
    const item = new vscode.TreeItem(`${engine} ${kind} scan`, vscode.TreeItemCollapsibleState.None);
    item.id = scan.id;
    const count = `${scan.totalFindings} finding${scan.totalFindings === 1 ? '' : 's'}`;
    const when = scan.startedAt ? relativeTime(scan.startedAt) : '';
    const selected = this.getSelectedId() === scan.id ? ' · selected' : '';
    item.description = `${scan.status} · ${count} · ${when}${selected}`;
    item.iconPath = statusIcon(scan.status);
    item.contextValue = 'checkmarxScan';
    item.command = {
      command: 'checkmarxLocal.selectScan',
      title: 'Show results of this scan',
      arguments: [scan.id]
    };
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${engine} scan · ${scan.status}**\n\n`);
    tooltip.appendMarkdown(`Engine: ${scan.engine}${scan.scanTypes.length > 0 ? ` (${scan.scanTypes.join(', ')})` : ''}\n\n`);
    tooltip.appendMarkdown('Click to show these findings in the Results view; use the details button for the scan summary.\n\n');
    if (scan.projectName) {
      tooltip.appendMarkdown(`Project: ${scan.projectName}${scan.branch ? ` (${scan.branch})` : ''}\n\n`);
    }
    if (scan.relativeFile ?? scan.file) {
      tooltip.appendMarkdown(`File: \`${scan.relativeFile ?? scan.file}\`\n\n`);
    }
    if (scan.totalFindings > 0) {
      tooltip.appendMarkdown(`Findings: ${scan.totalFindings} (${formatCounts(scan.counts)})\n\n`);
    }
    if (scan.error) {
      tooltip.appendMarkdown(`Error: ${scan.error}\n\n`);
    }
    tooltip.appendMarkdown(`${scan.startedAt}${scan.finishedAt ? ` → ${scan.finishedAt}` : ''}`);
    item.tooltip = tooltip;
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }
  return `${Math.round(seconds / 86400)}d ago`;
}