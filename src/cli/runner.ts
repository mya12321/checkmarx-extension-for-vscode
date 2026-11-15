import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets, type LoggerLike } from '../logging';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  maxBufferBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export class CliError extends Error {
  public readonly code: number | null;
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly timedOut: boolean;
  public readonly aborted: boolean;

  constructor(message: string, result: RunResult) {
    super(message);
    this.name = 'CliError';
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.timedOut = result.timedOut;
    this.aborted = result.aborted;
  }
}

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

export class CliRunner {
  constructor(
    private readonly logger: LoggerLike,
    private readonly streamOutput: () => boolean = () => false
  ) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    const maxBufferChars = Math.floor(maxBuffer / 2);

    this.logger.info(`Running: ${command} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);

    return await new Promise<RunResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const append = (current: string, chunk: string): string => {
        const next = current + chunk;
        return next.length > maxBufferChars ? next.slice(next.length - maxBufferChars) : next;
      };

      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        const result: RunResult = {
          code,
          signal,
          stdout,
          stderr,
          timedOut,
          aborted,
          durationMs: Date.now() - startedAt
        };
        if (options.signal?.aborted) {
          result.aborted = true;
        }
        if (this.streamOutput()) {
          if (stdout.trim()) {
            this.logger.debug(`stdout (${args[0] ?? command}):\n${redactSecrets(stdout).slice(-20000)}`);
          }
          if (stderr.trim()) {
            this.logger.debug(`stderr (${args[0] ?? command}):\n${redactSecrets(stderr).slice(-20000)}`);
          }
        }
        resolve(result);
      };

      const killTree = (): void => {
        killProcessTree(child);
        killTimer = setTimeout(() => {
          killProcessTree(child, true);
        }, 2500);
        killTimer.unref?.();
      };

      timeout = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
      timeout.unref?.();

      const onAbort = (): void => {
        aborted = true;
        killTree();
      };
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = append(stdout, chunk);
        options.onStdout?.(chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = append(stderr, chunk);
        options.onStderr?.(chunk);
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        reject(error);
      });

      child.on('close', (code, signal) => {
        options.signal?.removeEventListener('abort', onAbort);
        finish(code, signal);
      });
    });
  }
}

function killProcessTree(child: ChildProcess, force = false): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T'];
    if (force) {
      args.push('/F');
    }
    try {
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
    return;
  }

  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process may have already exited.
  }
}