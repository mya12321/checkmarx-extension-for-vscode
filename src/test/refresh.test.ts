import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { AuthStoreLike } from '../auth/authStore';
import type { SettingsLike } from '../config';
import type { CliRunner, RunResult } from '../cli/runner';
import { noopLogger } from '../logging';
import type { StateStoreLike } from '../scans/stateStore';
import { ScanService, type CliProviderLike, type ScanServiceDeps } from '../scans/scanService';
import type { Finding, PersistedState, ScanSummary, SeverityCounts } from '../types';

const fixture = join(process.cwd(), 'src', 'test', 'fixtures', 'cx_result.json');

const EMPTY_COUNTS: SeverityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };

function summary(overrides: Partial<ScanSummary>): ScanSummary {
  return {
    id: 'scan-1',
    mode: 'project',
    engine: 'cloud',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    scanTypes: ['sast'],
    counts: EMPTY_COUNTS,
    totalFindings: 0,
    cloudScanId: 'cloud-1',
    ...overrides
  };
}

class MemoryStateStore implements StateStoreLike {
  saved: PersistedState[] = [];
  constructor(private readonly state?: PersistedState) {}
  async load(): Promise<PersistedState | undefined> {
    return this.state;
  }
  async save(state: PersistedState): Promise<void> {
    this.saved.push(state);
  }
}

function persisted(latest?: ScanSummary): PersistedState {
  return {
    version: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    sources: latest ? { project: { scanId: latest.id, findings: [] }, files: [], realtime: [] } : { files: [], realtime: [] },
    history: latest ? [latest] : [],
    latest
  };
}

function makeService(
  root: string,
  storageRoot: string,
  state: PersistedState,
  runner: CliRunner,
  auth?: AuthStoreLike,
  settingsPatch: { branch?: string; projectName?: string } = {}
): ScanService {
  const settings = {
    load: () => ({
      cliExtraArgs: [],
      realtimeEnabled: false,
      branch: settingsPatch.branch ?? '',
      projectName: settingsPatch.projectName ?? '',
      scanTypes: ['sast']
    })
  } as unknown as SettingsLike;
  const cliProvider: CliProviderLike = {
    resolve: async () => ({ path: '/fake/cx', source: 'setting', version: '2.3.71' }),
    version: async () => '2.3.71',
    invalidate: () => undefined
  };
  const deps: ScanServiceDeps = {
    root,
    settings,
    auth:
      auth ??
      ({
        get: async () => ({ apiKey: 'key', baseUri: 'https://ast.example', tenant: 'tenant' }),
        isSignedIn: async () => true
      } as AuthStoreLike),
    cliProvider,
    runner,
    logger: noopLogger,
    stateStore: new MemoryStateStore(state),
    storageRoot,
    onStateChanged: () => undefined,
    onFindingsChanged: () => undefined,
    onHistoryChanged: () => undefined
  };
  return new ScanService(deps);
}

function ok(stdout: string): RunResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false, aborted: false, durationMs: 1 };
}

interface ServerData {
  projects?: unknown[];
  scans?: unknown[];
}

function serverRunner(calls: string[][], data: ServerData = {}): CliRunner {
  return {
    run: async (_command: string, args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[0] === 'project' && args[1] === 'list') {
        return ok(JSON.stringify(data.projects ?? []));
      }
      if (args[0] === 'scan' && args[1] === 'list') {
        return ok(JSON.stringify(data.scans ?? []));
      }
      const outputPath = args[args.indexOf('--output-path') + 1]!;
      const outputName = args[args.indexOf('--output-name') + 1]!;
      await mkdir(outputPath, { recursive: true });
      await copyFile(fixture, join(outputPath, `${outputName}.json`));
      return ok('');
    }
  } as unknown as CliRunner;
}

function resultsCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === 'results');
}

function failingResultsRunner(calls: string[][], data: ServerData): CliRunner {
  return {
    run: async (_command: string, args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[0] === 'project' && args[1] === 'list') {
        return ok(JSON.stringify(data.projects ?? []));
      }
      if (args[0] === 'scan' && args[1] === 'list') {
        return ok(JSON.stringify(data.scans ?? []));
      }
      return {
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'Failed listing results: context deadline exceeded',
        timedOut: false,
        aborted: false,
        durationMs: 1
      };
    }
  } as unknown as CliRunner;
}

test('refresh re-downloads the cloud scan backing the current workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const service = makeService(root, storage, persisted(summary({})), serverRunner(calls));
  try {
    await service.initialize();
    const result = await service.refreshCloudResults();
    assert.ok(result);
    assert.equal(result.cloudScanId, 'cloud-1');
    assert.equal(result.findings, 4);
    assert.equal(result.adopted, false);
    assert.equal(service.getFindings().length, 4);
    const downloads = resultsCalls(calls);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0]![downloads[0]!.indexOf('--scan-id') + 1], 'cloud-1');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refresh adopts the latest completed scan found on the server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const projectName = basename(root);
  const service = makeService(
    root,
    storage,
    persisted(),
    serverRunner(calls, {
      projects: [{ ID: 'project-1', Name: projectName }],
      scans: [
        {
          ID: 'cloud-old',
          Status: 'Completed',
          CreatedAt: '2026-01-01T00:00:00Z',
          UpdatedAt: '2026-01-01T01:00:00Z',
          ProjectName: projectName,
          Branch: 'main',
          Engines: ['sast']
        },
        {
          ID: 'cloud-newest',
          Status: 'Completed',
          CreatedAt: '2026-01-03T00:00:00Z',
          UpdatedAt: '2026-01-03T01:00:00Z',
          ProjectName: projectName,
          Branch: 'dev',
          Engines: ['sast', 'sca']
        },
        { ID: 'cloud-running', Status: 'Running', CreatedAt: '2026-01-04T00:00:00Z', ProjectName: projectName, Engines: ['sast'] }
      ]
    })
  );
  try {
    await service.initialize();
    const result = await service.refreshCloudResults();
    assert.ok(result);
    assert.equal(result.adopted, true);
    assert.equal(result.cloudScanId, 'cloud-newest');
    assert.equal(result.findings, 4);
    const state = service.getUiState();
    assert.equal(state.latest?.cloudScanId, 'cloud-newest');
    assert.equal(state.latest?.branch, 'dev');
    assert.deepEqual(state.latest?.scanTypes, ['sast', 'sca']);
    assert.equal(state.history[0]?.cloudScanId, 'cloud-newest');
    const listCall = calls.find((args) => args[0] === 'scan' && args[1] === 'list');
    assert.ok(listCall);
    assert.ok(listCall!.includes('project-id=project-1'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refresh surfaces a result download failure instead of falling back to an older scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const projectName = basename(root);
  const failed = summary({ id: 'scan-old', cloudScanId: 'cloud-old', status: 'failed', error: 'old failure' });
  const service = makeService(
    root,
    storage,
    persisted(failed),
    failingResultsRunner(calls, {
      projects: [{ ID: 'project-1', Name: projectName }],
      scans: [
        {
          ID: 'cloud-new',
          Status: 'Completed',
          CreatedAt: '2026-01-03T00:00:00Z',
          ProjectName: projectName,
          Branch: '',
          Engines: ['sast']
        }
      ]
    })
  );
  try {
    await service.initialize();
    await assert.rejects(service.refreshCloudResults(), /context deadline exceeded/);
    const downloads = resultsCalls(calls);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0]![downloads[0]!.indexOf('--scan-id') + 1], 'cloud-new');
    assert.equal(service.getFindings().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refresh marks a previously failed scan as completed after downloading its results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const projectName = basename(root);
  const failed = summary({ id: 'scan-1', cloudScanId: 'cloud-1', status: 'failed', error: 'download timeout' });
  const service = makeService(
    root,
    storage,
    persisted(failed),
    serverRunner(calls, {
      projects: [{ ID: 'project-1', Name: projectName }],
      scans: [
        {
          ID: 'cloud-1',
          Status: 'Completed',
          CreatedAt: '2026-01-01T00:00:00Z',
          UpdatedAt: '2026-01-01T01:00:00Z',
          ProjectName: projectName,
          Branch: '',
          Engines: ['sast']
        }
      ]
    })
  );
  try {
    await service.initialize();
    const result = await service.refreshCloudResults();
    assert.ok(result);
    assert.equal(result.adopted, false);
    assert.equal(result.findings, 4);
    const scan = service.getScan('scan-1');
    assert.equal(scan?.status, 'completed');
    assert.equal(scan?.error, undefined);
    assert.equal(scan?.totalFindings, 4);
    assert.equal(service.getFindings().length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refreshCloudScans lists server scans across branches and deduplicates them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const projectName = basename(root);
  const service = makeService(
    root,
    storage,
    persisted(),
    serverRunner(calls, {
      projects: [{ ID: 'project-1', Name: projectName }],
      scans: [
        {
          ID: 'c-main-new',
          Status: 'Completed',
          CreatedAt: '2026-01-03T00:00:00Z',
          Branch: 'main',
          Engines: ['sast']
        },
        {
          ID: 'c-main-old',
          Status: 'Failed',
          CreatedAt: '2026-01-02T00:00:00Z',
          Branch: 'main',
          Engines: ['sast']
        },
        {
          ID: 'c-dev',
          Status: 'Completed',
          CreatedAt: '2026-01-04T00:00:00Z',
          Branch: 'dev',
          Engines: ['sast']
        }
      ]
    })
  );
  try {
    await service.initialize();
    const first = await service.refreshCloudScans();
    assert.deepEqual(first, { added: 3, total: 3, branches: ['dev', 'main'] });
    assert.deepEqual(
      service.listScans().map((scan) => scan.id),
      ['cloud-c-dev', 'cloud-c-main-new', 'cloud-c-main-old']
    );
    assert.equal(service.listScans()[2]?.status, 'failed');

    const second = await service.refreshCloudScans();
    assert.equal(second.added, 0);
    assert.equal(service.listScans().length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refreshCloudScans updates an existing failed entry with the server status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const projectName = basename(root);
  const failed = summary({ id: 'scan-1', cloudScanId: 'cloud-1', status: 'failed', error: 'download timeout' });
  const service = makeService(
    root,
    storage,
    persisted(failed),
    serverRunner(calls, {
      projects: [{ ID: 'project-1', Name: projectName }],
      scans: [
        {
          ID: 'cloud-1',
          Status: 'Completed',
          CreatedAt: '2026-01-01T00:00:00Z',
          Branch: 'main',
          Engines: ['sast']
        }
      ]
    }),
    undefined
  );
  try {
    await service.initialize();
    const result = await service.refreshCloudScans();
    assert.equal(result.added, 0);
    assert.equal(service.getScan('scan-1')?.status, 'completed');
    assert.equal(service.getScan('scan-1')?.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refresh can target a branch selected in the Scans view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const projectName = basename(root);
  const service = makeService(
    root,
    storage,
    persisted(),
    serverRunner(calls, {
      projects: [{ ID: 'project-1', Name: projectName }],
      scans: [
        {
          ID: 'cloud-main',
          Status: 'Completed',
          CreatedAt: '2026-01-05T00:00:00Z',
          Branch: 'main',
          Engines: ['sast']
        },
        {
          ID: 'cloud-dev',
          Status: 'Completed',
          CreatedAt: '2026-01-04T00:00:00Z',
          Branch: 'dev',
          Engines: ['sast']
        }
      ]
    })
  );
  try {
    await service.initialize();
    const result = await service.refreshCloudResults('dev');
    assert.ok(result);
    assert.equal(result.cloudScanId, 'cloud-dev');

    const missing = await service.refreshCloudResults('release');
    assert.equal(missing, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refresh is a no-op when the current results are local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const local = summary({ id: 'local-1', engine: 'local', cloudScanId: undefined });
  const service = makeService(root, storage, persisted(local), serverRunner(calls));
  try {
    await service.initialize();
    const result = await service.refreshCloudResults();
    assert.equal(result, undefined);
    assert.equal(resultsCalls(calls).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('refresh reports when the user is not signed in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const auth = { get: async () => undefined, isSignedIn: async () => false } as AuthStoreLike;
  const service = makeService(root, storage, persisted(summary({})), serverRunner(calls), auth);
  try {
    await service.initialize();
    await assert.rejects(service.refreshCloudResults(), /not signed in/i);
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

function historyState(history: ScanSummary[], latest: ScanSummary): PersistedState {
  return {
    version: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    sources: { project: { scanId: latest.id, findings: [] }, files: [], realtime: [] },
    history,
    latest
  };
}

test('selecting an older cloud scan downloads and shows its own findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const latest = summary({ id: 'scan-2', cloudScanId: 'cloud-2' });
  const older = summary({ id: 'scan-1', cloudScanId: 'cloud-1', startedAt: '2025-12-31T00:00:00.000Z' });
  const service = makeService(root, storage, historyState([latest, older], latest), serverRunner(calls));
  try {
    await service.initialize();
    assert.equal(service.getFindings().length, 0);
    await service.selectScan('scan-1');
    assert.equal(service.getSelectedScanId(), 'scan-1');
    assert.equal(service.getFindings().length, 4);
    const download = resultsCalls(calls)[0];
    assert.ok(download);
    assert.equal(download![download!.indexOf('--scan-id') + 1], 'cloud-1');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('selecting an old local scan without loaded findings reports why', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const calls: string[][] = [];
  const latest = summary({ id: 'scan-2', cloudScanId: 'cloud-2' });
  const local = summary({ id: 'scan-1', engine: 'local', cloudScanId: undefined, startedAt: '2025-12-31T00:00:00.000Z' });
  const service = makeService(root, storage, historyState([latest, local], latest), serverRunner(calls));
  try {
    await service.initialize();
    await assert.rejects(service.selectScan('scan-1'), /no longer available/i);
    assert.equal(service.getSelectedScanId(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

function finding(overrides: Partial<Finding>): Finding {
  return {
    key: 'key',
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

test('results show one scan without merging file or realtime findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cx-refresh-'));
  const storage = await mkdtemp(join(tmpdir(), 'cx-refresh-store-'));
  const latest = summary({ id: 'scan-1' });
  const state: PersistedState = {
    version: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    sources: {
      project: {
        scanId: 'scan-1',
        findings: [finding({ key: 'project', file: '/w/a.ts', relativeFile: 'a.ts', severity: 'CRITICAL' })]
      },
      files: [
        {
          file: '/w/b.ts',
          scanId: 'file-1',
          engine: 'local',
          scanTypes: ['sast'],
          findings: [finding({ key: 'file', file: '/w/b.ts', relativeFile: 'b.ts', engine: 'local' })]
        }
      ],
      realtime: [
        {
          file: '/w/c.ts',
          scanId: 'realtime-1',
          findings: [finding({ key: 'realtime', file: '/w/c.ts', relativeFile: 'c.ts', mode: 'realtime', engine: 'local' })]
        }
      ]
    },
    history: [latest],
    latest
  };
  const service = makeService(root, storage, state, serverRunner([]));
  try {
    await service.initialize();
    assert.deepEqual(service.getFindings().map((item) => item.key), ['project']);
    assert.deepEqual(service.getRealtimeFindings().map((item) => item.key), ['realtime']);
    assert.deepEqual(service.getDiagnosticFindings().map((item) => item.key).sort(), ['file', 'project', 'realtime']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});