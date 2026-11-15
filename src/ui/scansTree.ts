import * as vscode from 'vscode';
import type { ScanSummary } from '../types';
import { formatCounts } from '../severity';
import { modeLabel, statusIcon } from './icons';

export class ScansTreeProvider implements vscode.TreeDataProvider<ScanSummary>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ScanSummary | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getHistory: () => ScanSummary[]) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(element?: ScanSummary): ScanSummary[] {
    if (element) {
      return [];
    }
    return this.getHistory();
  }

  getTreeItem(scan: ScanSummary): vscode.TreeItem {
    const item = new vscode.TreeItem(`${modeLabel(scan.mode)} scan`, vscode.TreeItemCollapsibleState.None);
    item.id = scan.id;
    const count = `${scan.totalFindings} finding${scan.totalFindings === 1 ? '' : 's'}`;
    const when = scan.startedAt ? relativeTime(scan.startedAt) : '';
    item.description = `${scan.status} · ${count} · ${when}`;
    item.iconPath = statusIcon(scan.status);
    item.contextValue = 'checkmarxScan';
    item.command = {
      command: 'checkmarxLocal.showScanSummary',
      title: 'Show scan summary',
      arguments: [scan.id]
    };
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${modeLabel(scan.mode)} scan · ${scan.status}**\n\n`);
    tooltip.appendMarkdown(`Engine: ${scan.engine}\n\n`);
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