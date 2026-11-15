import type { LoggerLike } from '../logging';
import type { Finding, ScanMode, ScanProgress } from '../types';
import type { CxCli } from '../cli/client';
import { ascaErrorMessage, normalizeAscaResults } from '../findings/normalizeAsca';
import { isAbortError, abortError } from './cloudScanner';

export interface LocalFileScanOptions {
  root: string;
  scanId: string;
  mode: ScanMode;
  /** File whose contents were scanned. ASCA only returns the basename. */
  reportedFile: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface LocalProjectScanResult {
  findings: Finding[];
  errors: Array<{ file: string; message: string }>;
}

export class LocalScanner {
  constructor(
    private readonly cli: CxCli,
    private readonly logger: LoggerLike
  ) {}

  async scanFile(scannedFile: string, options: LocalFileScanOptions): Promise<Finding[]> {
    this.logger.debug(`ASCA scanning ${scannedFile}`);
    const payload = await this.cli.scanAsca(scannedFile, options.signal, options.timeoutMs);
    const error = ascaErrorMessage(payload);
    if (error) {
      throw new Error(`ASCA: ${error}`);
    }
    return normalizeAscaResults(payload, {
      root: options.root,
      scanId: options.scanId,
      mode: options.mode,
      engine: 'local',
      reportedFile: options.reportedFile
    });
  }

  async scanProject(
    files: string[],
    options: {
      root: string;
      scanId: string;
      mode: 'project';
      signal: AbortSignal;
      concurrency: number;
      onProgress?: (progress: ScanProgress) => void;
    }
  ): Promise<LocalProjectScanResult> {
    const findings: Finding[] = [];
    const errors: Array<{ file: string; message: string }> = [];
    let nextIndex = 0;
    let completed = 0;

    // Warm up the local engine with one file before starting parallel workers.
    // The first ASCA invocation may download/start the engine; concurrent
    // downloads can race on the CLI's engine installation directory.
    if (files.length > 1 && options.concurrency > 1) {
      const first = files[0]!;
      try {
        const payload = await this.cli.scanAsca(first, options.signal);
        const error = ascaErrorMessage(payload);
        if (error) {
          throw new Error(error);
        }
        findings.push(
          ...normalizeAscaResults(payload, {
            root: options.root,
            scanId: options.scanId,
            mode: 'project',
            engine: 'local',
            reportedFile: first
          })
        );
      } catch (error) {
        if (isAbortError(error) || options.signal.aborted) {
          throw abortError();
        }
        errors.push({ file: first, message: error instanceof Error ? error.message : String(error) });
      } finally {
        completed += 1;
        nextIndex = 1;
        options.onProgress?.({
          message: `Local scan: ${completed}/${files.length} files`,
          current: completed,
          total: files.length
        });
      }
    }

    const worker = async (): Promise<void> => {
      for (;;) {
        if (options.signal.aborted) {
          throw abortError();
        }
        const index = nextIndex;
        nextIndex += 1;
        if (index >= files.length) {
          return;
        }

        const file = files[index]!;
        try {
          const payload = await this.cli.scanAsca(file, options.signal);
          const error = ascaErrorMessage(payload);
          if (error) {
            throw new Error(error);
          }
          findings.push(
            ...normalizeAscaResults(payload, {
              root: options.root,
              scanId: options.scanId,
              mode: 'project',
              engine: 'local',
              reportedFile: file
            })
          );
        } catch (error) {
          if (isAbortError(error) || options.signal.aborted) {
            throw abortError();
          }
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ file, message });
          this.logger.warn(`Local scan failed for ${file}: ${message}`);
        } finally {
          completed += 1;
          options.onProgress?.({
            message: `Local scan: ${completed}/${files.length} files`,
            current: completed,
            total: files.length
          });
        }
      }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, files.length)) }, () => worker());
    const results = await Promise.allSettled(workers);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (options.signal.aborted || (rejected && isAbortError(rejected.reason))) {
      throw abortError();
    }
    if (rejected) {
      throw rejected.reason;
    }

    if (files.length > 0 && errors.length === files.length) {
      throw new Error(`Local ASCA scan failed for all files. First error: ${errors[0]?.message ?? 'unknown'}`);
    }

    return { findings, errors };
  }
}