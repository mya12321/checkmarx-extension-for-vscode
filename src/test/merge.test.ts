import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptySources, filterFindings, mergeSources } from '../findings/merge';
import type { Finding } from '../types';

function finding(overrides: Partial<Finding>): Finding {
  return {
    key: 'k',
    id: 'id',
    scanId: 'scan',
    mode: 'project',
    engine: 'cloud',
    type: 'sast',
    severity: 'HIGH',
    title: 'title',
    description: '',
    file: '/workspace/a.ts',
    relativeFile: 'a.ts',
    line: 1,
    ...overrides
  };
}

test('file and real-time scans override project findings for that file only', () => {
  const sources = createEmptySources();
  sources.project = {
    scanId: 'project',
    findings: [
      finding({ key: 'a1', file: '/workspace/a.ts', relativeFile: 'a.ts', line: 1 }),
      finding({ key: 'a2', file: '/workspace/a.ts', relativeFile: 'a.ts', line: 2 }),
      finding({ key: 'b1', file: '/workspace/b.ts', relativeFile: 'b.ts', line: 1 })
    ]
  };
  sources.files.set('/workspace/a.ts', {
    scanId: 'file',
    findings: [finding({ key: 'a3', file: '/workspace/a.ts', relativeFile: 'a.ts', line: 3 })]
  });
  sources.realtime.set('/workspace/c.ts', {
    scanId: 'realtime',
    findings: [finding({ key: 'c1', file: '/workspace/c.ts', relativeFile: 'c.ts', line: 9 })]
  });

  const merged = mergeSources(sources);
  assert.deepEqual(
    merged.map((item) => item.key).sort(),
    ['a3', 'b1', 'c1']
  );
});

test('an empty file scan clears stale project findings for the file', () => {
  const sources = createEmptySources();
  sources.project = {
    scanId: 'project',
    findings: [finding({ key: 'a1', file: '/workspace/a.ts', relativeFile: 'a.ts' })]
  };
  sources.files.set('/workspace/a.ts', { scanId: 'file', findings: [] });

  assert.equal(mergeSources(sources).length, 0);
});

test('filters findings by severity, type and file', () => {
  const findings = [
    finding({ key: 'a', severity: 'CRITICAL', type: 'sast', relativeFile: 'src/a.ts' }),
    finding({ key: 'b', severity: 'LOW', type: 'sca', relativeFile: 'pom.xml' }),
    finding({ key: 'c', severity: 'HIGH', type: 'iac', relativeFile: 'infra/main.tf' })
  ];

  assert.deepEqual(
    filterFindings(findings, { query: { severity: ['CRITICAL', 'HIGH'] } }).map((item) => item.key),
    ['a', 'c']
  );
  assert.deepEqual(filterFindings(findings, { query: { type: 'sca' } }).map((item) => item.key), ['b']);
  assert.deepEqual(filterFindings(findings, { query: { file: 'src/a.ts' } }).map((item) => item.key), ['a']);
  assert.deepEqual(filterFindings(findings, { minSeverity: 'HIGH' }).map((item) => item.key), ['a', 'c']);
});