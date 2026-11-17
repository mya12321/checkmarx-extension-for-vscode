import type { ScanEngine, ScanSummary } from '../types';

export type ScanScopeFilter = 'project' | 'file';

export interface ScanListFilters {
  scope: ScanScopeFilter;
  engine: ScanEngine;
  /** Empty string shows every branch. */
  branch: string;
}

export const DEFAULT_SCAN_FILTERS: ScanListFilters = { scope: 'project', engine: 'cloud', branch: '' };

export function applyScanFilters(scans: readonly ScanSummary[], filters: ScanListFilters): ScanSummary[] {
  return scans
    .filter((scan) => scan.mode === filters.scope)
    .filter((scan) => scan.engine === filters.engine)
    .filter((scan) => !filters.branch || scan.branch === filters.branch)
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}