import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BridgeClient } from '../mcp/bridgeClient';
import { McpBridge } from '../mcp/bridge';
import { createCheckmarxServer } from '../mcp/server-core';
import type { ScanApi } from '../mcp/protocol';
import { noopLogger } from '../logging';
import { emptyCounts } from '../severity';
import type { Finding, ScanState, ScanSummary } from '../types';

const workspace = '/workspace/project';
const sampleFinding: Finding = {
  key: 'finding-1',
  id: '123',
  scanId: 'scan-1',
  mode: 'project',
  engine: 'local',
  type: 'sast',
  severity: 'HIGH',
  title: 'SQL Injection',
  description: 'User input reaches a SQL query.',
  remediation: 'Use parameterized queries.',
  file: `${workspace}/app.py`,
  relativeFile: 'app.py',
  line: 7,
  cweId: 'CWE-89',
  codeSnippet: 'cursor.execute(query)',
  nodes: [{ file: `${workspace}/app.py`, line: 7, name: 'query' }]
};

function sampleSummary(overrides: Partial<ScanSummary> = {}): ScanSummary {
  return {
    id: 'scan-1',
    mode: 'project',
    engine: 'local',
    status: 'completed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    scanTypes: ['sast'],
    counts: { ...emptyCounts(), HIGH: 1 },
    totalFindings: 1,
    ...overrides
  };
}

function fakeApi(observed?: { fileEngine?: string }): ScanApi {
  const state: ScanState = {
    active: undefined,
    latest: sampleSummary(),
    authenticated: true,
    cliAvailable: true,
    cliPath: '/usr/bin/cx',
    cliVersion: '2.3.69',
    realtimeEnabled: false,
    findings: [sampleFinding],
    counts: { ...emptyCounts(), HIGH: 1 },
    total: 1,
    history: [sampleSummary()]
  };

  return {
    getState: async () => state,
    scanProject: async () => sampleSummary({ id: 'scan-2' }),
    scanFile: async (_file, options) => {
      if (observed) {
        observed.fileEngine = options?.engine;
      }
      return sampleSummary({ id: 'scan-3', mode: 'file', file: `${workspace}/app.py`, relativeFile: 'app.py' });
    },
    getResults: async (query) => {
      const filtered = query.severity?.length
        ? [sampleFinding].filter((finding) => query.severity!.includes(finding.severity))
        : [sampleFinding];
      return {
        scan: state.latest,
        findings: filtered,
        total: filtered.length,
        counts: { ...emptyCounts(), HIGH: filtered.length }
      };
    },
    getFinding: async (key) =>
      key === sampleFinding.key || key === sampleFinding.id
        ? { finding: sampleFinding, codeContext: '1 | cursor.execute(query)', codeStartLine: 1, codeEndLine: 1, fileExists: true }
        : undefined,
    getFileFindings: (file) => (file === sampleFinding.file ? [sampleFinding] : []),
    listScans: () => [sampleSummary()],
    cancel: async () => true,
    getFiles: () => [
      {
        file: `${workspace}/app.py`,
        relativeFile: 'app.py',
        findings: 1,
        counts: { ...emptyCounts(), HIGH: 1 },
        highestSeverity: 'HIGH'
      }
    ],
    reveal: async () => undefined,
    clearResults: async () => undefined
  };
}

test('MCP bridge serves results with bearer token auth', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cx-bridge-'));
  const bridge = new McpBridge({
    api: fakeApi(),
    version: '0.0.1-test',
    workspace,
    storageRoot: storage,
    logger: noopLogger
  });

  try {
    const info = await bridge.start();

    const unauthorized = await fetch(`${info.url}/api/state`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${info.url}/api/results?severity=HIGH&limit=10`, {
      headers: { 'x-checkmarx-bridge-token': info.token }
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { findings: Finding[]; total: number };
    assert.equal(payload.total, 1);
    assert.equal(payload.findings[0]!.key, 'finding-1');

    const outside = await fetch(`${info.url}/api/scan/file`, {
      method: 'POST',
      headers: { 'x-checkmarx-bridge-token': info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ file: '/etc/passwd' })
    });
    assert.equal(outside.status, 400);
  } finally {
    await bridge.stop();
    await rm(storage, { recursive: true, force: true });
  }
});

test('MCP server exposes tools and returns structured results', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cx-bridge-'));
  const observed: { fileEngine?: string } = {};
  const bridge = new McpBridge({
    api: fakeApi(observed),
    version: '0.0.1-test',
    workspace,
    storageRoot: storage,
    logger: noopLogger
  });
  const info = await bridge.start();
  const bridgeClient = new BridgeClient({
    CHECKMARX_BRIDGE_URL: info.url,
    CHECKMARX_BRIDGE_TOKEN: info.token
  });
  const server = createCheckmarxServer(bridgeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'checkmarx-test', version: '1.0.0' });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('checkmarx_get_results'));
    assert.ok(names.includes('checkmarx_scan_file'));
    assert.ok(names.includes('checkmarx_get_finding'));

    const fileTool = tools.tools.find((tool) => tool.name === 'checkmarx_scan_file');
    const schema = fileTool?.inputSchema as { properties?: Record<string, { enum?: string[] }> } | undefined;
    assert.deepEqual(schema?.properties?.engine?.enum, ['local', 'cloud']);

    const result = (await client.callTool({
      name: 'checkmarx_get_results',
      arguments: { severity: ['HIGH'], limit: 10 }
    })) as { content: Array<{ type: string; text?: string }>; structuredContent?: { total?: number } };
    assert.equal(result.structuredContent?.total, 1);
    assert.match(result.content[0]?.text ?? '', /SQL Injection/);

    const detail = (await client.callTool({
      name: 'checkmarx_get_finding',
      arguments: { key: 'finding-1' }
    })) as { content: Array<{ type: string; text?: string }> };
    assert.match(detail.content[0]?.text ?? '', /parameterized/i);

    await client.callTool({
      name: 'checkmarx_scan_file',
      arguments: { file: 'app.py', engine: 'cloud' }
    });
    assert.equal(observed.fileEngine, 'cloud');
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await bridge.stop();
    await rm(storage, { recursive: true, force: true });
  }
});