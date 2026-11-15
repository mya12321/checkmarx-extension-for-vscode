export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

export type Severity = (typeof SEVERITIES)[number];

export type SeverityCounts = Record<Severity, number>;

export type ScanMode = 'project' | 'file' | 'realtime';

export type ScanEngine = 'cloud' | 'local';

export type ScanStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type FindingType = 'sast' | 'sca' | 'iac' | 'secret' | 'other';

export interface FlowNode {
  fileName?: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  name?: string;
  method?: string;
  domType?: string;
  fullName?: string;
}

export interface Finding {
  /** Stable identifier across rescans of the same code location. */
  key: string;
  /** Provider result id (Checkmarx result id, rule id, CVE, ...). */
  id: string;
  /** Id of the extension scan that produced this finding. */
  scanId: string;
  mode: ScanMode;
  engine: ScanEngine;
  type: FindingType;
  severity: Severity;
  title: string;
  description: string;
  remediation?: string;
  /** Absolute path when it can be resolved against the workspace. */
  file?: string;
  /** Workspace-relative path used for grouping and display. */
  relativeFile?: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column number. */
  column?: number;
  endLine?: number;
  endColumn?: number;
  length?: number;
  codeSnippet?: string;
  language?: string;
  cweId?: string;
  cveId?: string;
  queryName?: string;
  group?: string;
  state?: string;
  status?: string;
  firstFoundAt?: string;
  packageName?: string;
  packageVersion?: string;
  recommendedVersion?: string;
  nodes?: FlowNode[];
  raw?: unknown;
}

export interface SeveritySummary {
  counts: SeverityCounts;
  total: number;
}

export interface ScanProgress {
  message: string;
  current?: number;
  total?: number;
}

export interface ScanSummary {
  id: string;
  mode: ScanMode;
  engine: ScanEngine;
  status: ScanStatus;
  startedAt: string;
  finishedAt?: string;
  projectName?: string;
  branch?: string;
  scanTypes: string[];
  root?: string;
  file?: string;
  relativeFile?: string;
  cloudScanId?: string;
  error?: string;
  message?: string;
  progress?: ScanProgress;
  counts: SeverityCounts;
  totalFindings: number;
  version?: number;
  /** Transient findings buffer used while a scan is running. Never persisted. */
  findingsBuffer?: Finding[];
}

export interface ScanRecord {
  summary: ScanSummary;
  findings: Finding[];
}

export interface ResultsQuery {
  scanId?: string;
  severity?: Severity[];
  type?: FindingType;
  file?: string;
  state?: string;
  limit?: number;
  includeFlow?: boolean;
}

export interface ResultsResponse {
  scan?: ScanSummary;
  findings: Finding[];
  total: number;
  counts: SeverityCounts;
}

export interface FileSummary {
  file: string;
  relativeFile: string;
  findings: number;
  counts: SeverityCounts;
  highestSeverity?: Severity;
}

export interface FindingDetails {
  finding: Finding;
  codeContext?: string;
  codeStartLine?: number;
  codeEndLine?: number;
  fileExists: boolean;
}

export interface ScanState {
  active?: ScanSummary;
  latest?: ScanSummary;
  authenticated: boolean;
  cliAvailable: boolean;
  cliPath?: string;
  cliVersion?: string;
  realtimeEnabled: boolean;
  findings: Finding[];
  counts: SeverityCounts;
  total: number;
  history: ScanSummary[];
}

export interface AuthConfig {
  apiKey: string;
  baseUri: string;
  baseAuthUri?: string;
  tenant?: string;
}

export interface CliInfo {
  path: string;
  version?: string;
  source: 'setting' | 'path' | 'managed' | 'bundled' | 'official-extension';
}

export interface PersistedSources {
  project?: {
    scanId: string;
    findings: Finding[];
  };
  files: Array<{
    file: string;
    scanId: string;
    findings: Finding[];
  }>;
  realtime: Array<{
    file: string;
    scanId: string;
    findings: Finding[];
  }>;
}

export interface PersistedState {
  version: 1;
  savedAt: string;
  sources: PersistedSources;
  history: ScanSummary[];
  latest?: ScanSummary;
}