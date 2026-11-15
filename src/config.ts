import * as vscode from 'vscode';
import type { Severity } from './types';

export const CONFIG_SECTION = 'checkmarxLocal';

export const DEFAULT_EXTENSIONS = [
  '.java',
  '.kt',
  '.kts',
  '.cs',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.php',
  '.go',
  '.rb',
  '.swift',
  '.scala',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.vue',
  '.svelte'
];

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/vendor/**',
  '**/target/**',
  '**/.venv/**',
  '**/venv/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.map'
];

export interface SettingsSnapshot {
  baseUri: string;
  baseAuthUri: string;
  tenant: string;
  cliPath: string;
  cliExtraArgs: string[];
  cliAutoInstall: boolean;
  projectName: string;
  applicationName: string;
  branch: string;
  projectEngine: 'cloud' | 'local';
  scanTypes: string[];
  fileEngine: 'local' | 'cloud';
  fileFallbackToCloud: boolean;
  localConcurrency: number;
  localMaxFiles: number;
  exclude: string[];
  timeoutMinutes: number;
  pollIntervalSeconds: number;
  showCliOutput: boolean;
  realtimeEnabled: boolean;
  realtimeTrigger: 'onSave' | 'onType';
  debounceMs: number;
  maxFileSizeKb: number;
  realtimeExtensions: string[];
  diagnosticsEnabled: boolean;
  minSeverity: Severity;
  groupBy: 'severity' | 'file' | 'type';
  mcpEnabled: boolean;
  openChatAfterFixPrompt: boolean;
}

export interface SettingsLike {
  load(): SettingsSnapshot;
  onDidChange(listener: () => void): vscode.Disposable;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const result = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  return result.length > 0 ? result : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min?: number, max?: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const lower = min === undefined ? parsed : Math.max(min, parsed);
  return max === undefined ? lower : Math.min(max, lower);
}

export class Settings implements SettingsLike {
  load(): SettingsSnapshot {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const minSeverity = (configuration.get<string>('diagnostics.minSeverity') ?? 'LOW') as Severity;
    const groupBy = (configuration.get<string>('results.groupBy') ?? 'severity') as SettingsSnapshot['groupBy'];

    return {
      baseUri: (configuration.get<string>('baseUri') ?? '').trim(),
      baseAuthUri: (configuration.get<string>('baseAuthUri') ?? '').trim(),
      tenant: (configuration.get<string>('tenant') ?? '').trim(),
      cliPath: (configuration.get<string>('cliPath') ?? 'auto').trim(),
      cliExtraArgs: stringArray(configuration.get('cliExtraArgs'), []),
      cliAutoInstall: bool(configuration.get('cliAutoInstall'), true),
      projectName: (configuration.get<string>('project.name') ?? '').trim(),
      applicationName: (configuration.get<string>('project.applicationName') ?? '').trim(),
      branch: (configuration.get<string>('project.branch') ?? '').trim(),
      projectEngine: configuration.get<string>('scan.projectEngine') === 'local' ? 'local' : 'cloud',
      scanTypes: stringArray(configuration.get('scan.scanTypes'), ['sast']),
      fileEngine: configuration.get<string>('scan.fileEngine') === 'cloud' ? 'cloud' : 'local',
      fileFallbackToCloud: bool(configuration.get('scan.fileFallbackToCloud'), false),
      localConcurrency: numberValue(configuration.get('scan.localConcurrency'), 2, 1, 4),
      localMaxFiles: numberValue(configuration.get('scan.localMaxFiles'), 2000, 1),
      exclude: stringArray(configuration.get('scan.exclude'), DEFAULT_EXCLUDES),
      timeoutMinutes: numberValue(configuration.get('scan.timeoutMinutes'), 30, 1),
      pollIntervalSeconds: numberValue(configuration.get('scan.pollIntervalSeconds'), 5, 2),
      showCliOutput: bool(configuration.get('scan.showCliOutput'), false),
      realtimeEnabled: bool(configuration.get('realtime.enabled'), false),
      realtimeTrigger: configuration.get<string>('realtime.trigger') === 'onType' ? 'onType' : 'onSave',
      debounceMs: numberValue(configuration.get('realtime.debounceMs'), 1200, 250),
      maxFileSizeKb: numberValue(configuration.get('realtime.maxFileSizeKb'), 512, 1),
      realtimeExtensions: stringArray(configuration.get('realtime.extensions'), DEFAULT_EXTENSIONS).map((extension) =>
        extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      ),
      diagnosticsEnabled: bool(configuration.get('diagnostics.enabled'), true),
      minSeverity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(minSeverity) ? minSeverity : 'LOW',
      groupBy: ['severity', 'file', 'type'].includes(groupBy) ? groupBy : 'severity',
      mcpEnabled: bool(configuration.get('mcp.enabled'), true),
      openChatAfterFixPrompt: bool(configuration.get('ai.openChatAfterFixPrompt'), true)
    };
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        listener();
      }
    });
  }
}

export async function updateSetting<T>(key: string, value: T, target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, target);
}