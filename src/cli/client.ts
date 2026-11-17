import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { extractJson, lastNonEmptyLine } from '../json';
import { redactSecrets, type LoggerLike } from '../logging';
import { normalizeSlashes, safeBaseName, truncate } from '../paths';
import type { AuthConfig } from '../types';
import {
  ascaScanArgs,
  authValidateArgs,
  cloudCancelArgs,
  cloudResultsArgs,
  cloudScanCreateArgs,
  cloudScanShowArgs,
  versionArgs
} from './args';
import { CliError, type CliRunner, type RunOptions, type RunResult } from './runner';

export interface CloudScanRequest {
  root: string;
  projectName: string;
  applicationName?: string;
  branch: string;
  scanTypes: string[];
  fileFilter?: string;
  excludeGitFolder?: boolean;
  fileFilterExt?: string[];
  auth: AuthConfig;
}

export interface CloudResultsFile {
  payload: unknown;
  filePath: string;
}

const AUTH_ENV_KEYS = [
  'CX_APIKEY',
  'CX_BASE_URI',
  'CX_BASE_AUTH_URI',
  'CX_TENANT',
  'CX_CLIENT_ID',
  'CX_CLIENT_SECRET'
];

/**
 * The CLI defaults its per-request network timeout to 30 seconds in 2.3.x.
 * `cx results show` fetches the complete result list in pages, and a slow page
 * (large scans over a high-latency link) otherwise fails with
 * "context deadline exceeded ... while reading body".
 */
const DEFAULT_CLIENT_TIMEOUT_SECONDS = '120';

export class CxCli {
  constructor(
    private readonly cliPath: string,
    private readonly runner: CliRunner,
    private readonly logger: LoggerLike,
    private readonly getExtraArgs: () => string[] = () => []
  ) {}

  get path(): string {
    return this.cliPath;
  }

  async version(signal?: AbortSignal): Promise<string> {
    const result = await this.run(versionArgs(), { signal, timeoutMs: 20_000 });
    const text = `${result.stdout}\n${result.stderr}`;
    const match = text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    if (!match) {
      throw new CliError('Unable to determine Checkmarx CLI version', result);
    }
    return match[1]!;
  }

  async validateAuth(auth: AuthConfig, signal?: AbortSignal): Promise<void> {
    const result = await this.run(authValidateArgs(this.getExtraArgs()), {
      signal,
      timeoutMs: 90_000,
      env: this.buildEnv(auth)
    });
    if (result.code !== 0) {
      throw this.failure('Checkmarx authentication failed', result);
    }
    this.logger.info('Checkmarx API key validated successfully');
  }

  async createCloudScan(request: CloudScanRequest, options: RunOptions = {}): Promise<Record<string, unknown>> {
    const result = await this.run(
      cloudScanCreateArgs({
        root: request.root,
        projectName: request.projectName,
        applicationName: request.applicationName,
        branch: request.branch,
        scanTypes: request.scanTypes,
        fileFilter: request.fileFilter,
        excludeGitFolder: request.excludeGitFolder,
        fileFilterExt: request.fileFilterExt,
        extraArgs: this.getExtraArgs()
      }),
      {
        ...options,
        timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
        env: this.buildEnv(request.auth)
      }
    );
    if (result.code !== 0) {
      throw this.failure('Failed to create Checkmarx scan', result);
    }
    const payload = extractJson<Record<string, unknown>>(result.stdout);
    if (!payload.id && !payload.ID) {
      throw new Error(`The CLI did not return a scan id: ${truncate(result.stdout, 800)}`);
    }
    return payload;
  }

  async getCloudScan(scanId: string, auth: AuthConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.run(cloudScanShowArgs(scanId, this.getExtraArgs()), {
      signal,
      timeoutMs: 90_000,
      env: this.buildEnv(auth)
    });
    if (result.code !== 0) {
      throw this.failure(`Failed to get scan ${scanId}`, result);
    }
    return extractJson<Record<string, unknown>>(result.stdout);
  }

  async fetchCloudResults(scanId: string, auth: AuthConfig, outputDir: string, signal?: AbortSignal): Promise<CloudResultsFile> {
    await mkdir(outputDir, { recursive: true });
    const outputName = `results-${safeBaseName(scanId)}`;
    const expected = path.join(outputDir, `${outputName}.json`);
    await rm(expected, { force: true });

    const result = await this.run(cloudResultsArgs(scanId, outputDir, outputName, this.getExtraArgs()), {
      signal,
      timeoutMs: 10 * 60 * 1000,
      env: this.buildEnv(auth)
    });

    if (result.code !== 0) {
      throw this.failure(`Failed to download results for scan ${scanId}`, result);
    }

    let resultsPath = expected;
    try {
      await readFile(expected);
    } catch {
      resultsPath = await this.findJsonOutput(outputDir, outputName);
    }

    const content = await readFile(resultsPath, 'utf8');
    return {
      payload: extractJson(content),
      filePath: resultsPath
    };
  }

  async listProjects(auth: AuthConfig, offset: number, limit: number, signal?: AbortSignal): Promise<unknown[]> {
    const result = await this.run(
      ['project', 'list', '--format', 'json', '--filter', `offset=${offset}`, '--filter', `limit=${limit}`],
      { signal, timeoutMs: 60_000, env: this.buildEnv(auth) }
    );
    if (result.code !== 0) {
      throw this.failure('Failed to list Checkmarx projects', result);
    }
    if (!result.stdout.trim()) {
      return [];
    }
    const payload = extractJson<unknown>(result.stdout);
    return Array.isArray(payload) ? payload : [];
  }

  async listScans(projectId: string, auth: AuthConfig, signal?: AbortSignal, limit = 20): Promise<unknown[]> {
    const result = await this.run(
      ['scan', 'list', '--format', 'json', '--filter', `project-id=${projectId}`, '--filter', `limit=${limit}`],
      { signal, timeoutMs: 60_000, env: this.buildEnv(auth) }
    );
    if (result.code !== 0) {
      throw this.failure('Failed to list Checkmarx scans', result);
    }
    if (!result.stdout.trim()) {
      return [];
    }
    const payload = extractJson<unknown>(result.stdout);
    return Array.isArray(payload) ? payload : [];
  }

  async scanAsca(file: string, signal?: AbortSignal, timeoutMs = 15 * 60 * 1000): Promise<unknown> {
    const result = await this.run(ascaScanArgs(file, this.getExtraArgs()), {
      signal,
      timeoutMs,
      // Local scans deliberately run without cloud credentials. The local
      // engine does not need an API key, and this prevents any stale tenant
      // credential from influencing the scan.
      env: this.buildEnv(undefined)
    });
    if (result.code !== 0) {
      throw this.failure('Local ASCA scan failed', result);
    }
    return extractJson(result.stdout);
  }

  async cancelCloudScan(scanId: string, auth: AuthConfig, signal?: AbortSignal): Promise<void> {
    try {
      const result = await this.run(cloudCancelArgs(scanId, this.getExtraArgs()), {
        signal,
        timeoutMs: 60_000,
        env: this.buildEnv(auth)
      });
      if (result.code !== 0) {
        this.logger.warn(`Cancel scan ${scanId} exited with code ${result.code}`);
      }
    } catch (error) {
      this.logger.warn(`Unable to cancel scan ${scanId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const result = await this.runner.run(this.cliPath, args, {
      ...options,
      env: options.env ?? this.buildEnv(undefined)
    });
    if (result.aborted) {
      const error = new Error('Scan cancelled');
      error.name = 'AbortError';
      throw error;
    }
    return result;
  }

  buildEnv(auth: AuthConfig | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of AUTH_ENV_KEYS) {
      delete env[key];
    }
    // Keep an explicit override from the environment, but never leave the CLI
    // on its short default when downloading a large result set.
    if (!env.CX_TIMEOUT?.trim()) {
      env.CX_TIMEOUT = DEFAULT_CLIENT_TIMEOUT_SECONDS;
    }

    if (auth) {
      env.CX_APIKEY = auth.apiKey;
      if (auth.baseUri) {
        env.CX_BASE_URI = auth.baseUri;
      }
      if (auth.baseAuthUri) {
        env.CX_BASE_AUTH_URI = auth.baseAuthUri;
      }
      if (auth.tenant) {
        env.CX_TENANT = auth.tenant;
      }
    }

    return env;
  }

  private async findJsonOutput(outputDir: string, outputName: string): Promise<string> {
    const files = await readdir(outputDir);
    const preferred = files.find((file) => file === `${outputName}.json`);
    if (preferred) {
      return path.join(outputDir, preferred);
    }
    const anyJson = files.filter((file) => file.toLowerCase().endsWith('.json')).sort();
    if (anyJson.length === 0) {
      throw new Error(`The CLI did not create a JSON report in ${normalizeSlashes(outputDir)}`);
    }
    return path.join(outputDir, anyJson[anyJson.length - 1]!);
  }

  private failure(message: string, result: RunResult): CliError {
    const detail = lastNonEmptyLine(result.stderr) || lastNonEmptyLine(result.stdout);
    const suffix = detail ? `: ${redactSecrets(detail)}` : '';
    return new CliError(`${message}${suffix}`, result);
  }
}