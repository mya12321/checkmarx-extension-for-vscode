import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openPromptInChat } from './ai/chat';
import { buildFileFixPrompt, buildFindingFixPrompt, buildScanSummaryPrompt } from './ai/fixPrompt';
import { AuthStore } from './auth/authStore';
import { CxCli } from './cli/client';
import { CliProvider, CliNotFoundError } from './cli/locator';
import { installCli, UnsupportedPlatformError } from './cli/installer';
import { CliRunner } from './cli/runner';
import { CONFIG_SECTION, Settings, updateSetting } from './config';
import { Logger } from './logger';
import { ScanApiAdapter } from './mcp/scanApiAdapter';
import { McpBridge } from './mcp/bridge';
import { RealtimeController } from './scans/realtime';
import { ScanService } from './scans/scanService';
import { FileStateStore } from './scans/stateStore';
import { formatCounts } from './severity';
import type { AuthConfig, CliInfo, Finding, ScanEngine, ScanSummary } from './types';
import { DiagnosticsManager } from './ui/diagnostics';
import { DashboardProvider } from './ui/dashboard';
import type { DashboardState, LoginInput } from './ui/dashboardState';
import { DetailsPanel } from './ui/detailsPanel';
import { ResultsTreeProvider } from './ui/resultsTree';
import { ScansTreeProvider } from './ui/scansTree';
import { StatusBar } from './ui/statusBar';

const COMMANDS = [
  'checkmarxLocal.login',
  'checkmarxLocal.logout',
  'checkmarxLocal.scanProject',
  'checkmarxLocal.scanProjectCloud',
  'checkmarxLocal.scanProjectLocal',
  'checkmarxLocal.scanCurrentFile',
  'checkmarxLocal.scanCurrentFileCloud',
  'checkmarxLocal.scanCurrentFileLocal',
  'checkmarxLocal.scanFile',
  'checkmarxLocal.scanFileCloud',
  'checkmarxLocal.scanFileLocal',
  'checkmarxLocal.openDashboard',
  'checkmarxLocal.setApplication',
  'checkmarxLocal.toggleRealtime',
  'checkmarxLocal.cancelScan',
  'checkmarxLocal.clearResults',
  'checkmarxLocal.refreshResults',
  'checkmarxLocal.showResults',
  'checkmarxLocal.openFinding',
  'checkmarxLocal.openLocation',
  'checkmarxLocal.showFindingDetails',
  'checkmarxLocal.fixFindingWithAi',
  'checkmarxLocal.fixFileWithAi',
  'checkmarxLocal.copyFixPrompt',
  'checkmarxLocal.showScanSummary',
  'checkmarxLocal.exportResults',
  'checkmarxLocal.installCli',
  'checkmarxLocal.selectCli',
  'checkmarxLocal.showOutput',
  'checkmarxLocal.openSettings',
  'checkmarxLocal.checkHealth',
  'checkmarxLocal.showMcpInfo',
  'checkmarxLocal.restartMcp'
] as const;

let activeService: ScanService | undefined;
let activeBridge: McpBridge | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info(`Activating Checkmarx Local ${context.extension.packageJSON.version as string}`);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    logger.warn('No workspace folder is open; scan commands are disabled until a folder is opened.');
    for (const command of COMMANDS) {
      context.subscriptions.push(
        vscode.commands.registerCommand(command, () => {
          void vscode.window.showWarningMessage('Open a folder in VS Code before using Checkmarx Local.');
        })
      );
    }
    return;
  }

  const settings = new Settings();
  const auth = new AuthStore(context, settings);
  const cliProvider = new CliProvider(context, settings, logger);
  const runner = new CliRunner(logger, () => settings.load().showCliOutput);
  const storageRoot = context.globalStorageUri.fsPath;
  const stateStore = new FileStateStore(storageRoot, root);
  const diagnostics = new DiagnosticsManager();
  const statusBar = new StatusBar();

  let scanService: ScanService;
  let realtime: RealtimeController;
  let detailsPanel: DetailsPanel;
  let dashboard: DashboardProvider | undefined;
  let dashboardRefreshTimer: NodeJS.Timeout | undefined;
  let mcpBridge: McpBridge | undefined;
  const mcpChanged = new vscode.EventEmitter<void>();
  let mcpProvider: vscode.Disposable | undefined;
  let cloudUploadConfirmed = false;
  let mcpSettingEnabled = settings.load().mcpEnabled;

  const resultsProvider = new ResultsTreeProvider(
    () => scanService?.getFindings() ?? [],
    () => settings.load().groupBy,
    () => settings.load().minSeverity
  );
  const scansProvider = new ScansTreeProvider(() => scanService?.listScans(25) ?? []);

  const resultsView = vscode.window.createTreeView('checkmarxLocal.results', {
    treeDataProvider: resultsProvider,
    showCollapseAll: true
  });
  const scansView = vscode.window.createTreeView('checkmarxLocal.scans', {
    treeDataProvider: scansProvider,
    showCollapseAll: false
  });

  detailsPanel = new DetailsPanel(context.extensionUri, {
    openFinding: async (key) => openFinding(key),
    fixWithAi: async (key) => fixFindingWithAi(key),
    copyPrompt: async (key) => copyFixPrompt(key),
    rescanFile: async (file) => {
      if (!(await ensureCliInteractive())) {
        return;
      }
      if (settings.load().fileEngine === 'cloud') {
        if (!(await ensureCloudAuth())) {
          return;
        }
        if (!(await ensureApplicationName())) {
          return;
        }
        if (!(await confirmCloudUpload())) {
          return;
        }
      }
      await runScan(() => scanService.scanFile(file), 'File');
    }
  });

  scanService = new ScanService({
    root,
    settings,
    auth,
    cliProvider,
    runner,
    logger,
    stateStore,
    storageRoot,
    onStateChanged: (state) => {
      statusBar.update(state);
      refreshDashboard();
    },
    onFindingsChanged: (findings) => {
      const snapshot = settings.load();
      diagnostics.update(findings, snapshot.diagnosticsEnabled, snapshot.minSeverity);
      resultsProvider.refresh();
      refreshDashboard();
    },
    onHistoryChanged: () => {
      scansProvider.refresh();
      refreshDashboard();
    }
  });
  activeService = scanService;

  dashboard = new DashboardProvider({
    getState: buildDashboardState,
    actions: {
      login: (input) => loginWithCredentials(input),
      logout,
      scanProject: (engine) => scanProject(engine),
      setApplication: async () => {
        await setApplicationName();
      },
      scanCurrentFile: (engine) => scanCurrentFile(engine),
      toggleRealtime,
      cancel: cancelScan,
      installCli: async () => {
        await installCliInteractive();
      },
      selectCli: async () => {
        await selectCli();
      },
      showResults,
      clearResults,
      restartMcp,
      openSettings: async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
      }
    }
  });
  context.subscriptions.push(
    dashboard,
    vscode.window.registerWebviewViewProvider('checkmarxLocal.dashboard', dashboard, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  realtime = new RealtimeController(root, settings, scanService, logger, path.join(storageRoot, 'realtime'));

  context.subscriptions.push(
    logger,
    statusBar,
    diagnostics,
    resultsProvider,
    scansProvider,
    resultsView,
    scansView,
    detailsPanel,
    realtime,
    { dispose: () => void scanService.dispose() },
    mcpChanged,
    {
      dispose: () => {
        if (mcpProvider) {
          mcpProvider.dispose();
        }
        void stopMcpBridge();
      }
    }
  );

  await scanService.initialize();
  scanService.setAuthState(await auth.isSignedIn());
  scanService.setRealtimeEnabled(settings.load().realtimeEnabled);
  if (!settings.load().realtimeEnabled) {
    scanService.clearRealtimeResults();
  }
  realtime.refreshFromConfig();
  statusBar.update(scanService.getUiState());

  await checkCli(false);

  await startMcpBridge();

  mcpProvider = registerMcpProvider(() => mcpBridge);
  if (mcpProvider) {
    context.subscriptions.push(mcpProvider);
  }

  context.subscriptions.push(
    settings.onDidChange(() => {
      const snapshot = settings.load();
      scanService.setRealtimeEnabled(snapshot.realtimeEnabled);
      realtime.refreshFromConfig();
      if (!snapshot.realtimeEnabled) {
        scanService.clearRealtimeResults();
      }
      const findings = scanService.getFindings();
      diagnostics.update(findings, snapshot.diagnosticsEnabled, snapshot.minSeverity);
      resultsProvider.refresh();
      void vscode.commands.executeCommand('setContext', 'checkmarxLocal.realtimeEnabled', snapshot.realtimeEnabled);
      if (snapshot.mcpEnabled !== mcpSettingEnabled) {
        mcpSettingEnabled = snapshot.mcpEnabled;
        void handleMcpSettingChange(snapshot.mcpEnabled);
      }
      refreshDashboard();
    })
  );

  function refreshDashboard(): void {
    if (!dashboard) {
      return;
    }
    if (dashboardRefreshTimer) {
      clearTimeout(dashboardRefreshTimer);
    }
    dashboardRefreshTimer = setTimeout(() => {
      dashboardRefreshTimer = undefined;
      void dashboard?.refresh();
    }, 80);
    dashboardRefreshTimer.unref?.();
  }

  async function buildDashboardState(): Promise<DashboardState> {
    const ui = scanService.getUiState();
    const snapshot = settings.load();
    const authConfig = await auth.get();
    return {
      workspace: root!,
      projectName: snapshot.projectName || path.basename(root!),
      authenticated: Boolean(authConfig?.apiKey && authConfig.baseUri && authConfig.tenant),
      tenant: authConfig?.tenant ?? (snapshot.tenant || undefined),
      baseUri: authConfig?.baseUri ?? (snapshot.baseUri || undefined),
      applicationName: snapshot.applicationName || undefined,
      baseAuthUri: authConfig?.baseAuthUri ?? (snapshot.baseAuthUri || undefined),
      cliAvailable: ui.cliAvailable,
      cliPath: ui.cliPath,
      cliVersion: ui.cliVersion,
      realtimeEnabled: ui.realtimeEnabled,
      realtimeTrigger: snapshot.realtimeTrigger,
      activeFile: activeFile(),
      active: ui.active,
      latest: ui.latest,
      counts: ui.counts,
      total: ui.total,
      mcpRunning: Boolean(mcpBridge?.bridgeInfo),
      history: ui.history.slice(0, 3)
    };
  }

  async function loginWithCredentials(input: LoginInput): Promise<{ ok: boolean; error?: string }> {
    if (!input || typeof input.apiKey !== 'string' || typeof input.baseUri !== 'string' || typeof input.tenant !== 'string') {
      return { ok: false, error: 'Invalid sign-in request.' };
    }
    const baseUri = input.baseUri.trim().replace(/\/+$/, '');
    const baseAuthUri = (input.baseAuthUri ?? '').trim().replace(/\/+$/, '');
    const tenant = input.tenant.trim();
    const apiKey = input.apiKey.trim();
    if (!baseUri || !tenant || !apiKey) {
      return { ok: false, error: 'Base URI, tenant and API key are required.' };
    }
    try {
      const baseUrl = new URL(baseUri);
      if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
        return { ok: false, error: 'Base URI must use http or https.' };
      }
      if (baseAuthUri) {
        const authUrl = new URL(baseAuthUri);
        if (authUrl.protocol !== 'https:' && authUrl.protocol !== 'http:') {
          return { ok: false, error: 'IAM URI must use http or https.' };
        }
      }
    } catch {
      return { ok: false, error: 'Base URI or IAM URI is not a valid URL.' };
    }

    const cliInfo = await ensureCliInteractive();
    if (!cliInfo) {
      return { ok: false, error: 'The Checkmarx CLI is not available. Install it or select its path first.' };
    }

    const authConfig: AuthConfig = {
      apiKey,
      baseUri,
      baseAuthUri: baseAuthUri || undefined,
      tenant
    };

    try {
      await new CxCli(cliInfo.path, runner, logger, () => settings.load().cliExtraArgs).validateAuth(authConfig);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    try {
      await auth.save(authConfig);
    } catch (error) {
      return { ok: false, error: `Unable to save Checkmarx credentials: ${error instanceof Error ? error.message : String(error)}` };
    }

    scanService.setAuthState(true);
    cloudUploadConfirmed = false;
    refreshDashboard();
    logger.info(`Signed in to Checkmarx tenant "${tenant}" from the dashboard`);
    return { ok: true };
  }

  async function logout(): Promise<void> {
    await auth.logout();
    cloudUploadConfirmed = false;
    const stillSignedIn = await auth.isSignedIn();
    scanService.setAuthState(stillSignedIn);
    refreshDashboard();
    void vscode.window.showInformationMessage(
      stillSignedIn
        ? 'Stored Checkmarx API key removed. The CX_APIKEY environment variable is still being used.'
        : 'Signed out of Checkmarx. Local ASCA scans remain available.'
    );
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshDashboard())
  );

  async function handleMcpSettingChange(enabled: boolean): Promise<void> {
    if (enabled) {
      await startMcpBridge();
    } else {
      await stopMcpBridge();
    }
    mcpChanged.fire();
  }

  async function startMcpBridge(): Promise<void> {
    if (!settings.load().mcpEnabled) {
      return;
    }
    if (!mcpBridge) {
      try {
        mcpBridge = new McpBridge({
          api: new ScanApiAdapter(scanService, settings, () => confirmCloudUpload()),
          version: String(context.extension.packageJSON.version),
          workspace: root!,
          storageRoot,
          logger
        });
        await mcpBridge.start();
        activeBridge = mcpBridge;
        refreshDashboard();
      } catch (error) {
        logger.error(`Unable to start MCP bridge: ${error instanceof Error ? error.message : String(error)}`);
        mcpBridge = undefined;
        refreshDashboard();
      }
    }
  }

  async function stopMcpBridge(): Promise<void> {
    if (mcpBridge) {
      await mcpBridge.stop().catch(() => undefined);
      mcpBridge = undefined;
      activeBridge = undefined;
      refreshDashboard();
    }
  }

  function registerMcpProvider(getBridge: () => McpBridge | undefined): vscode.Disposable | undefined {
    const lm = vscode.lm as typeof vscode.lm & {
      registerMcpServerDefinitionProvider?: (
        id: string,
        provider: vscode.McpServerDefinitionProvider
      ) => vscode.Disposable;
    };
    if (!lm || typeof lm.registerMcpServerDefinitionProvider !== 'function') {
      logger.warn('This VS Code version does not support MCP server definition providers.');
      return undefined;
    }

    const mcpServerPath = path.join(context.extensionPath, 'dist', 'mcp-server.js');
    return lm.registerMcpServerDefinitionProvider('checkmarxLocal', {
      onDidChangeMcpServerDefinitions: mcpChanged.event,
      provideMcpServerDefinitions: async () => {
        const bridge = getBridge();
        const info = bridge?.bridgeInfo;
        if (!settings.load().mcpEnabled || !info || typeof vscode.McpStdioServerDefinition !== 'function') {
          return [];
        }
        return [
          new vscode.McpStdioServerDefinition(
            'Checkmarx Local Scan',
            process.execPath,
            [mcpServerPath],
            {
              ELECTRON_RUN_AS_NODE: '1',
              CHECKMARX_BRIDGE_URL: info.url,
              CHECKMARX_BRIDGE_TOKEN: info.token,
              CHECKMARX_BRIDGE_FILE: info.file,
              CHECKMARX_WORKSPACE: root!,
              CHECKMARX_EXTENSION_VERSION: String(context.extension.packageJSON.version)
            },
            String(context.extension.packageJSON.version)
          )
        ];
      }
    });
  }

  async function checkCli(interactive: boolean): Promise<CliInfo | undefined> {
    try {
      const info = await cliProvider.resolve();
      const version = await cliProvider.version(info);
      scanService.setCliState(info, version);
      statusBar.setCliChecked();
      statusBar.update(scanService.getUiState());
      refreshDashboard();
      return info;
    } catch (error) {
      scanService.setCliState(undefined);
      statusBar.setCliChecked();
      statusBar.update(scanService.getUiState());
      refreshDashboard();
      if (error instanceof CliNotFoundError) {
        logger.warn(error.message);
        if (interactive) {
          const installed = await promptInstallCli();
          if (installed) {
            return installed;
          }
        }
      } else {
        logger.error(`CLI check failed: ${error instanceof Error ? error.message : String(error)}`);
        if (interactive) {
          void vscode.window.showErrorMessage(`Checkmarx CLI check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return undefined;
    }
  }

  async function promptInstallCli(): Promise<CliInfo | undefined> {
    if (!settings.load().cliAutoInstall) {
      const choice = await vscode.window.showErrorMessage(
        'The Checkmarx CLI (cx) was not found. Install it manually, or enable "checkmarxLocal.cliAutoInstall" to download it from the extension.',
        'Select installed CLI',
        'Open Settings'
      );
      if (choice === 'Select installed CLI') {
        return await selectCli();
      }
      if (choice === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
      }
      return undefined;
    }

    const choice = await vscode.window.showWarningMessage(
      'The Checkmarx CLI (cx) was not found. Download the official CLI into extension storage?',
      { modal: true },
      'Download CLI',
      'Select installed CLI',
      'Cancel'
    );
    if (choice === 'Select installed CLI') {
      return await selectCli();
    }
    if (choice !== 'Download CLI') {
      return undefined;
    }
    return await installCliInteractive();
  }

  async function installCliInteractive(): Promise<CliInfo | undefined> {
    try {
      const signal = new AbortController();
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Checkmarx: installing CLI',
          cancellable: true
        },
        async (progress, token) => {
          token.onCancellationRequested(() => signal.abort());
          return await installCli({
            installRoot: path.join(storageRoot, 'cli'),
            signal: signal.signal,
            logger,
            onProgress: (update) => {
              progress.report({ message: update.message });
            }
          });
        }
      );
      await context.globalState.update('checkmarxLocal.managedCliPath', result.path);
      cliProvider.invalidate();
      const info: CliInfo = { path: result.path, version: result.version, source: 'managed' };
      scanService.setCliState(info, result.version);
      statusBar.setCliChecked();
      statusBar.update(scanService.getUiState());
      refreshDashboard();
      void vscode.window.showInformationMessage(`Checkmarx CLI ${result.version ?? ''} installed.`);
      return info;
    } catch (error) {
      if (error instanceof UnsupportedPlatformError) {
        void vscode.window.showErrorMessage(error.message);
      } else if (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message))) {
        void vscode.window.showInformationMessage('Checkmarx CLI installation cancelled.');
      } else {
        logger.error(`CLI installation failed: ${error instanceof Error ? error.message : String(error)}`);
        void vscode.window.showErrorMessage(`Checkmarx CLI installation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    }
  }

  async function selectCli(): Promise<CliInfo | undefined> {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Select the Checkmarx CLI (cx) binary or its folder',
      openLabel: 'Use CLI'
    });
    if (!selection || selection.length === 0) {
      return undefined;
    }
    let selected = selection[0]!.fsPath;
    try {
      const stat = await fs.stat(selected);
      if (stat.isDirectory()) {
        selected = path.join(selected, process.platform === 'win32' ? 'cx.exe' : 'cx');
      }
    } catch {
      // Let the locator report the problem.
    }
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('cliPath', selected, vscode.ConfigurationTarget.Global);
    cliProvider.invalidate();
    return await checkCli(false);
  }

  async function ensureCliInteractive(): Promise<CliInfo | undefined> {
    try {
      const info = await cliProvider.resolve();
      const version = await cliProvider.version(info);
      scanService.setCliState(info, version);
      return info;
    } catch (error) {
      if (error instanceof CliNotFoundError) {
        return await promptInstallCli();
      }
      throw error;
    }
  }

  async function setApplicationName(): Promise<boolean> {
    const current = settings.load().applicationName;
    const value = await vscode.window.showInputBox({
      title: 'Checkmarx One application',
      prompt:
        'Cloud scans must be associated with an existing Checkmarx One application. Enter its exact name (Checkmarx One > Applications).',
      value: current,
      placeHolder: 'My application',
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : 'Application name is required')
    });
    if (value === undefined) {
      return false;
    }
    const applicationName = value.trim();
    if (!applicationName) {
      return false;
    }
    await updateSetting('project.applicationName', applicationName);
    refreshDashboard();
    void vscode.window.showInformationMessage(`Checkmarx cloud scans will use application "${applicationName}".`);
    return true;
  }

  async function ensureApplicationName(): Promise<boolean> {
    if (settings.load().applicationName) {
      return true;
    }
    return await setApplicationName();
  }

  async function ensureCloudAuth(): Promise<boolean> {
    const existing = await auth.get();
    if (existing?.apiKey && existing.baseUri && existing.tenant) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      'Sign in to Checkmarx One with an API key to run cloud scans.',
      'Sign in',
      'Cancel'
    );
    if (choice !== 'Sign in') {
      return false;
    }
    return await login();
  }

  async function login(): Promise<boolean> {
    const cliInfo = await ensureCliInteractive();
    if (!cliInfo) {
      return false;
    }
    const cli = new CxCli(cliInfo.path, runner, logger, () => settings.load().cliExtraArgs);
    const ok = await auth.login((candidate) => cli.validateAuth(candidate));
    if (ok) {
      scanService.setAuthState(true);
      cloudUploadConfirmed = false;
      refreshDashboard();
    }
    return ok;
  }

  async function confirmCloudUpload(): Promise<boolean> {
    if (cloudUploadConfirmed) {
      return true;
    }
    const snapshot = settings.load();
    const choice = await vscode.window.showWarningMessage(
      `A cloud scan uploads workspace source code to Checkmarx One${snapshot.tenant ? ` (tenant ${snapshot.tenant})` : ''}. Continue?`,
      { modal: true },
      'Run cloud scan',
      'Cancel'
    );
    if (choice !== 'Run cloud scan') {
      return false;
    }
    cloudUploadConfirmed = true;
    return true;
  }

  async function runScan(action: () => Promise<ScanSummary>, label: string): Promise<void> {
    try {
      const summary = await action();
      if (summary.status === 'cancelled') {
        void vscode.window.showInformationMessage(`Checkmarx ${label.toLowerCase()} scan cancelled.`);
        return;
      }
      if (summary.status === 'failed') {
        void vscode.window.showErrorMessage(`Checkmarx ${label.toLowerCase()} scan failed: ${summary.error ?? 'unknown error'}`);
        return;
      }
      await reportScan(summary);
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Scan cancelled')) {
        void vscode.window.showInformationMessage('Checkmarx scan cancelled.');
        return;
      }
      logger.error(`${label} scan failed: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage(`Checkmarx ${label.toLowerCase()} scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function reportScan(summary: ScanSummary): Promise<void> {
    const counts = summary.totalFindings > 0 ? ` (${formatCounts(summary.counts)})` : '';
    const message = `Checkmarx ${summary.mode} scan finished: ${summary.totalFindings} finding${summary.totalFindings === 1 ? '' : 's'}${counts}.`;
    const actions = summary.totalFindings > 0 ? ['Show Results', 'Fix with AI'] : ['Show Scan'];
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (choice === 'Show Results') {
      await showResults();
    } else if (choice === 'Fix with AI') {
      await fixScanWithAi(summary.id);
    } else if (choice === 'Show Scan') {
      await showScanSummary(summary.id);
    }
  }

  async function scanProject(engine?: ScanEngine): Promise<void> {
    const snapshot = settings.load();
    const selectedEngine = engine ?? snapshot.projectEngine;
    if (selectedEngine === 'cloud') {
      if (!(await ensureCloudAuth())) {
        return;
      }
      if (!(await ensureApplicationName())) {
        return;
      }
      if (!(await confirmCloudUpload())) {
        return;
      }
    }
    if (!(await ensureCliInteractive())) {
      return;
    }
    await runScan(() => scanService.scanProject(selectedEngine), 'Project');
  }

  async function scanFile(file?: string, engine?: ScanEngine): Promise<void> {
    const target = file ?? activeFile();
    if (!target) {
      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(root!),
        title: 'Select a file to scan with Checkmarx',
        openLabel: 'Scan file'
      });
      if (!selection || selection.length === 0) {
        return;
      }
      await scanSpecificFile(selection[0]!.fsPath, engine);
      return;
    }
    await scanSpecificFile(target, engine);
  }

  async function scanSpecificFile(file: string, engine?: ScanEngine): Promise<void> {
    const absolute = toAbsolute(file);
    const selectedEngine = engine ?? settings.load().fileEngine;
    if (!(await ensureCliInteractive())) {
      return;
    }
    if (selectedEngine === 'cloud') {
      if (!(await ensureCloudAuth())) {
        return;
      }
      if (!(await ensureApplicationName())) {
        return;
      }
      if (!(await confirmCloudUpload())) {
        return;
      }
    }
    await runScan(() => scanService.scanFile(absolute, { engine: selectedEngine }), 'File');
    refreshDashboard();
  }

  async function scanCurrentFile(engine?: ScanEngine): Promise<void> {
    const file = activeFile();
    if (!file) {
      void vscode.window.showWarningMessage('Open a file in the editor before running a single-file scan.');
      return;
    }
    await scanSpecificFile(file, engine);
  }

  async function toggleRealtime(): Promise<void> {
    const next = !settings.load().realtimeEnabled;
    if (next && !(await ensureCliInteractive())) {
      return;
    }
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('realtime.enabled', next, vscode.ConfigurationTarget.Global);
    scanService.setRealtimeEnabled(next);
    realtime.refreshFromConfig();
    refreshDashboard();
    void vscode.window.showInformationMessage(`Checkmarx real-time scanning ${next ? 'enabled' : 'disabled'}.`);
  }

  async function cancelScan(): Promise<void> {
    const cancelled = await scanService.cancel();
    realtime.cancelAll();
    refreshDashboard();
    if (!cancelled) {
      void vscode.window.showInformationMessage('No Checkmarx scan is currently running.');
    }
  }

  async function clearResults(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Clear all Checkmarx results for this workspace? Scan history summaries are kept.',
      { modal: true },
      'Clear results'
    );
    if (choice !== 'Clear results') {
      return;
    }
    realtime.cancelAll();
    await scanService.clearResults();
    diagnostics.clear();
    realtime.clearHashes();
  }

  async function showResults(): Promise<void> {
    await vscode.commands.executeCommand('checkmarxLocal.results.focus');
  }

  async function openFinding(key: string): Promise<void> {
    const details = await scanService.getFinding(key, false);
    if (!details?.finding.file) {
      void vscode.window.showWarningMessage('This Checkmarx finding has no file location.');
      return;
    }
    await openLocation(details.finding.file, details.finding.line, details.finding.column);
  }

  async function openLocation(file: string, line?: number, column?: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(toAbsolute(file)));
    const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    const target = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
    editor.selection = new vscode.Selection(target, target);
    editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  async function resolveFinding(keyOrNode?: unknown): Promise<Finding | undefined> {
    const key = keyFromArg(keyOrNode);
    if (key) {
      const details = await scanService.getFinding(key, false);
      return details?.finding;
    }
    const file = activeFile();
    if (!file) {
      return undefined;
    }
    const findings = scanService.getFileFindings(file);
    if (findings.length === 0) {
      void vscode.window.showWarningMessage('No Checkmarx findings in the current file. Run a scan first.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      findings.map((finding) => ({
        label: `[${finding.severity}] ${finding.title}`,
        description: finding.line ? `line ${finding.line}` : undefined,
        finding
      })),
      { title: 'Select a Checkmarx finding', matchOnDescription: true }
    );
    return picked?.finding;
  }

  async function showFindingDetails(keyOrNode?: unknown): Promise<void> {
    const finding = await resolveFinding(keyOrNode);
    if (!finding) {
      return;
    }
    const details = await scanService.getFinding(finding.key, true);
    if (details) {
      await detailsPanel.showFinding(details);
    }
  }

  async function fixFindingWithAi(keyOrNode?: unknown): Promise<void> {
    const finding = await resolveFinding(keyOrNode);
    if (!finding) {
      return;
    }
    const details = await scanService.getFinding(finding.key, true);
    if (!details) {
      return;
    }
    const prompt = buildFindingFixPrompt(details, root);
    await openPromptInChat(prompt, settings.load().openChatAfterFixPrompt);
  }

  async function copyFixPrompt(keyOrNode?: unknown): Promise<void> {
    const finding = await resolveFinding(keyOrNode);
    if (!finding) {
      return;
    }
    const details = await scanService.getFinding(finding.key, true);
    if (!details) {
      return;
    }
    await vscode.env.clipboard.writeText(buildFindingFixPrompt(details, root));
    void vscode.window.showInformationMessage('Checkmarx AI fix prompt copied to the clipboard.');
  }

  async function fixFileWithAi(arg?: unknown): Promise<void> {
    const file = fileFromArg(arg) ?? activeFile();
    if (!file) {
      void vscode.window.showWarningMessage('Open a file or select a file with Checkmarx findings first.');
      return;
    }
    const findings = scanService.getFileFindings(toAbsolute(file));
    if (findings.length === 0) {
      void vscode.window.showInformationMessage('No Checkmarx findings in this file.');
      return;
    }
    await openPromptInChat(buildFileFixPrompt(file, findings), settings.load().openChatAfterFixPrompt);
  }

  async function fixScanWithAi(scanId?: string): Promise<void> {
    const summary = scanService.getScan(scanId ?? scanService.getUiState().latest?.id ?? '');
    const findings = scanService.getResults({ scanId: summary?.id }).findings;
    if (!summary || findings.length === 0) {
      void vscode.window.showInformationMessage('No findings to fix in this scan.');
      return;
    }
    await openPromptInChat(buildScanSummaryPrompt(summary, findings), settings.load().openChatAfterFixPrompt);
  }

  async function showScanSummary(scanIdOrNode?: unknown): Promise<void> {
    const scanId = scanIdFromArg(scanIdOrNode) ?? scanService.getUiState().latest?.id;
    if (!scanId) {
      void vscode.window.showInformationMessage('No Checkmarx scans have been run in this workspace yet.');
      return;
    }
    const summary = scanService.getScan(scanId);
    if (!summary) {
      void vscode.window.showWarningMessage(`Scan ${scanId} is not available.`);
      return;
    }
    await detailsPanel.showScan(summary);
  }

  async function exportResults(): Promise<void> {
    const findings = scanService.getFindings();
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'JSON', description: 'Structured findings and scan metadata', format: 'json' as const },
        { label: 'Markdown', description: 'Human-readable report', format: 'md' as const },
        { label: 'CSV', description: 'Spreadsheet-friendly rows', format: 'csv' as const }
      ],
      { title: 'Export Checkmarx results' }
    );
    if (!choice) {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(root!, `checkmarx-results.${choice.format}`)),
      filters:
        choice.format === 'json'
          ? { JSON: ['json'] }
          : choice.format === 'md'
            ? { Markdown: ['md'] }
            : { CSV: ['csv'] },
      title: 'Export Checkmarx results'
    });
    if (!target) {
      return;
    }

    const latest = scanService.getUiState().latest;
    let content: string;
    if (choice.format === 'json') {
      content = JSON.stringify({ scan: latest, findings }, null, 2);
    } else if (choice.format === 'md') {
      content = toMarkdown(latest, findings);
    } else {
      content = toCsv(findings);
    }
    await fs.writeFile(target.fsPath, content, 'utf8');
    void vscode.window.showInformationMessage(`Checkmarx results exported to ${target.fsPath}.`);
  }

  async function checkHealth(): Promise<void> {
    const snapshot = settings.load();
    const lines: string[] = [`Checkmarx Local ${context.extension.packageJSON.version as string}`];
    lines.push(`Workspace: ${root}`);
    try {
      const info = await cliProvider.resolve();
      const version = await cliProvider.version(info);
      lines.push(`CLI: ${info.path} (${version ?? 'unknown version'}, ${info.source})`);
      const authConfig = await auth.get();
      if (authConfig) {
        lines.push(`Auth: signed in (tenant ${authConfig.tenant ?? 'unknown'})`);
        const cli = new CxCli(info.path, runner, logger, () => snapshot.cliExtraArgs);
        try {
          await cli.validateAuth(authConfig);
          lines.push('Auth validation: OK');
        } catch (error) {
          lines.push(`Auth validation: FAILED (${error instanceof Error ? error.message : String(error)})`);
        }
      } else {
        lines.push('Auth: not signed in');
      }
    } catch (error) {
      lines.push(`CLI: not available (${error instanceof Error ? error.message : String(error)})`);
    }
    lines.push(`MCP: ${mcpBridge?.bridgeInfo ? `${mcpBridge.bridgeInfo.url} (enabled)` : 'not running'}`);
    lines.push(`Real-time: ${snapshot.realtimeEnabled ? `enabled (${snapshot.realtimeTrigger})` : 'disabled'}`);
    lines.push(`Findings: ${scanService.getUiState().total}`);

    for (const line of lines) {
      logger.info(line);
    }
    logger.show(false);
    const choice = await vscode.window.showInformationMessage('Checkmarx diagnostics written to the output channel.', 'Show Output');
    if (choice === 'Show Output') {
      logger.show(false);
    }
  }

  function showMcpInfo(): void {
    const info = mcpBridge?.bridgeInfo;
    if (!info) {
      void vscode.window.showInformationMessage(
        'The Checkmarx MCP server is not running. Enable "checkmarxLocal.mcp.enabled" and restart VS Code or run "Checkmarx: Restart MCP Server".'
      );
      return;
    }
    const config = {
      mcpServers: {
        checkmarx: {
          command: process.execPath,
          args: [path.join(context.extensionPath, 'dist', 'mcp-server.js')],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            CHECKMARX_BRIDGE_URL: info.url,
            CHECKMARX_BRIDGE_TOKEN: info.token,
            CHECKMARX_BRIDGE_FILE: info.file,
            CHECKMARX_WORKSPACE: root,
            CHECKMARX_EXTENSION_VERSION: String(context.extension.packageJSON.version)
          }
        }
      }
    };
    void vscode.window
      .showInformationMessage(
        'Checkmarx MCP is registered with VS Code automatically. Open Copilot Chat and enable the Checkmarx tools, or copy the configuration for another MCP client.',
        'Copy MCP configuration',
        'Open MCP documentation'
      )
      .then(async (choice) => {
        if (choice === 'Copy MCP configuration') {
          await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
          void vscode.window.showWarningMessage('MCP configuration copied. It contains a local bridge token; do not share it.');
        } else if (choice === 'Open MCP documentation') {
          await vscode.env.openExternal(vscode.Uri.parse('https://code.visualstudio.com/docs/agent-customization/mcp-servers'));
        }
      });
  }

  async function restartMcp(): Promise<void> {
    await stopMcpBridge();
    await startMcpBridge();
    mcpChanged.fire();
    void vscode.window.showInformationMessage(
      mcpBridge?.bridgeInfo ? 'Checkmarx MCP server restarted.' : 'Checkmarx MCP server is disabled or failed to start.'
    );
  }

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          logger.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
          void vscode.window.showErrorMessage(`Checkmarx: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    );
  };

  register('checkmarxLocal.login', () => login());
  register('checkmarxLocal.logout', () => logout());
  register('checkmarxLocal.scanProject', () => scanProject());
  register('checkmarxLocal.scanProjectCloud', () => scanProject('cloud'));
  register('checkmarxLocal.scanProjectLocal', () => scanProject('local'));
  register('checkmarxLocal.scanCurrentFile', () => scanCurrentFile());
  register('checkmarxLocal.scanCurrentFileCloud', () => scanCurrentFile('cloud'));
  register('checkmarxLocal.scanCurrentFileLocal', () => scanCurrentFile('local'));
  register('checkmarxLocal.scanFile', (arg) => scanFile(fileFromArg(arg) ?? undefined));
  register('checkmarxLocal.scanFileCloud', (arg) => scanFile(fileFromArg(arg) ?? undefined, 'cloud'));
  register('checkmarxLocal.scanFileLocal', (arg) => scanFile(fileFromArg(arg) ?? undefined, 'local'));
  register('checkmarxLocal.openDashboard', () => vscode.commands.executeCommand('checkmarxLocal.dashboard.focus'));
  register('checkmarxLocal.setApplication', () => setApplicationName());
  register('checkmarxLocal.toggleRealtime', () => toggleRealtime());
  register('checkmarxLocal.cancelScan', () => cancelScan());
  register('checkmarxLocal.clearResults', () => clearResults());
  register('checkmarxLocal.refreshResults', () => {
    const snapshot = settings.load();
    diagnostics.update(scanService.getFindings(), snapshot.diagnosticsEnabled, snapshot.minSeverity);
    resultsProvider.refresh();
    scansProvider.refresh();
  });
  register('checkmarxLocal.showResults', () => showResults());
  register('checkmarxLocal.openFinding', (arg) => {
    const key = keyFromArg(arg);
    if (!key) {
      return resolveFinding(arg).then((finding) => (finding ? openFinding(finding.key) : undefined));
    }
    return openFinding(key);
  });
  register('checkmarxLocal.openLocation', (file, line, column) =>
    typeof file === 'string' ? openLocation(file, typeof line === 'number' ? line : undefined, typeof column === 'number' ? column : undefined) : undefined
  );
  register('checkmarxLocal.showFindingDetails', (arg) => showFindingDetails(arg));
  register('checkmarxLocal.fixFindingWithAi', (arg) => fixFindingWithAi(arg));
  register('checkmarxLocal.fixFileWithAi', (arg) => fixFileWithAi(arg));
  register('checkmarxLocal.copyFixPrompt', (arg) => copyFixPrompt(arg));
  register('checkmarxLocal.showScanSummary', (arg) => showScanSummary(arg));
  register('checkmarxLocal.exportResults', () => exportResults());
  register('checkmarxLocal.installCli', () => installCliInteractive());
  register('checkmarxLocal.selectCli', () => selectCli());
  register('checkmarxLocal.showOutput', () => logger.show(false));
  register('checkmarxLocal.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION));
  register('checkmarxLocal.checkHealth', () => checkHealth());
  register('checkmarxLocal.showMcpInfo', () => showMcpInfo());
  register('checkmarxLocal.restartMcp', () => restartMcp());

  function toAbsolute(file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(root!, file);
  }

  function activeFile(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    return editor.document.uri.fsPath;
  }
}

export async function deactivate(): Promise<void> {
  await activeBridge?.stop().catch(() => undefined);
  await activeService?.dispose().catch(() => undefined);
  activeBridge = undefined;
  activeService = undefined;
}

function keyFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string' && !arg.includes(path.sep) && !arg.startsWith('file:')) {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const node = arg as { kind?: string; finding?: Finding; key?: string };
    if (node.kind === 'finding' && node.finding) {
      return node.finding.key;
    }
    if (node.finding) {
      return node.finding.key;
    }
    if (typeof node.key === 'string') {
      return node.key;
    }
  }
  return undefined;
}

function fileFromArg(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri && arg.scheme === 'file') {
    return arg.fsPath;
  }
  if (typeof arg === 'string' && (path.isAbsolute(arg) || arg.includes(path.sep))) {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const node = arg as { kind?: string; groupKind?: string; finding?: Finding; label?: string; file?: string };
    if (node.finding?.file) {
      return node.finding.file;
    }
    if (typeof node.file === 'string') {
      return node.file;
    }
    if (node.kind === 'group' && node.groupKind === 'file' && typeof node.label === 'string') {
      return node.label;
    }
  }
  return undefined;
}

function scanIdFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg && typeof arg === 'object' && typeof (arg as { id?: string }).id === 'string') {
    return (arg as { id: string }).id;
  }
  return undefined;
}

function toMarkdown(scan: ScanSummary | undefined, findings: Finding[]): string {
  const lines = ['# Checkmarx results', ''];
  if (scan) {
    lines.push(
      `- Scan: \`${scan.id}\` (${scan.mode}/${scan.engine})`,
      `- Status: ${scan.status}`,
      `- Findings: ${scan.totalFindings}${scan.totalFindings > 0 ? ` (${formatCounts(scan.counts)})` : ''}`,
      ''
    );
  }
  lines.push('| Severity | Type | Finding | File | Line |', '| --- | --- | --- | --- | --- |');
  for (const finding of findings) {
    lines.push(
      `| ${finding.severity} | ${finding.type} | ${escapeMarkdown(finding.title)} | ${escapeMarkdown(finding.relativeFile ?? finding.file ?? '')} | ${finding.line ?? ''} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

function toCsv(findings: Finding[]): string {
  const header = ['severity', 'type', 'title', 'file', 'line', 'column', 'cwe', 'cve', 'package', 'engine', 'mode', 'key'];
  const rows = findings.map((finding) => [
    finding.severity,
    finding.type,
    finding.title,
    finding.relativeFile ?? finding.file ?? '',
    finding.line ?? '',
    finding.column ?? '',
    finding.cweId ?? '',
    finding.cveId ?? '',
    finding.packageName ? `${finding.packageName}${finding.packageVersion ? `@${finding.packageVersion}` : ''}` : '',
    finding.engine,
    finding.mode,
    finding.key
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}