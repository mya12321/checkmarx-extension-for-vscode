import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { x as extractTar } from 'tar';
import type { LoggerLike } from '../logging';
import { probeVersion } from './probe';
import { downloadFile } from './download';

const DOWNLOAD_BASE = 'https://download.checkmarx.com/CxOne/CLI/latest/';
const CHECKSUMS_URL = 'https://github.com/Checkmarx/ast-cli/releases/latest/download/ast-cli_checksums.txt';

export interface InstallProgress {
  phase: 'download' | 'extract' | 'verify';
  message: string;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface InstallResult {
  path: string;
  version?: string;
}

export class UnsupportedPlatformError extends Error {
  public readonly code = 'UNSUPPORTED_PLATFORM';
}

export async function installCli(options: {
  installRoot: string;
  signal?: AbortSignal;
  logger: LoggerLike;
  onProgress?: (progress: InstallProgress) => void;
}): Promise<InstallResult> {
  const archive = archiveForPlatform();
  if (!archive) {
    throw new UnsupportedPlatformError(
      `Automatic Checkmarx CLI installation is not supported on ${process.platform}/${process.arch}. Install the CLI manually and set "checkmarxLocal.cliPath".`
    );
  }

  const workRoot = path.join(options.installRoot, `install-${Date.now()}`);
  const archivePath = path.join(workRoot, archive.fileName);
  const extractRoot = path.join(workRoot, 'extracted');
  const downloadUrl = new URL(archive.fileName, DOWNLOAD_BASE).toString();

  try {
    await mkdir(extractRoot, { recursive: true });
    options.logger.info(`Downloading Checkmarx CLI from ${downloadUrl}`);
    options.onProgress?.({
      phase: 'download',
      message: `Downloading Checkmarx CLI (${archive.fileName})…`,
      receivedBytes: 0,
      totalBytes: undefined
    });

    await downloadFile(downloadUrl, archivePath, {
      signal: options.signal,
      userAgent: 'checkmarx-local-vscode',
      onProgress: (receivedBytes, totalBytes) => {
        options.onProgress?.({
          phase: 'download',
          message: `Downloading Checkmarx CLI… ${formatBytes(receivedBytes)}${totalBytes ? ` / ${formatBytes(totalBytes)}` : ''}`,
          receivedBytes,
          totalBytes
        });
      }
    });

    const fileInfo = await stat(archivePath);
    if (fileInfo.size < 1024 * 1024) {
      throw new Error('The downloaded Checkmarx CLI archive is unexpectedly small');
    }

    await verifyChecksumIfAvailable(archive.fileName, archivePath, options.logger, options.signal);

    options.onProgress?.({ phase: 'extract', message: 'Extracting Checkmarx CLI…' });
    await extractCliArchive(archivePath, archive.format, extractRoot);

    const binary = await findExtractedBinary(extractRoot);
    if (!binary) {
      throw new Error('Could not find the cx executable in the downloaded archive');
    }

    if (process.platform !== 'win32') {
      await chmod(binary, 0o755);
    }
    options.onProgress?.({ phase: 'verify', message: 'Verifying Checkmarx CLI…' });
    const version = (await probeVersion(binary)) ?? 'unknown';
    const destinationDirectory = path.join(options.installRoot, version === 'unknown' ? `latest-${Date.now()}` : version);
    await mkdir(destinationDirectory, { recursive: true });
    const destination = path.join(destinationDirectory, binaryNameForPlatform());
    await moveFile(binary, destination);
    if (process.platform !== 'win32') {
      await chmod(destination, 0o755);
    }

    const installedVersion = await probeVersion(destination);
    if (!installedVersion) {
      throw new Error('The installed Checkmarx CLI did not respond to "cx version"');
    }

    options.logger.info(`Installed Checkmarx CLI ${installedVersion} at ${destination}`);
    return { path: destination, version: installedVersion };
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyChecksumIfAvailable(
  archiveFileName: string,
  archivePath: string,
  logger: LoggerLike,
  signal?: AbortSignal
): Promise<void> {
  const checksumsPath = `${archivePath}.checksums`;
  try {
    await downloadFile(CHECKSUMS_URL, checksumsPath, { signal, userAgent: 'checkmarx-local-vscode' });
    const content = await readFile(checksumsPath, 'utf8');
    const checksumSuffix = archiveFileName.replace(/^ast-cli_/, '');
    const line = content
      .split(/\r?\n/)
      .find((value) => value.trim().endsWith(checksumSuffix) || value.trim().endsWith(archiveFileName));
    if (!line) {
      logger.debug(`No checksum entry found for ${archiveFileName}; skipping verification`);
      return;
    }
    const expected = line.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
      return;
    }
    const actual = await sha256(archivePath);
    if (actual !== expected) {
      throw new Error(`Checksum verification failed for ${archiveFileName}`);
    }
    logger.info(`Verified SHA-256 checksum for ${archiveFileName}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Checksum verification failed')) {
      throw error;
    }
    logger.debug(`Checksum verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(checksumsPath, { force: true }).catch(() => undefined);
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

function archiveForPlatform(): { fileName: string; format: 'zip' | 'tar.gz' } | undefined {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { fileName: 'ast-cli_windows_x64.zip', format: 'zip' };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { fileName: 'ast-cli_linux_x64.tar.gz', format: 'tar.gz' };
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return { fileName: 'ast-cli_linux_arm64.tar.gz', format: 'tar.gz' };
  }
  if (process.platform === 'linux' && process.arch === 'arm') {
    return { fileName: 'ast-cli_linux_armv6.tar.gz', format: 'tar.gz' };
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { fileName: 'ast-cli_darwin_x64.tar.gz', format: 'tar.gz' };
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { fileName: 'ast-cli_darwin_universal.tar.gz', format: 'tar.gz' };
  }
  return undefined;
}

function binaryNameForPlatform(): string {
  return process.platform === 'win32' ? 'cx.exe' : 'cx';
}

export async function extractCliArchive(archivePath: string, format: 'zip' | 'tar.gz', extractRoot: string): Promise<void> {
  if (format === 'zip') {
    new AdmZip(archivePath).extractAllTo(extractRoot, true);
  } else {
    await extractTar({ file: archivePath, cwd: extractRoot, gzip: true, strict: false });
  }
}

export async function findExtractedBinary(root: string): Promise<string | undefined> {
  const wanted = new Set<string>(['cx', 'cx.exe', 'cx-mac', 'cx-linux']);
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const candidates: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 4) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        queue.push({ directory: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile() && wanted.has(entry.name)) {
        candidates.push(fullPath);
      }
    }
  }

  const preferred = process.platform === 'win32' ? 'cx.exe' : 'cx';
  candidates.sort((a, b) => Number(path.basename(b) === preferred) - Number(path.basename(a) === preferred));
  return candidates[0];
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch {
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function platformDescription(): string {
  return `${os.platform()}/${os.arch()}`;
}