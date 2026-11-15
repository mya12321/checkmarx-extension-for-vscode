import { readFile } from 'node:fs/promises';
import type {
  FileSummary,
  Finding,
  FindingDetails,
  ResultsQuery,
  ResultsResponse,
  ScanEngine,
  ScanSummary
} from '../types';
import type { BridgeScanResponse, BridgeState } from './protocol';

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly code = 'BRIDGE_ERROR',
    public readonly status?: number
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

interface BridgeConfig {
  url: string;
  token: string;
}

interface BridgeFileConfig {
  url?: string;
  token?: string;
}

export class BridgeClient {
  private cached?: BridgeConfig;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async health(): Promise<Record<string, unknown>> {
    return await this.request('GET', '/api/health', { timeoutMs: 5000 });
  }

  async getState(): Promise<BridgeState> {
    return await this.request('GET', '/api/state');
  }

  async scanProject(options: { engine?: ScanEngine; scanTypes?: string[]; wait?: boolean }): Promise<BridgeScanResponse> {
    return await this.request('POST', '/api/scan/project', {
      body: {
        engine: options.engine,
        scanTypes: options.scanTypes,
        wait: options.wait !== false
      },
      timeoutMs: 45 * 60 * 1000
    });
  }

  async scanFile(file: string, options: { engine?: 'local' | 'cloud'; wait?: boolean } = {}): Promise<BridgeScanResponse> {
    return await this.request('POST', '/api/scan/file', {
      body: { file, engine: options.engine, wait: options.wait !== false },
      timeoutMs: 45 * 60 * 1000
    });
  }

  async getResults(query: ResultsQuery): Promise<ResultsResponse> {
    const params = new URLSearchParams();
    if (query.scanId) {
      params.set('scanId', query.scanId);
    }
    if (query.severity?.length) {
      params.set('severity', query.severity.join(','));
    }
    if (query.type) {
      params.set('type', query.type);
    }
    if (query.file) {
      params.set('file', query.file);
    }
    if (query.state) {
      params.set('state', query.state);
    }
    if (query.limit !== undefined) {
      params.set('limit', String(query.limit));
    }
    if (query.includeFlow) {
      params.set('includeFlow', '1');
    }
    return await this.request('GET', `/api/results?${params.toString()}`);
  }

  async getFinding(key: string, includeCode = true): Promise<FindingDetails | undefined> {
    const params = new URLSearchParams({ key, includeCode: includeCode ? '1' : '0' });
    const response = await this.request<{ finding?: FindingDetails }>('GET', `/api/finding?${params.toString()}`);
    return response.finding;
  }

  async getFileFindings(file: string): Promise<{ file: string; relativeFile: string; findings: Finding[]; total: number }> {
    const params = new URLSearchParams({ file });
    return await this.request('GET', `/api/file-findings?${params.toString()}`);
  }

  async listScans(limit = 20): Promise<ScanSummary[]> {
    const response = await this.request<{ scans: ScanSummary[] }>('GET', `/api/scans?limit=${limit}`);
    return response.scans;
  }

  async getFiles(): Promise<FileSummary[]> {
    const response = await this.request<{ files: FileSummary[] }>('GET', '/api/files');
    return response.files;
  }

  async cancel(scanId?: string): Promise<boolean> {
    const response = await this.request<{ cancelled: boolean }>('POST', '/api/cancel', {
      body: { scanId }
    });
    return response.cancelled;
  }

  async reveal(file: string, line?: number, column?: number): Promise<void> {
    await this.request('POST', '/api/reveal', { body: { file, line, column } });
  }

  async clearResults(): Promise<void> {
    await this.request('POST', '/api/clear');
  }

  private async request<T>(
    method: string,
    pathName: string,
    options: { body?: unknown; timeoutMs?: number; retry?: boolean } = {}
  ): Promise<T> {
    const config = await this.getConfig();
    try {
      return await this.send<T>(config, method, pathName, options);
    } catch (error) {
      const retryable =
        error instanceof BridgeError && (error.status === 401 || error.code === 'UNREACHABLE' || error.code === 'TIMEOUT');
      if (options.retry === false || !retryable) {
        throw error;
      }
      this.cached = undefined;
      const reloaded = await this.getConfig(true);
      if (reloaded.url === config.url && reloaded.token === config.token) {
        throw error;
      }
      return await this.send<T>(reloaded, method, pathName, options);
    }
  }

  private async send<T>(
    config: BridgeConfig,
    method: string,
    pathName: string,
    options: { body?: unknown; timeoutMs?: number }
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(`${config.url}${pathName}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-checkmarx-bridge-token': config.token
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new BridgeError(`Invalid response from Checkmarx bridge: ${text.slice(0, 300)}`, 'BAD_RESPONSE', response.status);
      }

      if (!response.ok) {
        const errorBody = payload as { error?: { code?: string; message?: string } };
        throw new BridgeError(
          errorBody.error?.message ?? `Checkmarx bridge returned HTTP ${response.status}`,
          errorBody.error?.code ?? 'HTTP_ERROR',
          response.status
        );
      }

      return payload as T;
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BridgeError(
          `Checkmarx bridge request timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          'TIMEOUT'
        );
      }
      throw new BridgeError(
        `Unable to reach the Checkmarx VS Code extension: ${error instanceof Error ? error.message : String(error)}. Make sure the Checkmarx extension is running and the workspace is open.`,
        'UNREACHABLE'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async getConfig(preferFile = false): Promise<BridgeConfig> {
    if (this.cached && !preferFile) {
      return this.cached;
    }

    const file = this.env.CHECKMARX_BRIDGE_FILE?.trim();
    if (preferFile && file) {
      const fromFile = await this.readFileConfig(file);
      if (fromFile) {
        this.cached = fromFile;
        return fromFile;
      }
    }

    const url = this.env.CHECKMARX_BRIDGE_URL?.trim();
    const token = this.env.CHECKMARX_BRIDGE_TOKEN?.trim();
    if (url && token) {
      this.cached = { url, token };
      return this.cached;
    }

    if (!file) {
      throw new BridgeError(
        'Checkmarx bridge configuration is missing. Start VS Code with the Checkmarx Local extension enabled.',
        'NO_CONFIG'
      );
    }

    const fromFile = await this.readFileConfig(file);
    if (fromFile) {
      this.cached = fromFile;
      return fromFile;
    }
    throw new BridgeError('Unable to read the Checkmarx bridge configuration.', 'NO_CONFIG');
  }

  private async readFileConfig(file: string): Promise<BridgeConfig | undefined> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as BridgeFileConfig;
      if (!parsed.url || !parsed.token) {
        return undefined;
      }
      return { url: parsed.url, token: parsed.token };
    } catch {
      return undefined;
    }
  }
}