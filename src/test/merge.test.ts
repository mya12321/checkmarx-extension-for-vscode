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
    engine: 'cloud',
    scanTypes: ['sast'],
    findings: [finding({ key: 'a3', file: '/workspace/a.ts', relativeFile: 'a.ts', line: 3 })]
  });
  sources.realtime.set('/workspace/c.ts', {
    scanId: 'realtime',
    engine: 'cloud',
    scanTypes: ['sast'],
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
  sources.files.set('/workspace/a.ts', {
    scanId: 'file',
    engine: 'cloud',
    scanTypes: ['sast'],
    findings: []
  });

  assert.equal(mergeSources(sources).length, 0);
});

test('a local ASCA rescan does not erase cloud findings for the file', () => {
  const sources = createEmptySources();
  sources.project = {
    scanId: 'cloud-project',
    findings: [
      finding({ key: 'crit', severity: 'CRITICAL', engine: 'cloud', file: '/workspace/a.ts', relativeFile: 'a.ts' })
    ]
  };
  // Local ASCA scans run the SAST engine only; an empty result must not claim
  // that a cloud finding was fixed.
  sources.files.set('/workspace/a.ts', {
    scanId: 'local-file',
    engine: 'local',
    scanTypes: ['sast'],
    findings: []
  });

  assert.deepEqual(
    mergeSources(sources).map((item) => item.key),
    ['crit']
  );
});

test('a SAST-only rescan keeps SCA and IaC findings for the same file', () => {
  const sources = createEmptySources();
  sources.project = {
    scanId: 'cloud-project',
    findings: [
      finding({ key: 'sast', type: 'sast', engine: 'cloud', file: '/workspace/a.ts', relativeFile: 'a.ts' }),
      finding({ key: 'sca', type: 'sca', engine: 'cloud', file: '/workspace/a.ts', relativeFile: 'a.ts' }),
      finding({ key: 'iac', type: 'iac', engine: 'cloud', file: '/workspace/a.ts', relativeFile: 'a.ts' })
    ]
  };
  sources.files.set('/workspace/a.ts', {
    scanId: 'cloud-file',
    engine: 'cloud',
    scanTypes: ['sast'],
    findings: []
  });

  assert.deepEqual(
    mergeSources(sources).map((item) => item.key).sort(),
    ['iac', 'sca']
  );
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