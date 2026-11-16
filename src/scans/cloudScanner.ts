import type { LoggerLike } from '../logging';
import type { ScanProgress } from '../types';
import { asString, asRecord } from '../findings/util';
import { normalizeCloudResults } from '../findings/normalizeCloud';
import { enrichFindingsWithCode } from '../findings/enrich';
import type { AuthConfig, Finding } from '../types';
import type { CxCli } from '../cli/client';
import { collectGitignoreExclusions } from './gitignore';

export interface CloudScanOptions {
  root: string;
  projectName: string;
  applicationName: string;
  branch: string;
  scanTypes: string[];
  fileFilter?: string;
  auth: AuthConfig;
  signal: AbortSignal;
  timeoutMs: number;
  pollIntervalMs: number;
  mode: 'project' | 'file';
  scanId: string;
  outputDirectory: string;
  onProgress?: (progress: ScanProgress) => void;
  onCloudScanCreated?: (cloudScanId: string) => void;
  logger: LoggerLike;
}

export interface CloudScanResult {
  cloudScanId: string;
  findings: Finding[];
  scanInfo?: Record<string, unknown>;
}

const SUCCESS_STATUSES = new Set(['completed', 'partial']);
const FAILURE_STATUSES = new Set(['failed', 'canceled', 'cancelled', 'aborted', 'error']);

export async function runCloudScan(cli: CxCli, options: CloudScanOptions): Promise<CloudScanResult> {
  // Project uploads keep `.git` out and apply every `.gitignore` in the tree.
  // The CLI's own `--use-gitignore` only understands the root file, so the
  // exclusions are computed here and passed as Ant deny patterns instead.
  const projectWide = options.mode === 'project';
  const gitignore = projectWide
    ? await collectGitignoreExclusions(options.root, { signal: options.signal })
    : undefined;
  if (gitignore?.patterns.length) {
    options.logger.info(`Excluding ${gitignore.patterns.length} git-ignored path(s) from the cloud upload`);
  }
  if (gitignore?.truncated) {
    options.logger.warn(
      'Stopped collecting .gitignore exclusions after reaching the safety limit; some ignored files may still be uploaded.'
    );
  }

  const created = await cli.createCloudScan(
    {
      root: options.root,
      projectName: options.projectName,
      applicationName: options.applicationName,
      branch: options.branch,
      scanTypes: options.scanTypes,
      fileFilter: options.fileFilter,
      excludeGitFolder: projectWide,
      fileFilterExt: gitignore?.patterns,
      auth: options.auth
    },
    {
      signal: options.signal,
      onStdout: (chunk) => options.logger.debug(`scan create: ${chunk.trim()}`),
      onStderr: (chunk) => options.logger.debug(`scan create: ${chunk.trim()}`)
    }
  );

  const cloudScanId = asString(created.id) ?? asString(created.ID);
  if (!cloudScanId) {
    throw new Error('The CLI created a scan but did not return its id');
  }

  options.onCloudScanCreated?.(cloudScanId);
  options.logger.info(`Created Checkmarx cloud scan ${cloudScanId} for project "${options.projectName}"`);
  options.onProgress?.({
    message: `Queued cloud scan ${cloudScanId}`,
    current: 0
  });

  const deadline = Date.now() + options.timeoutMs;
  let lastStatus = '';
  let scanInfo: Record<string, unknown> | undefined;

  try {
    for (;;) {
      if (options.signal.aborted) {
        await cli.cancelCloudScan(cloudScanId, options.auth);
        throw abortError();
      }
      if (Date.now() > deadline) {
        await cli.cancelCloudScan(cloudScanId, options.auth);
        throw new Error(`Cloud scan ${cloudScanId} exceeded the ${Math.round(options.timeoutMs / 60000)} minute timeout`);
      }

      scanInfo = await cli.getCloudScan(cloudScanId, options.auth, options.signal);
      const status = asString(scanInfo.status) ?? asString(scanInfo.Status) ?? '';
      const normalized = status.toLowerCase();
      if (normalized !== lastStatus) {
        lastStatus = normalized;
        options.logger.info(`Cloud scan ${cloudScanId} status: ${status || 'unknown'}`);
        options.onProgress?.({
          message: `Cloud scan ${cloudScanId}: ${status || 'waiting'}`,
          current: 1
        });
      }

      if (SUCCESS_STATUSES.has(normalized)) {
        break;
      }
      if (FAILURE_STATUSES.has(normalized)) {
        const detail = asString(scanInfo.error) ?? asString(scanInfo.message) ?? status;
        throw new Error(`Cloud scan ${cloudScanId} ended with status ${status}${detail ? `: ${detail}` : ''}`);
      }

      await sleep(options.pollIntervalMs, options.signal);
    }
  } catch (error) {
    if (options.signal.aborted) {
      await cli.cancelCloudScan(cloudScanId, options.auth);
    }
    throw error;
  }

  options.onProgress?.({ message: 'Downloading cloud scan results…', current: 2 });

  const resultsFile = await cli.fetchCloudResults(
    cloudScanId,
    options.auth,
    options.outputDirectory,
    options.signal
  );

  const findings = await enrichFindingsWithCode(
    normalizeCloudResults(resultsFile.payload, {
      root: options.root,
      scanId: options.scanId,
      mode: options.mode,
      engine: 'cloud'
    })
  );

  options.logger.info(`Cloud scan ${cloudScanId} returned ${findings.length} findings`);
  return { cloudScanId, findings, scanInfo };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const error = new Error('Scan cancelled');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Scan cancelled');
}

export function cloudStatusOf(scanInfo: Record<string, unknown> | undefined): string {
  if (!scanInfo) {
    return '';
  }
  const nested = asRecord(scanInfo.scan);
  return asString(nested?.status) ?? asString(scanInfo.status) ?? '';
}
