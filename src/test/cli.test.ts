import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudResultsArgs, cloudScanCreateArgs, ascaScanArgs } from '../cli/args';
import { extractJson } from '../json';
import { formatCounts, meetsMinSeverity, normalizeSeverity, severityRank } from '../severity';
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
    ...overrides
  };
}

test('normalizes Checkmarx severities', () => {
  assert.equal(normalizeSeverity('critical'), 'CRITICAL');
  assert.equal(normalizeSeverity('High'), 'HIGH');
  assert.equal(normalizeSeverity('moderate'), 'MEDIUM');
  assert.equal(normalizeSeverity('informational'), 'INFO');
  assert.equal(normalizeSeverity(undefined), 'INFO');
  assert.ok(severityRank('CRITICAL') < severityRank('HIGH'));
  assert.equal(meetsMinSeverity('LOW', 'MEDIUM'), false);
  assert.equal(meetsMinSeverity('HIGH', 'MEDIUM'), true);
  assert.equal(formatCounts({ CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0, INFO: 0 }), 'Critical 1 · High 2');
});

test('cloud scan arguments never contain credentials and target the project', () => {
  const args = cloudScanCreateArgs({
    root: '/repo',
    projectName: 'my project',
    branch: 'feature/x',
    scanTypes: ['sast', 'sca']
  });
  assert.deepEqual(args.slice(0, 2), ['scan', 'create']);
  assert.ok(args.includes('/repo'));
  assert.ok(args.includes('my project'));
  assert.ok(args.includes('sast,sca'));
  assert.ok(args.includes('--async'));
  assert.ok(!args.some((arg) => /apikey|CX_APIKEY/i.test(arg)));
});

test('cloud scans pass the associated application name', () => {
  const args = cloudScanCreateArgs({
    root: '/repo',
    projectName: 'p',
    applicationName: 'Payments',
    branch: 'main',
    scanTypes: ['sast']
  });
  const index = args.indexOf('--application-name');
  assert.equal(args[index + 1], 'Payments');
});

test('single-file cloud filters are normalized to forward slashes', () => {
  const args = cloudScanCreateArgs({
    root: '/repo',
    projectName: 'p',
    branch: 'main',
    scanTypes: ['sast'],
    fileFilter: 'src\\app\\Main.java'
  });
  const index = args.indexOf('--file-filter');
  assert.equal(args[index + 1], 'src/app/Main.java');
});

test('local ASCA args do not set an IDE agent flag', () => {
  const args = ascaScanArgs('/repo/src/app.py');
  assert.deepEqual(args, ['scan', 'asca', '-s', '/repo/src/app.py']);
  assert.equal(args.includes('--agent'), false);
});

test('cloud results arguments write a JSON report outside the workspace', () => {
  const args = cloudResultsArgs('scan-id', '/storage/cloud/scan-id', 'results-scan-id');
  assert.deepEqual(args, [
    'results',
    'show',
    '--scan-id',
    'scan-id',
    '--report-format',
    'json',
    '--output-path',
    '/storage/cloud/scan-id',
    '--output-name',
    'results-scan-id'
  ]);
});

test('extracts JSON from mixed CLI output and BOM-prefixed files', () => {
  assert.deepEqual(extractJson('warning: something\n{"id":"scan-1","status":"QUEUED"}\n'), {
    id: 'scan-1',
    status: 'QUEUED'
  });
  assert.deepEqual(extractJson('\uFEFF{"results":[],"totalCount":0}'), { results: [], totalCount: 0 });
});

test('finding objects are plain data', () => {
  const item = finding({ severity: 'MEDIUM' });
  assert.equal(item.severity, 'MEDIUM');
});