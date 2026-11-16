import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyScanFilters, DEFAULT_SCAN_FILTERS } from '../scans/scanFilters';
import type { ScanSummary, SeverityCounts } from '../types';

const EMPTY_COUNTS: SeverityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };

function scan(overrides: Partial<ScanSummary>): ScanSummary {
  return {
    id: 'scan',
    mode: 'project',
    engine: 'cloud',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    scanTypes: ['sast'],
    counts: EMPTY_COUNTS,
    totalFindings: 0,
    ...overrides
  };
}

const scans = [
  scan({ id: 'cloud-old', startedAt: '2026-01-01T00:00:00.000Z' }),
  scan({ id: 'cloud-new', startedAt: '2026-01-03T00:00:00.000Z' }),
  scan({ id: 'local-project', engine: 'local' }),
  scan({ id: 'cloud-file', mode: 'file' }),
  scan({ id: 'local-file', mode: 'file', engine: 'local' })
];

test('scan filters default to cloud project scans, newest first', () => {
  assert.deepEqual(DEFAULT_SCAN_FILTERS, { scope: 'project', engine: 'cloud' });
  assert.deepEqual(
    applyScanFilters(scans, DEFAULT_SCAN_FILTERS).map((item) => item.id),
    ['cloud-new', 'cloud-old']
  );
});

test('scan filters combine scope and engine', () => {
  assert.deepEqual(
    applyScanFilters(scans, { scope: 'file', engine: 'local' }).map((item) => item.id),
    ['local-file']
  );
  assert.deepEqual(
    applyScanFilters(scans, { scope: 'project', engine: 'local' }).map((item) => item.id),
    ['local-project']
  );
  assert.deepEqual(
    applyScanFilters(scans, { scope: 'file', engine: 'cloud' }).map((item) => item.id),
    ['cloud-file']
  );
});