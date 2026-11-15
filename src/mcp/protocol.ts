import type {
  FileSummary,
  Finding,
  FindingDetails,
  ResultsQuery,
  ResultsResponse,
  ScanEngine,
  ScanState,
  ScanSummary,
  Severity
} from '../types';

export const BRIDGE_TOKEN_HEADER = 'x-checkmarx-bridge-token';

export interface ScanApi {
  getState(): Promise<ScanState>;
  scanProject(options: { engine?: ScanEngine; scanTypes?: string[]; wait?: boolean }): Promise<ScanSummary>;
  scanFile(file: string, options?: { engine?: ScanEngine; wait?: boolean }): Promise<ScanSummary>;
  getResults(query: ResultsQuery): Promise<ResultsResponse>;
  getFinding(key: string, includeCode: boolean): Promise<FindingDetails | undefined>;
  getFileFindings(file: string): Finding[];
  listScans(limit: number): ScanSummary[];
  cancel(scanId?: string): Promise<boolean>;
  getFiles(): FileSummary[];
  reveal(file: string, line?: number, column?: number): Promise<void>;
  clearResults(): Promise<void>;
}

export interface BridgeState {
  version: string;
  workspace: string;
  authenticated: boolean;
  cliAvailable: boolean;
  cliPath?: string;
  cliVersion?: string;
  realtimeEnabled: boolean;
  active?: ScanSummary;
  latest?: ScanSummary;
  counts: Record<Severity, number>;
  total: number;
  history: ScanSummary[];
}

export interface BridgeScanResponse {
  scan: ScanSummary;
  waiting: boolean;
}

export interface BridgeResultsResponse extends ResultsResponse {}

export interface BridgeFindingResponse {
  finding?: FindingDetails;
}

export interface BridgeFileFindingsResponse {
  file: string;
  relativeFile: string;
  findings: Finding[];
  total: number;
}

export interface BridgeErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface BridgeHealth {
  ok: boolean;
  version: string;
  workspace: string;
  pid: number;
}

export interface BridgeProjectScanRequest {
  engine?: ScanEngine;
  scanTypes?: string[];
  wait?: boolean;
}

export interface BridgeFileScanRequest {
  file: string;
  engine?: ScanEngine;
  wait?: boolean;
}

export interface BridgeCancelRequest {
  scanId?: string;
}

export interface BridgeRevealRequest {
  file: string;
  line?: number;
  column?: number;
}

export function publicScan(scan: ScanSummary | undefined): ScanSummary | undefined {
  if (!scan) {
    return undefined;
  }
  const copy: ScanSummary = { ...scan };
  delete copy.findingsBuffer;
  return copy;
}

export function stateToBridge(state: ScanState, version: string, workspace: string): BridgeState {
  return {
    version,
    workspace,
    authenticated: state.authenticated,
    cliAvailable: state.cliAvailable,
    cliPath: state.cliPath,
    cliVersion: state.cliVersion,
    realtimeEnabled: state.realtimeEnabled,
    active: publicScan(state.active),
    latest: publicScan(state.latest),
    counts: state.counts,
    total: state.total,
    history: state.history.map((scan) => publicScan(scan) ?? scan)
  };
}