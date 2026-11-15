import * as vscode from 'vscode';
import { renderDashboardHtml } from './dashboardHtml';
import type { DashboardActions, DashboardState, LoginInput } from './dashboardState';

export interface DashboardProviderOptions {
  getState: () => Promise<DashboardState>;
  actions: DashboardActions;
}

export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private state?: DashboardState;
  private ready = false;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly options: DashboardProviderOptions) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeView();
    this.view = webviewView;
    this.ready = false;

    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = renderDashboardHtml(webviewView.webview.cspSource, randomNonce());

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(
        (message: { type?: string; input?: unknown }) => {
          void this.handleMessage(message);
        },
        undefined
      ),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible && this.ready) {
          this.postState();
        }
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.ready = false;
        }
      })
    );

    void this.refresh();
  }

  update(state: DashboardState): void {
    this.state = state;
    this.applyBadge(state);
    this.postState();
  }

  async refresh(): Promise<void> {
    try {
      const state = await this.options.getState();
      this.update(state);
    } catch (error) {
      this.postToast(`Unable to refresh Checkmarx dashboard: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  dispose(): void {
    this.disposeView();
  }

  private disposeView(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.view = undefined;
    this.ready = false;
  }

  private applyBadge(state: DashboardState): void {
    if (!this.view) {
      return;
    }
    this.view.badge =
      state.total > 0
        ? {
            value: state.total,
            tooltip: `${state.total} Checkmarx finding${state.total === 1 ? '' : 's'}`
          }
        : undefined;
  }

  private postState(): void {
    if (!this.view || !this.ready || !this.view.visible || !this.state) {
      return;
    }
    void this.view.webview.postMessage({ type: 'state', state: this.state });
  }

  private postToast(message: string, kind: 'error' | 'success' | 'info' = 'info'): void {
    if (!this.view || !this.ready) {
      return;
    }
    void this.view.webview.postMessage({ type: 'toast', message, kind });
  }

  private async handleMessage(message: { type?: string; input?: unknown }): Promise<void> {
    if (!message.type) {
      return;
    }

    if (message.type === 'ready') {
      this.ready = true;
      if (this.state) {
        this.applyBadge(this.state);
        this.postState();
      } else {
        await this.refresh();
      }
      return;
    }

    try {
      switch (message.type) {
        case 'login': {
          const input = message.input as LoginInput;
          const result = await this.options.actions.login(input);
          await this.postMessage({ type: 'loginResult', ok: result.ok, error: result.error });
          if (result.ok) {
            await this.refresh();
          }
          return;
        }
        case 'logout':
          await this.options.actions.logout();
          this.postToast('Signed out of Checkmarx.', 'success');
          await this.refresh();
          return;
        case 'scanProjectCloud':
          await this.options.actions.scanProject('cloud');
          await this.refresh();
          return;
        case 'scanProjectLocal':
          await this.options.actions.scanProject('local');
          await this.refresh();
          return;
        case 'setApplication':
          await this.options.actions.setApplication();
          await this.refresh();
          return;
        case 'scanFileCloud':
          await this.options.actions.scanCurrentFile('cloud');
          await this.refresh();
          return;
        case 'scanFileLocal':
          await this.options.actions.scanCurrentFile('local');
          await this.refresh();
          return;
        case 'toggleRealtime':
          await this.options.actions.toggleRealtime();
          await this.refresh();
          return;
        case 'cancel':
          await this.options.actions.cancel();
          await this.refresh();
          return;
        case 'installCli':
          await this.options.actions.installCli();
          await this.refresh();
          return;
        case 'selectCli':
          await this.options.actions.selectCli();
          await this.refresh();
          return;
        case 'showResults':
          await this.options.actions.showResults();
          return;
        case 'clearResults':
          await this.options.actions.clearResults();
          await this.refresh();
          return;
        case 'restartMcp':
          await this.options.actions.restartMcp();
          await this.refresh();
          return;
        case 'openSettings':
          await this.options.actions.openSettings();
          return;
        case 'refresh':
          await this.refresh();
          return;
        default:
          this.postToast(`Unknown dashboard action: ${message.type}`, 'error');
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (message.type === 'login') {
        await this.postMessage({ type: 'loginResult', ok: false, error: text });
      } else {
        this.postToast(`Checkmarx: ${text}`, 'error');
      }
      await this.refresh();
    }
  }

  private async postMessage(message: unknown): Promise<void> {
    if (!this.view || !this.ready) {
      return;
    }
    await this.view.webview.postMessage(message);
  }
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}