import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import type { LoggerLike } from '../logging';
import { normalizeSlashes } from '../paths';
import type { Finding, ResultsQuery, ScanSummary, Severity } from '../types';
import { BRIDGE_TOKEN_HEADER, publicScan, stateToBridge, type BridgeCancelRequest, type BridgeFileScanRequest, type BridgeProjectScanRequest, type BridgeRevealRequest, type ScanApi } from './protocol';
import { bridgeInfoPath, removeBridgeInfo, writeBridgeInfo } from '../scans/stateStore';

const MAX_BODY_BYTES = 1024 * 1024;

export interface BridgeOptions {
  api: ScanApi;
  version: string;
  workspace: string;
  storageRoot: string;
  logger: LoggerLike;
}

export interface BridgeInfoInternal {
  url: string;
  token: string;
  port: number;
  file: string;
}

export class McpBridge {
  private server?: http.Server;
  private readonly token = randomBytes(32).toString('hex');
  private info?: BridgeInfoInternal;

  constructor(private readonly options: BridgeOptions) {}

  get bridgeInfo(): BridgeInfoInternal | undefined {
    return this.info;
  }

  async start(): Promise<BridgeInfoInternal> {
    if (this.info) {
      return this.info;
    }

    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.stop();
      throw new Error('Unable to determine the MCP bridge port');
    }

    const url = `http://127.0.0.1:${address.port}`;
    const info = {
      url,
      token: this.token,
      port: address.port,
      file: ''
    };
    try {
      const file = await writeBridgeInfo(this.options.storageRoot, {
        url,
        token: this.token,
        pid: process.pid,
        version: this.options.version,
        workspace: this.options.workspace,
        startedAt: new Date().toISOString()
      });
      info.file = file;
      this.info = info;
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.options.logger.info(`MCP bridge listening on ${url}`);
    return info;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.info = undefined;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    }
    try {
      const bridgeFile = bridgeInfoPath(this.options.storageRoot, this.options.workspace);
      const parsed = JSON.parse(await readFile(bridgeFile, 'utf8')) as { token?: string };
      if (parsed.token === this.token) {
        await removeBridgeInfo(this.options.storageRoot, this.options.workspace);
      }
    } catch {
      await removeBridgeInfo(this.options.storageRoot, this.options.workspace).catch(() => undefined);
    }
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (!isLoopback(request.socket.remoteAddress)) {
        throw new HttpError(403, 'FORBIDDEN', 'Only local connections are allowed');
      }
      if (!this.authorized(request)) {
        throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid MCP bridge token');
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = request.method ?? 'GET';

      if (method === 'GET' && pathname === '/api/health') {
        this.send(response, 200, {
          ok: true,
          version: this.options.version,
          workspace: this.options.workspace,
          pid: process.pid
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/state') {
        const state = await this.options.api.getState();
        this.send(response, 200, stateToBridge(state, this.options.version, this.options.workspace));
        return;
      }

      if (method === 'POST' && pathname === '/api/scan/project') {
        const body = await readJson<BridgeProjectScanRequest>(request);
        const engine = body.engine === 'local' ? 'local' : body.engine === 'cloud' ? 'cloud' : undefined;
        const result = await this.scanWithWait(
          () => this.options.api.scanProject({ engine, scanTypes: body.scanTypes, wait: body.wait !== false }),
          body.wait !== false
        );
        this.send(response, 200, result);
        return;
      }

      if (method === 'POST' && pathname === '/api/scan/file') {
        const body = await readJson<BridgeFileScanRequest>(request);
        if (!body.file) {
          throw new HttpError(400, 'BAD_REQUEST', 'file is required');
        }
        const file = this.resolveFile(body.file);
        const engine = body.engine === 'local' ? 'local' : body.engine === 'cloud' ? 'cloud' : undefined;
        const result = await this.scanWithWait(
          () => this.options.api.scanFile(file, { engine, wait: body.wait !== false }),
          body.wait !== false
        );
        this.send(response, 200, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/results') {
        const query = parseResultsQuery(url);
        const result = await this.options.api.getResults(query);
        this.send(response, 200, {
          ...result,
          scan: publicScan(result.scan),
          findings: result.findings.map((finding) => trimFinding(finding, query.includeFlow === true))
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/finding') {
        const key = url.searchParams.get('key') ?? url.searchParams.get('id');
        if (!key) {
          throw new HttpError(400, 'BAD_REQUEST', 'key is required');
        }
        const includeCode = url.searchParams.get('includeCode') !== '0';
        const details = await this.options.api.getFinding(key, includeCode);
        this.send(response, 200, details ? { finding: { ...details, finding: trimFinding(details.finding, true) } } : {});
        return;
      }

      if (method === 'GET' && pathname === '/api/file-findings') {
        const requested = url.searchParams.get('file');
        if (!requested) {
          throw new HttpError(400, 'BAD_REQUEST', 'file is required');
        }
        const file = this.resolveFile(requested);
        const source = url.searchParams.get('source') === 'realtime' ? 'realtime' : 'scan';
        const findings = this.options.api.getFileFindings(file, source).map((finding) => trimFinding(finding, true));
        this.send(response, 200, {
          file,
          relativeFile: normalizeSlashes(path.relative(this.options.workspace, file)),
          source,
          findings,
          total: findings.length
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/scans') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        this.send(response, 200, { scans: this.options.api.listScans(limit) });
        return;
      }

      if (method === 'GET' && pathname === '/api/files') {
        const source = url.searchParams.get('source') === 'realtime' ? 'realtime' : 'scan';
        this.send(response, 200, { source, files: this.options.api.getFiles(source) });
        return;
      }

      if (method === 'POST' && pathname === '/api/cancel') {
        const body = await readJson<BridgeCancelRequest>(request);
        const cancelled = await this.options.api.cancel(body.scanId);
        this.send(response, 200, { cancelled });
        return;
      }

      if (method === 'POST' && pathname === '/api/reveal') {
        const body = await readJson<BridgeRevealRequest>(request);
        if (!body.file) {
          throw new HttpError(400, 'BAD_REQUEST', 'file is required');
        }
        await this.options.api.reveal(this.resolveFile(body.file), body.line, body.column);
        this.send(response, 200, { ok: true });
        return;
      }

      if (method === 'POST' && pathname === '/api/clear') {
        await this.options.api.clearResults();
        this.send(response, 200, { ok: true });
        return;
      }

      throw new HttpError(404, 'NOT_FOUND', `Unknown endpoint ${method} ${pathname}`);
    } catch (error) {
      if (error instanceof HttpError) {
        this.send(response, error.status, { error: { code: error.code, message: error.message, details: error.details } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error(`MCP bridge error: ${message}`);
      if (!response.headersSent) {
        this.send(response, 500, { error: { code: 'INTERNAL_ERROR', message } });
      } else {
        response.end();
      }
    }
  }

  private async scanWithWait(
    start: () => Promise<ScanSummary>,
    wait: boolean
  ): Promise<{ scan: ScanSummary; waiting: boolean }> {
    let error: unknown;
    let finished = false;
    const promise = start().then(
      (scan) => {
        finished = true;
        return scan;
      },
      (rejection) => {
        finished = true;
        error = rejection;
        throw rejection;
      }
    );
    // Prevent an unhandled rejection when the caller does not wait.
    promise.catch(() => undefined);

    if (wait) {
      return { scan: publicScan(await promise) ?? (await promise), waiting: false };
    }

    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (error) {
        throw error;
      }
      const state = await this.options.api.getState();
      if (state.active) {
        return { scan: publicScan(state.active) ?? state.active, waiting: true };
      }
      if (finished) {
        return { scan: publicScan(await promise) ?? (await promise), waiting: false };
      }
      await sleep(100);
    }

    return { scan: publicScan(await promise) ?? (await promise), waiting: false };
  }

  private resolveFile(input: string): string {
    const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.options.workspace, input);
    const relative = path.relative(path.resolve(this.options.workspace), absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new HttpError(400, 'BAD_REQUEST', `File is outside the workspace: ${input}`);
    }
    return absolute;
  }

  private authorized(request: http.IncomingMessage): boolean {
    const header = request.headers[BRIDGE_TOKEN_HEADER];
    const authorization = request.headers.authorization;
    const provided =
      (Array.isArray(header) ? header[0] : header) ??
      (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7)
        : undefined);
    if (!provided) {
      return false;
    }
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private send(response: http.ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    const payload = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Length', Buffer.byteLength(payload));
    response.end(payload);
  }
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    return {} as T;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Request body must be valid JSON');
  }
}

function parseResultsQuery(url: URL): ResultsQuery {
  const severityValues = (url.searchParams.get('severity') ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is Severity => ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(value));
  const type = url.searchParams.get('type') ?? undefined;
  const allowedTypes = ['sast', 'sca', 'iac', 'secret', 'other'];
  const limitValue = Number(url.searchParams.get('limit'));
  return {
    scanId: url.searchParams.get('scanId') ?? undefined,
    source: url.searchParams.get('source') === 'realtime' ? 'realtime' : 'scan',
    severity: severityValues.length > 0 ? severityValues : undefined,
    type: type && allowedTypes.includes(type) ? (type as ResultsQuery['type']) : undefined,
    file: url.searchParams.get('file') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    limit: Number.isFinite(limitValue) && limitValue > 0 ? Math.min(500, limitValue) : undefined,
    includeFlow: url.searchParams.get('includeFlow') === '1' || url.searchParams.get('includeFlow') === 'true'
  };
}

function trimFinding(finding: Finding, includeFlow: boolean): Finding {
  const copy: Finding = { ...finding };
  delete copy.raw;
  copy.nodes = includeFlow ? copy.nodes : undefined;
  return copy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopback(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
