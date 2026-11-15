import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SettingsLike, SettingsSnapshot } from '../config';
import { hashContent, safeBaseName } from '../paths';
import type { LoggerLike } from '../logging';
import type { ScanService } from './scanService';
import { isExcludedFile, isSupportedFile } from './projectFiles';

export class RealtimeController implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private controllers = new Map<string, AbortController>();
  private lastHashes = new Map<string, string>();
  private running = false;

  constructor(
    private readonly root: string,
    private readonly settings: SettingsLike,
    private readonly scanService: ScanService,
    private readonly logger: LoggerLike,
    private readonly tempRoot: string
  ) {}

  get enabled(): boolean {
    return this.settings.load().realtimeEnabled;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.settings.load().realtimeEnabled) {
          return;
        }
        this.schedule(document, false);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const settings = this.settings.load();
        if (!settings.realtimeEnabled || settings.realtimeTrigger !== 'onType') {
          return;
        }
        if (event.contentChanges.length === 0) {
          return;
        }
        this.schedule(event.document, true);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cancelFile(document.uri.fsPath);
        this.lastHashes.delete(document.uri.fsPath);
      })
    );
  }

  stop(): void {
    this.running = false;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.lastHashes.clear();
  }

  refreshFromConfig(): void {
    const settings = this.settings.load();
    if (settings.realtimeEnabled) {
      this.start();
    } else {
      this.stop();
      this.lastHashes.clear();
    }
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }

  clearHashes(): void {
    this.lastHashes.clear();
  }

  cancelFile(file: string): void {
    const timer = this.timers.get(file);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(file);
    }
    const controller = this.controllers.get(file);
    if (controller) {
      controller.abort();
      this.controllers.delete(file);
    }
  }

  dispose(): void {
    this.stop();
  }

  private schedule(document: vscode.TextDocument, fromTyping: boolean): void {
    if (!this.shouldScan(document)) {
      return;
    }

    const key = document.uri.fsPath;
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const settings = this.settings.load();
    const delay = fromTyping ? settings.debounceMs : 300;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.scan(document, fromTyping);
    }, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private shouldScan(document: vscode.TextDocument): boolean {
    if (!document.uri.fsPath || document.uri.scheme !== 'file' || document.isUntitled) {
      return false;
    }
    const settings = this.settings.load();
    if (!settings.realtimeEnabled) {
      return false;
    }
    if (!this.scanService.isCliAvailable()) {
      return false;
    }
    if (!isInside(this.root, document.uri.fsPath)) {
      return false;
    }
    if (!isSupportedFile(document.uri.fsPath, settings)) {
      return false;
    }
    if (isExcludedFile(this.root, document.uri.fsPath, settings)) {
      return false;
    }
    if (isGeneratedOrMinified(document, settings)) {
      return false;
    }
    return true;
  }

  private async scan(document: vscode.TextDocument, fromTyping: boolean): Promise<void> {
    const file = document.uri.fsPath;
    if (!this.shouldScan(document)) {
      return;
    }
    const text = document.getText();
    const hash = hashContent(text);
    if (this.lastHashes.get(file) === hash) {
      return;
    }

    const previous = this.controllers.get(file);
    if (previous) {
      previous.abort();
    }
    const controller = new AbortController();
    this.controllers.set(file, controller);

    let snapshotFile: string | undefined;
    try {
      let scannedFile = file;
      if (fromTyping || document.isDirty) {
        snapshotFile = path.join(this.tempRoot, hash.slice(0, 12), safeBaseName(file));
        await mkdir(path.dirname(snapshotFile), { recursive: true });
        await writeFile(snapshotFile, text, 'utf8');
        scannedFile = snapshotFile;
      }

      this.logger.info(`Real-time scan: ${file}`);
      const summary = await this.scanService.scanFile(file, {
        mode: 'realtime',
        scannedFile,
        signal: controller.signal
      });

      if (summary.status === 'completed') {
        this.lastHashes.set(file, hash);
      } else if (summary.status === 'failed') {
        this.logger.warn(`Real-time scan failed for ${file}: ${summary.error ?? 'unknown error'}`);
      }
    } catch (error) {
      if (!isAbort(error)) {
        this.logger.warn(`Real-time scan failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (this.controllers.get(file) === controller) {
        this.controllers.delete(file);
      }
      if (snapshotFile) {
        await rm(snapshotFile, { force: true }).catch(() => undefined);
      }
    }
  }
}

function isGeneratedOrMinified(document: vscode.TextDocument, settings: SettingsSnapshot): boolean {
  const file = document.uri.fsPath.toLowerCase();
  if (/\.min\.(js|css)$/.test(file) || /\.bundle\.(js|css)$/.test(file) || file.endsWith('.map')) {
    return true;
  }
  const text = document.getText();
  if (text.length > settings.maxFileSizeKb * 1024) {
    return true;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    return false;
  }
  if (lines.some((line) => line.length > 2000)) {
    return true;
  }
  const average = text.length / lines.length;
  return lines.length > 50 && average > 300;
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Scan cancelled');
}