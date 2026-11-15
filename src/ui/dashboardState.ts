import type { ScanEngine, ScanSummary, SeverityCounts } from '../types';

export interface LoginInput {
  baseUri: string;
  baseAuthUri?: string;
  tenant: string;
  apiKey: string;
}

export interface DashboardState {
  workspace: string;
  projectName: string;
  authenticated: boolean;
  tenant?: string;
  baseUri?: string;
  applicationName?: string;
  baseAuthUri?: string;
  cliAvailable: boolean;
  cliPath?: string;
  cliVersion?: string;
  realtimeEnabled: boolean;
  realtimeTrigger: 'onSave' | 'onType';
  activeFile?: string;
  active?: ScanSummary;
  latest?: ScanSummary;
  counts: SeverityCounts;
  total: number;
  mcpRunning: boolean;
  history: ScanSummary[];
}

export interface DashboardActions {
  login(input: LoginInput): Promise<{ ok: boolean; error?: string }>;
  logout(): Promise<void>;
  scanProject(engine: ScanEngine): Promise<void>;
  setApplication(): Promise<void>;
  scanCurrentFile(engine: ScanEngine): Promise<void>;
  toggleRealtime(): Promise<void>;
  cancel(): Promise<void>;
  installCli(): Promise<void>;
  selectCli(): Promise<void>;
  showResults(): Promise<void>;
  clearResults(): Promise<void>;
  restartMcp(): Promise<void>;
  openSettings(): Promise<void>;
}

export function emptyDashboardState(): DashboardState {
  return {
    workspace: '',
    projectName: '',
    authenticated: false,
    cliAvailable: false,
    realtimeEnabled: false,
    realtimeTrigger: 'onSave',
    counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    total: 0,
    mcpRunning: false,
    history: []
  };
}