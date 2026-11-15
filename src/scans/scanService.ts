import * as path from 'node:path';
import type { AuthStoreLike } from '../auth/authStore';
import type { SettingsLike } from '../config';
import type { SettingsSnapshot } from '../config';
import type { LoggerLike } from '../logging';
import { relativeToRoot } from '../paths';
import type {
  CliInfo,
  Finding,
  PersistedState,
  ResultsQuery,
  ResultsResponse,
  ScanEngine,
  ScanProgress,
  ScanState,
  ScanSummary,
  Severity,
  FileSummary,
  FindingDetails,
  ScanRecord
} from '../types';
import { countBySeverity, emptyCounts } from '../severity';
import { createEmptySources, filterFindings, mergeSources, type ResultSources } from '../findings/merge';
import { buildPersistedState, deserializeSources } from '../findings/persist';
import { getCodeContext } from '../findings/enrich';
import { collectProjectFiles, detectGitBranch } from './projectFiles';
import { runCloudScan, isAbortError } from './cloudScanner';
import { LocalScanner } from './localScanner';
import type { StateStoreLike } from './stateStore';
import type { CliRunner } from '../cli/runner';
import { CxCli } from '../cli/client';

export interface ScanUiState {
  active?: ScanSummary;
  latest?: ScanSummary;
  authenticated: boolean;
  cliAvailable: boolean;
  cliPath?: string;
  cliVersion?: string;
  realtimeEnabled: boolean;
  counts: ReturnType<typeof emptyCounts>;
  total: number;
  history: ScanSummary[];
}

export interface CliProviderLike {
  resolve(force?: boolean): Promise<CliInfo>;
  version(info?: CliInfo): Promise<string | undefined>;
  invalidate(): void;
}

export interface ScanServiceDeps {
  root: string;
  settings: SettingsLike;
  auth: AuthStoreLike;
  cliProvider: CliProviderLike;
  runner: CliRunner;
  logger: LoggerLike;
  stateStore: StateStoreLike;
  storageRoot: string;
  onStateChanged: (state: ScanUiState) => void;
  onFindingsChanged: (findings: Finding[]) => void;
  onHistoryChanged: (history: ScanSummary[]) => void;
  now?: () => Date;
}

export class ScanService {
  private sources: ResultSources = createEmptySources();
  private history: ScanSummary[] = [];
  private latest?: ScanSummary;
  private active?: ScanSummary;
  private activeController?: AbortController;
  private activeCloudScanId?: string;
  private mergedCache?: Finding[];
  private mergedCounts = emptyCounts();
  private records = new Map<string, ScanRecord>();
  private authenticated = false;
  private cliInfo?: CliInfo;
  private cliVersion?: string;
  private realtimeEnabled = false;
  private saveTimer?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: ScanServiceDeps) {}

  get root(): string {
    return this.deps.root;
  }

  async initialize(): Promise<void> {
    const state = await this.deps.stateStore.load();
    if (state) {
      this.sources = deserializeSources(state.sources);
      this.history = Array.isArray(state.history) ? state.history.slice(0, 25) : [];
      this.latest = state.latest;
      this.deps.logger.info(`Loaded ${this.getMerged().length} persisted Checkmarx findings`);
    }
    this.realtimeEnabled = this.deps.settings.load().realtimeEnabled;
    this.emitEverything();
  }

  setAuthState(authenticated: boolean): void {
    if (this.authenticated === authenticated) {
      return;
    }
    this.authenticated = authenticated;
    this.emitState();
  }

  setCliState(info: CliInfo | undefined, version?: string): void {
    this.cliInfo = info;
    this.cliVersion = version ?? info?.version;
    this.emitState();
  }

  setRealtimeEnabled(enabled: boolean): void {
    if (this.realtimeEnabled === enabled) {
      return;
    }
    this.realtimeEnabled = enabled;
    this.emitState();
  }

  getState(): Promise<ScanState> {
    const merged = this.getMerged();
    return Promise.resolve({
      active: this.active,
      latest: this.latest,
      authenticated: this.authenticated,
      cliAvailable: Boolean(this.cliInfo),
      cliPath: this.cliInfo?.path,
      cliVersion: this.cliVersion,
      realtimeEnabled: this.realtimeEnabled,
      findings: merged,
      counts: this.mergedCounts,
      total: merged.length,
      history: [...this.history]
    });
  }

  getUiState(): ScanUiState {
    const merged = this.getMerged();
    return {
      active: this.active,
      latest: this.latest,
      authenticated: this.authenticated,
      cliAvailable: Boolean(this.cliInfo),
      cliPath: this.cliInfo?.path,
      cliVersion: this.cliVersion,
      realtimeEnabled: this.realtimeEnabled,
      counts: this.mergedCounts,
      total: merged.length,
      history: [...this.history]
    };
  }

  getFindings(): Finding[] {
    return this.getMerged();
  }

  isCliAvailable(): boolean {
    return Boolean(this.cliInfo);
  }

  async scanProject(engine?: ScanEngine, scanTypes?: string[]): Promise<ScanSummary> {
    const settings = this.deps.settings.load();
    const selectedEngine = engine ?? settings.projectEngine;
    if (this.active) {
      throw new Error('A scan is already running. Cancel it before starting another one.');
    }

    const projectName = settings.projectName || path.basename(this.deps.root);
    const types = scanTypes?.length ? scanTypes : settings.scanTypes;
    const summary = this.createSummary('project', selectedEngine, types, {
      projectName
    });

    this.active = summary;
    this.activeController = new AbortController();
    this.emitState();

    try {
      const branch = settings.branch || (await detectGitBranch(this.deps.root)) || 'main';
      summary.branch = branch;
      if (this.activeController?.signal.aborted) {
        throw new Error('Scan cancelled');
      }
      if (selectedEngine === 'cloud') {
        summary.status = 'running';
        await this.runCloudProject(summary, settings, projectName, branch, types);
      } else {
        await this.runLocalProject(summary, settings);
      }
      this.completeSummary(summary);
      this.finishSuccessfulScan(summary, () => {
        const nextSources = createEmptySources();
        nextSources.project = { scanId: summary.id, findings: summary.findingsBuffer ?? [] };
        this.sources = nextSources;
      });
      return summary;
    } catch (error) {
      return this.failScan(summary, error);
    } finally {
      this.clearActive(summary.id);
    }
  }

  async scanFile(
    file: string,
    options: {
      mode?: 'file' | 'realtime';
      engine?: ScanEngine;
      scannedFile?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ): Promise<ScanSummary> {
    const mode = options.mode ?? 'file';
    const settings = this.deps.settings.load();
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.deps.root, file);
    if (!isInside(this.deps.root, absolute)) {
      throw new Error(`Refusing to scan a file outside the workspace: ${file}`);
    }

    if (mode === 'file' && this.active) {
      throw new Error('A scan is already running. Cancel it before starting another one.');
    }

    const engine: ScanEngine = mode === 'realtime' ? 'local' : options.engine ?? settings.fileEngine;
    const summary = this.createSummary(mode, engine, engine === 'cloud' ? settings.scanTypes : ['sast'], {
      file: absolute,
      relativeFile: relativeToRoot(this.deps.root, absolute)
    });
    summary.status = 'running';

    const controller = options.signal ? undefined : new AbortController();
    const signal = options.signal ?? controller!.signal;

    if (mode === 'file') {
      this.active = summary;
      this.activeController = controller;
      this.emitState();
    }

    try {
      const scannedFile = options.scannedFile ?? absolute;
      let findings: Finding[];
      if (engine === 'cloud') {
        findings = await this.runCloudFile(summary, settings, absolute, signal);
      } else {
        try {
          findings = await this.runLocalFile(summary.id, absolute, scannedFile, mode, signal, options.timeoutMs);
        } catch (error) {
          if (mode === 'file' && !isAbortError(error) && settings.fileFallbackToCloud) {
            this.deps.logger.warn(
              `Local scan failed for ${absolute}; falling back to a filtered cloud scan: ${error instanceof Error ? error.message : String(error)}`
            );
            findings = await this.runCloudFile(summary, settings, absolute, signal);
            summary.engine = 'cloud';
          } else {
            throw error;
          }
        }
      }

      if (mode === 'realtime' && !this.realtimeEnabled) {
        summary.status = 'cancelled';
        summary.error = 'Real-time scanning was disabled';
        summary.finishedAt = this.nowIso();
        summary.findingsBuffer = undefined;
        return summary;
      }

      summary.findingsBuffer = findings;
      this.completeSummary(summary);
      this.applyFileResult(summary, absolute, findings, mode);
      summary.findingsBuffer = undefined;
      if (mode === 'file') {
        this.latest = summary;
        this.recordHistory(summary);
        this.records.set(summary.id, { summary, findings });
      }
      this.emitFindingsAndState();
      this.scheduleSave();
      return summary;
    } catch (error) {
      return this.failScan(summary, error, mode === 'realtime');
    } finally {
      if (mode === 'file') {
        this.clearActive(summary.id);
      }
    }
  }

  async cancel(scanId?: string): Promise<boolean> {
    if (!this.active || (scanId && this.active.id !== scanId)) {
      return false;
    }
    const auth = await this.deps.auth.get();
    if (this.activeCloudScanId && auth) {
      await this.cli()
        .then((cli) => cli.cancelCloudScan(this.activeCloudScanId!, auth))
        .catch(() => undefined);
    }
    this.activeController?.abort();
    return true;
  }

  clearRealtimeResults(): boolean {
    if (this.sources.realtime.size === 0) {
      return false;
    }
    this.sources.realtime.clear();
    this.invalidateMerged();
    this.emitFindingsAndState();
    this.scheduleSave();
    return true;
  }

  async clearResults(): Promise<void> {
    this.sources = createEmptySources();
    this.latest = undefined;
    this.records.clear();
    this.invalidateMerged();
    this.emitFindingsAndState();
    this.scheduleSave();
  }

  getResults(query: ResultsQuery = {}): ResultsResponse {
    const source = query.scanId ? this.records.get(query.scanId)?.findings : undefined;
    const base = source ?? this.getMerged();
    const filtered = filterFindings(base, { query: { ...query, scanId: query.scanId && !source ? query.scanId : undefined } });
    const counts = countBySeverity(filtered);
    const limited = query.limit !== undefined ? filtered.slice(0, query.limit) : filtered;
    return {
      scan: query.scanId ? this.records.get(query.scanId)?.summary : undefined,
      findings: limited,
      total: filtered.length,
      counts
    };
  }

  async getFinding(key: string, includeCode = true): Promise<FindingDetails | undefined> {
    const candidates = [
      ...this.getMerged(),
      ...[...this.records.values()].flatMap((record) => record.findings)
    ];
    const finding = candidates.find((item) => item.key === key || item.id === key);
    if (!finding) {
      return undefined;
    }
    if (!includeCode || !finding.file) {
      return { finding, fileExists: Boolean(finding.file) };
    }
    const context = await getCodeContext(finding.file, finding.line);
    return {
      finding,
      codeContext: context?.text,
      codeStartLine: context?.startLine,
      codeEndLine: context?.endLine,
      fileExists: Boolean(context)
    };
  }

  getFileFindings(file: string): Finding[] {
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.deps.root, file);
    return this.getMerged().filter((finding) => finding.file && path.resolve(finding.file) === absolute);
  }

  getFiles(): FileSummary[] {
    const grouped = new Map<string, Finding[]>();
    for (const finding of this.getMerged()) {
      if (!finding.file) {
        continue;
      }
      const list = grouped.get(finding.file) ?? [];
      list.push(finding);
      grouped.set(finding.file, list);
    }

    return [...grouped.entries()]
      .map(([file, findings]) => {
        const counts = countBySeverity(findings);
        return {
          file,
          relativeFile: relativeToRoot(this.deps.root, file) ?? file,
          findings: findings.length,
          counts,
          highestSeverity: highestOf(counts)
        };
      })
      .sort((a, b) => a.relativeFile.localeCompare(b.relativeFile));
  }

  listScans(limit = 20): ScanSummary[] {
    return this.history.slice(0, Math.max(0, limit));
  }

  getScan(scanId: string): ScanSummary | undefined {
    return this.history.find((scan) => scan.id === scanId) ?? (this.latest?.id === scanId ? this.latest : undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeController?.abort();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.saveNow().catch(() => undefined);
  }

  private requireApplicationName(settings: SettingsSnapshot): string {
    const applicationName = settings.applicationName.trim();
    if (!applicationName) {
      throw new Error(
        'Cloud scans require a Checkmarx One application name. Set "checkmarxLocal.project.applicationName" or use Checkmarx: Open Dashboard > Set application.'
      );
    }
    return applicationName;
  }

  private async runCloudProject(
    summary: ScanSummary,
    settings: SettingsSnapshot,
    projectName: string,
    branch: string,
    scanTypes: string[]
  ): Promise<void> {
    const applicationName = this.requireApplicationName(settings);
    const auth = await this.requireAuth();
    const cli = await this.cli();
    const result = await runCloudScan(cli, {
      root: this.deps.root,
      projectName,
      applicationName,
      branch,
      scanTypes,
      auth,
      signal: this.activeController!.signal,
      timeoutMs: settings.timeoutMinutes * 60 * 1000,
      pollIntervalMs: settings.pollIntervalSeconds * 1000,
      mode: 'project',
      scanId: summary.id,
      outputDirectory: path.join(this.deps.storageRoot, 'cloud', summary.id),
      logger: this.deps.logger,
      onProgress: (progress) => this.updateProgress(summary, progress),
      onCloudScanCreated: (cloudScanId) => {
        summary.cloudScanId = cloudScanId;
        this.activeCloudScanId = cloudScanId;
      }
    });
    summary.findingsBuffer = result.findings;
    summary.cloudScanId = result.cloudScanId;
  }

  private async runLocalProject(summary: ScanSummary, settings: SettingsSnapshot): Promise<void> {
    const cli = await this.cli();
    const projectFiles = await collectProjectFiles(this.deps.root, settings);
    if (projectFiles.files.length === 0) {
      throw new Error(
        `No scannable source files were found in ${this.deps.root}. Check "checkmarxLocal.realtime.extensions" and "checkmarxLocal.scan.exclude".`
      );
    }
    if (projectFiles.truncated) {
      this.deps.logger.warn(
        `Local project scan is limited to ${settings.localMaxFiles} files. Increase "checkmarxLocal.scan.localMaxFiles" to scan everything.`
      );
    }

    const scanner = new LocalScanner(cli, this.deps.logger);
    const result = await scanner.scanProject(projectFiles.files, {
      root: this.deps.root,
      scanId: summary.id,
      mode: 'project',
      signal: this.activeController!.signal,
      concurrency: settings.localConcurrency,
      onProgress: (progress) => this.updateProgress(summary, progress)
    });
    summary.findingsBuffer = result.findings;
    if (result.errors.length > 0) {
      this.deps.logger.warn(`Local project scan completed with ${result.errors.length} file errors`);
    }
  }

  private async runLocalFile(
    scanId: string,
    file: string,
    scannedFile: string,
    mode: 'file' | 'realtime',
    signal: AbortSignal,
    timeoutMs?: number
  ): Promise<Finding[]> {
    const cli = await this.cli();
    const scanner = new LocalScanner(cli, this.deps.logger);
    return await scanner.scanFile(scannedFile, {
      root: this.deps.root,
      scanId,
      mode,
      reportedFile: file,
      signal,
      timeoutMs
    });
  }

  private async runCloudFile(
    summary: ScanSummary,
    settings: SettingsSnapshot,
    file: string,
    signal: AbortSignal
  ): Promise<Finding[]> {
    const applicationName = this.requireApplicationName(settings);
    const auth = await this.requireAuth();
    const cli = await this.cli();
    const relative = relativeToRoot(this.deps.root, file);
    if (!relative) {
      throw new Error(`Unable to make ${file} relative to the workspace`);
    }
    const result = await runCloudScan(cli, {
      root: this.deps.root,
      projectName: settings.projectName || path.basename(this.deps.root),
      applicationName,
      branch: settings.branch || (await detectGitBranch(this.deps.root)) || 'main',
      scanTypes: settings.scanTypes,
      fileFilter: relative,
      auth,
      signal,
      timeoutMs: settings.timeoutMinutes * 60 * 1000,
      pollIntervalMs: settings.pollIntervalSeconds * 1000,
      mode: 'file',
      scanId: summary.id,
      outputDirectory: path.join(this.deps.storageRoot, 'cloud', summary.id),
      logger: this.deps.logger,
      onProgress: (progress) => this.updateProgress(summary, progress),
      onCloudScanCreated: (cloudScanId) => {
        summary.cloudScanId = cloudScanId;
        this.activeCloudScanId = cloudScanId;
      }
    });
    summary.cloudScanId = result.cloudScanId;
    return result.findings;
  }

  private applyFileResult(summary: ScanSummary, file: string, findings: Finding[], mode: 'file' | 'realtime'): void {
    const entry = { scanId: summary.id, findings };
    if (mode === 'realtime') {
      this.sources.realtime.set(file, entry);
    } else {
      this.sources.files.set(file, entry);
    }
    this.invalidateMerged();
  }

  private finishSuccessfulScan(summary: ScanSummary, apply: () => void): void {
    const findings = summary.findingsBuffer ?? [];
    summary.counts = countBySeverity(findings);
    summary.totalFindings = findings.length;
    summary.finishedAt = this.nowIso();
    summary.progress = undefined;
    apply();
    summary.findingsBuffer = undefined;
    this.latest = summary;
    this.records.set(summary.id, { summary, findings });
    if (this.records.size > 15) {
      const oldest = [...this.records.keys()].slice(0, this.records.size - 15);
      for (const key of oldest) {
        this.records.delete(key);
      }
    }
    this.recordHistory(summary);
    this.invalidateMerged();
    this.emitFindingsAndState();
    this.emitHistory();
    this.scheduleSave();
  }

  private failScan(summary: ScanSummary, error: unknown, silent = false): ScanSummary {
    const aborted = isAbortError(error) || this.activeController?.signal.aborted;
    summary.status = aborted ? 'cancelled' : 'failed';
    summary.error = aborted ? 'Scan cancelled' : error instanceof Error ? redactError(error.message) : String(error);
    summary.finishedAt = this.nowIso();
    summary.progress = undefined;
    summary.counts = countBySeverity(summary.findingsBuffer ?? []);
    summary.totalFindings = (summary.findingsBuffer ?? []).length;
    summary.findingsBuffer = undefined;
    if (!aborted) {
      this.deps.logger.error(`${summary.mode} scan failed: ${summary.error}`);
    }
    if (!silent) {
      this.recordHistory(summary);
      this.emitHistory();
      this.scheduleSave();
    }
    this.emitState();
    if (silent) {
      this.deps.logger.debug(`Real-time scan failed: ${summary.error}`);
    }
    return summary;
  }

  private recordHistory(summary: ScanSummary): void {
    this.history = [summary, ...this.history.filter((item) => item.id !== summary.id)].slice(0, 25);
  }

  private completeSummary(summary: ScanSummary): void {
    const findings = summary.findingsBuffer ?? [];
    summary.counts = countBySeverity(findings);
    summary.totalFindings = findings.length;
    summary.finishedAt = this.nowIso();
    summary.status = 'completed';
    summary.progress = undefined;
  }

  private createSummary(
    mode: ScanSummary['mode'],
    engine: ScanEngine,
    scanTypes: string[],
    extra: Partial<ScanSummary>
  ): ScanSummary {
    return {
      id: `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      mode,
      engine,
      status: 'queued',
      startedAt: this.nowIso(),
      scanTypes,
      root: this.deps.root,
      counts: emptyCounts(),
      totalFindings: 0,
      ...extra
    };
  }

  private updateProgress(summary: ScanSummary, progress: ScanProgress): void {
    summary.progress = progress;
    summary.status = 'running';
    this.emitState();
  }

  private clearActive(scanId: string): void {
    if (this.active?.id === scanId) {
      this.active = undefined;
      this.activeController = undefined;
      this.activeCloudScanId = undefined;
      this.emitState();
    }
  }

  private async requireAuth() {
    const auth = await this.deps.auth.get();
    if (!auth) {
      throw new Error('Checkmarx is not signed in. Run "Checkmarx: Sign In with API Key" first.');
    }
    if (!auth.baseUri) {
      throw new Error('Checkmarx base URI is not configured. Set "checkmarxLocal.baseUri" or sign in again.');
    }
    return auth;
  }

  private async cli(): Promise<CxCli> {
    const settings = this.deps.settings.load();
    const info = await this.deps.cliProvider.resolve();
    this.setCliState(info, info.version);
    return new CxCli(info.path, this.deps.runner, this.deps.logger, () => settings.cliExtraArgs);
  }

  private getMerged(): Finding[] {
    if (!this.mergedCache) {
      this.mergedCache = mergeSources(this.sources);
      this.mergedCounts = countBySeverity(this.mergedCache);
    }
    return this.mergedCache;
  }

  private invalidateMerged(): void {
    this.mergedCache = undefined;
  }

  private emitEverything(): void {
    this.emitFindingsAndState();
    this.emitHistory();
  }

  private emitFindingsAndState(): void {
    this.invalidateMerged();
    const findings = this.getMerged();
    this.deps.onFindingsChanged(findings);
    this.emitState();
  }

  private emitState(): void {
    if (this.disposed) {
      return;
    }
    this.getMerged();
    this.deps.onStateChanged(this.getUiState());
  }

  private emitHistory(): void {
    if (this.disposed) {
      return;
    }
    this.deps.onHistoryChanged([...this.history]);
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveNow();
    }, 400);
    this.saveTimer.unref?.();
  }

  private async saveNow(): Promise<void> {
    const snapshot: PersistedState = buildPersistedState(this.sources, this.history, this.latest);
    this.saveChain = this.saveChain.then(async () => {
      try {
        await this.deps.stateStore.save(snapshot);
      } catch (error) {
        this.deps.logger.warn(`Unable to persist Checkmarx state: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    await this.saveChain;
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

declare module '../types' {
  interface ScanSummary {
    __findings?: Finding[];
  }
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function highestOf(counts: ReturnType<typeof emptyCounts>): Severity | undefined {
  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as Severity[]) {
    if (counts[severity] > 0) {
      return severity;
    }
  }
  return undefined;
}

function redactError(message: string): string {
  return message.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***');
}
