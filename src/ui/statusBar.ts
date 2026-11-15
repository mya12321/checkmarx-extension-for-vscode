import * as vscode from 'vscode';
import { formatCounts } from '../severity';
import type { ScanUiState } from '../scans/scanService';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private cliChecked = false;
  private scanningContext?: boolean;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Checkmarx Local';
    this.item.command = 'checkmarxLocal.scanProject';
    this.item.text = '$(shield) Checkmarx';
    this.item.tooltip = 'Checkmarx: starting…';
    this.item.show();
  }

  setCliChecked(): void {
    this.cliChecked = true;
  }

  update(state: ScanUiState): void {
    const scanning = Boolean(state.active);
    if (this.scanningContext !== scanning) {
      this.scanningContext = scanning;
      void vscode.commands.executeCommand('setContext', 'checkmarxLocal.scanning', scanning);
    }

    const realtime = state.realtimeEnabled ? ' $(eye)' : '';

    if (state.active) {
      const progress = state.active.progress?.message;
      this.item.text = `$(sync~spin) Checkmarx: scanning${realtime}`;
      this.item.tooltip = new vscode.MarkdownString(
        `**Checkmarx scan running**\n\n${state.active.mode} / ${state.active.engine}\n\n${progress ?? 'Starting…'}\n\nClick to cancel.`
      );
      this.item.command = 'checkmarxLocal.cancelScan';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    if (!this.cliChecked) {
      this.item.text = `$(shield) Checkmarx${realtime}`;
      this.item.tooltip = 'Checkmarx: ready';
      this.item.command = 'checkmarxLocal.showResults';
      this.item.show();
      return;
    }

    if (!state.cliAvailable) {
      this.item.text = '$(warning) Checkmarx: CLI missing';
      this.item.tooltip = 'The Checkmarx CLI (cx) was not found. Click to install or configure it.';
      this.item.command = 'checkmarxLocal.installCli';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
      return;
    }

    if (!state.authenticated) {
      this.item.text = `$(account) Checkmarx: Sign in${realtime}`;
      this.item.tooltip = 'Sign in with a Checkmarx API key to run cloud scans. Local ASCA scans work without signing in.';
      this.item.command = 'checkmarxLocal.login';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    if (state.total > 0) {
      this.item.text = `$(shield) Checkmarx: ${state.total}${realtime}`;
      this.item.tooltip = new vscode.MarkdownString(
        `**Checkmarx findings:** ${state.total}\n\n${formatCounts(state.counts)}\n\nClick to show results.`
      );
      this.item.command = 'checkmarxLocal.showResults';
    } else {
      this.item.text = `$(shield) Checkmarx${realtime}`;
      this.item.tooltip = state.latest
        ? `Checkmarx: last scan ${state.latest.status}, no findings. Click to show results.`
        : 'Checkmarx: ready. Click to scan the project.';
      this.item.command = state.latest ? 'checkmarxLocal.showResults' : 'checkmarxLocal.scanProject';
    }
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}