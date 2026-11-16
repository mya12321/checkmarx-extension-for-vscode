import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cloudResultsArgs, cloudScanCreateArgs, ascaScanArgs } from '../cli/args';
import type { CxCli, CloudScanRequest } from '../cli/client';
import { extractJson } from '../json';
import { noopLogger } from '../logging';
import { runCloudScan, type CloudScanOptions } from '../scans/cloudScanner';
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

function cloudOptions(root: string, mode: 'project' | 'file'): CloudScanOptions {
  return {
    root,
    projectName: 'p',
    applicationName: 'app',
    branch: 'main',
    scanTypes: ['sast'],
    auth: { apiKey: 'key', baseUri: 'https://ast.example', tenant: 'tenant' },
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    pollIntervalMs: 10,
    mode,
    scanId: 'scan',
    outputDirectory: join(root, '.out'),
    logger: noopLogger
  };
}

async function capturedCloudRequest(root: string, mode: 'project' | 'file'): Promise<CloudScanRequest> {
  let request: CloudScanRequest | undefined;
  const cli = {
    createCloudScan: async (candidate: CloudScanRequest) => {
      request = candidate;
      throw new Error('stop after create');
    }
  } as unknown as CxCli;
  await assert.rejects(runCloudScan(cli, cloudOptions(root, mode)), /stop after create/);
  assert.ok(request);
  return request;
}

test('project cloud scans turn git-ignored paths into Ant exclusions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-cloud-'));
  try {
    await writeFile(join(root, '.gitignore'), 'node_modules\n', 'utf8');
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), '', 'utf8');
    await writeFile(join(root, 'main.js'), '', 'utf8');

    const request = await capturedCloudRequest(root, 'project');
    assert.equal(request.excludeGitFolder, true);
    assert.deepEqual(request.fileFilterExt, ['!node_modules']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project cloud scans skip gitignore filtering when nothing is ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-cloud-'));
  try {
    const request = await capturedCloudRequest(root, 'project');
    assert.equal(request.excludeGitFolder, true);
    assert.deepEqual(request.fileFilterExt, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('single-file cloud scans do not add project-wide git flags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-cloud-'));
  try {
    await writeFile(join(root, '.gitignore'), 'node_modules\n', 'utf8');
    const request = await capturedCloudRequest(root, 'file');
    assert.equal(request.excludeGitFolder, false);
    assert.equal(request.fileFilterExt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});