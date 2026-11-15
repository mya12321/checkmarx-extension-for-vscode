import { constants as fsConstants, type Dirent } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SettingsLike } from '../config';
import type { LoggerLike } from '../logging';
import type { CliInfo } from '../types';
import { probeVersion } from './probe';

export class CliNotFoundError extends Error {
  public readonly code = 'CLI_NOT_FOUND';

  constructor(message = 'Checkmarx CLI (cx) was not found') {
    super(message);
    this.name = 'CliNotFoundError';
  }
}

export class CliProvider implements vscode.Disposable {
  private cached?: CliInfo;
  private cachedKey?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsLike,
    private readonly logger: LoggerLike
  ) {}

  invalidate(): void {
    this.cached = undefined;
    this.cachedKey = undefined;
  }

  async resolve(force = false): Promise<CliInfo> {
    const snapshot = this.settings.load();
    const key = `${snapshot.cliPath}|${this.context.globalState.get<string>('checkmarxLocal.managedCliPath') ?? ''}`;
    if (!force && this.cached && this.cachedKey === key && (await isExecutable(this.cached.path))) {
      return this.cached;
    }

    const info = await this.locate(snapshot.cliPath);
    this.cached = info;
    this.cachedKey = key;
    return info;
  }

  async version(info?: CliInfo): Promise<string | undefined> {
    const location = info ?? (await this.resolve());
    if (location.version) {
      return location.version;
    }
    const version = await probeVersion(location.path);
    if (version) {
      location.version = version;
    }
    return version;
  }

  dispose(): void {
    this.cached = undefined;
  }

  private async locate(configuredPath: string): Promise<CliInfo> {
    if (configuredPath && configuredPath.toLowerCase() !== 'auto') {
      const resolved = expandHome(configuredPath.trim().replace(/^"(.*)"$/, '$1'));
      const executable = await normalizeExecutable(resolved);
      if (!executable) {
        throw new CliNotFoundError(`Configured Checkmarx CLI path is not executable: ${configuredPath}`);
      }
      return { path: executable, source: 'setting', version: await probeVersion(executable) };
    }

    const onPath = await this.findOnPath();
    if (onPath) {
      this.logger.info(`Using Checkmarx CLI from PATH: ${onPath}`);
      return { path: onPath, source: 'path', version: await probeVersion(onPath) };
    }

    const managed = await this.findManagedInstall();
    if (managed) {
      this.logger.info(`Using extension-managed Checkmarx CLI: ${managed}`);
      return { path: managed, source: 'managed', version: await probeVersion(managed) };
    }

    const bundled = await this.findBundledWithOfficialExtension();
    if (bundled) {
      this.logger.info(`Using Checkmarx CLI bundled with the official extension: ${bundled}`);
      return { path: bundled, source: 'official-extension', version: await probeVersion(bundled) };
    }

    throw new CliNotFoundError(
      'Checkmarx CLI (cx) was not found. Install it with "Checkmarx: Install / Update CLI" or set "checkmarxLocal.cliPath".'
    );
  }

  private async findOnPath(): Promise<string | undefined> {
    const pathValue = process.env.PATH ?? process.env.Path ?? '';
    const directories = pathValue.split(path.delimiter).filter(Boolean);
    const names = process.platform === 'win32' ? ['cx.exe', 'cx'] : ['cx'];

    for (const directory of directories) {
      for (const name of names) {
        const candidate = path.join(directory, name);
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  private async findManagedInstall(): Promise<string | undefined> {
    const stored = this.context.globalState.get<string>('checkmarxLocal.managedCliPath');
    if (stored && (await isExecutable(stored))) {
      return stored;
    }

    const cliRoot = path.join(this.context.globalStorageUri.fsPath, 'cli');
    const entries = await safeReadDir(cliRoot);
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = path.join(cliRoot, entry.name);
      for (const name of executableNames()) {
        const candidate = path.join(directory, name);
        if (await isExecutable(candidate)) {
          candidates.push(candidate);
        }
      }
    }

    candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return candidates[0];
  }

  private async findBundledWithOfficialExtension(): Promise<string | undefined> {
    const roots = extensionRoots();
    const binary = bundledBinaryName();
    if (!binary) {
      return undefined;
    }

    for (const root of roots) {
      const entries = await safeReadDir(root);
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith('checkmarx.')) {
          continue;
        }
        const extensionRoot = path.join(root, entry.name);
        for (const relative of bundledCliPaths(binary)) {
          const candidate = path.join(extensionRoot, relative);
          if (await isExecutable(candidate)) {
            return candidate;
          }
        }
      }
    }
    return undefined;
  }
}


function executableNames(): string[] {
  if (process.platform === 'win32') {
    return ['cx.exe', 'cx'];
  }
  return ['cx'];
}

function bundledBinaryName(): string | undefined {
  if (process.platform === 'win32') {
    return 'cx.exe';
  }
  if (process.platform === 'darwin') {
    return 'cx-mac';
  }
  if (process.platform === 'linux') {
    return 'cx-linux';
  }
  return undefined;
}

function bundledCliPaths(binary: string): string[] {
  const suffix = path.join('dist', 'main', 'wrapper', 'resources', binary);
  return [
    path.join('out', 'node_modules', '@checkmarx', 'vscode-core', 'node_modules', '@checkmarx', 'ast-cli-javascript-wrapper', suffix),
    path.join('node_modules', '@checkmarx', 'vscode-core', 'node_modules', '@checkmarx', 'ast-cli-javascript-wrapper', suffix),
    path.join('out', 'node_modules', '@checkmarx', 'ast-cli-javascript-wrapper', suffix),
    path.join('node_modules', '@checkmarx', 'ast-cli-javascript-wrapper', suffix)
  ];
}

function extensionRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode-server-insiders', 'extensions'),
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions')
  ];
}

async function safeReadDir(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function normalizeExecutable(input: string): Promise<string | undefined> {
  try {
    const info = await stat(input);
    if (info.isDirectory()) {
      for (const name of executableNames()) {
        const candidate = path.join(input, name);
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // Fall through to the file checks below.
  }
  if (await isExecutable(input)) {
    return input;
  }
  if (process.platform === 'win32' && !path.extname(input)) {
    const withExe = `${input}.exe`;
    if (await isExecutable(withExe)) {
      return withExe;
    }
  }
  return undefined;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      return false;
    }
    await access(file, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}