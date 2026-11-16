import * as vscode from 'vscode';
import type { SettingsLike } from '../config';
import type { ScanService } from '../scans/scanService';
import type { FileSummary, Finding, FindingDetails, FindingSource, ResultsQuery, ResultsResponse, ScanEngine, ScanState, ScanSummary } from '../types';
import type { ScanApi } from './protocol';

export class ScanApiAdapter implements ScanApi {
  constructor(
    private readonly service: ScanService,
    private readonly settings: SettingsLike,
    private readonly confirmCloudUpload?: () => Promise<boolean>
  ) {}

  getState(): Promise<ScanState> {
    return this.service.getState();
  }

  async scanProject(options: { engine?: ScanEngine; scanTypes?: string[]; wait?: boolean }): Promise<ScanSummary> {
    const engine = options.engine ?? this.settings.load().projectEngine;
    if (engine === 'cloud') {
      this.requireApplication();
    }
    if (engine === 'cloud' && this.confirmCloudUpload && !(await this.confirmCloudUpload())) {
      throw new Error('Cloud scan was cancelled by the user.');
    }
    return await this.service.scanProject(engine, options.scanTypes);
  }

  async scanFile(file: string, options?: { engine?: ScanEngine; wait?: boolean }): Promise<ScanSummary> {
    const engine = options?.engine ?? this.settings.load().fileEngine;
    if (engine === 'cloud') {
      this.requireApplication();
      if (this.confirmCloudUpload && !(await this.confirmCloudUpload())) {
        throw new Error('Cloud scan was cancelled by the user.');
      }
    }
    return await this.service.scanFile(file, { engine });
  }

  getResults(query: ResultsQuery): Promise<ResultsResponse> {
    return query.source === 'realtime'
      ? this.service.getRealtimeResults(query)
      : this.service.getResults(query);
  }

  getFinding(key: string, includeCode: boolean): Promise<FindingDetails | undefined> {
    return this.service.getFinding(key, includeCode);
  }

  getFileFindings(file: string, source: FindingSource = 'scan'): Finding[] {
    return this.service.getFileFindings(file, source);
  }

  listScans(limit: number): ScanSummary[] {
    return this.service.listScans(limit);
  }

  cancel(scanId?: string): Promise<boolean> {
    return this.service.cancel(scanId);
  }

  getFiles(source: FindingSource = 'scan'): FileSummary[] {
    return this.service.getFiles(source);
  }

  private requireApplication(): void {
    if (!this.settings.load().applicationName) {
      throw new Error(
        'Cloud scans require a Checkmarx One application name. Set "checkmarxLocal.project.applicationName" or use Checkmarx: Open Dashboard > Set application.'
      );
    }
  }

  async reveal(file: string, line?: number, column?: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    const target = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
    const range = new vscode.Range(target, target);
    editor.selection = new vscode.Selection(target, target);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  async clearResults(): Promise<void> {
    await this.service.clearResults();
  }
}