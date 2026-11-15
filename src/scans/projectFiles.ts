import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { minimatch } from 'minimatch';
import { normalizeSlashes } from '../paths';
import type { SettingsSnapshot } from '../config';

const execFileAsync = promisify(execFile);
const PROJECT_FILE_SIZE_LIMIT = 4 * 1024 * 1024;

export interface ProjectFilesResult {
  files: string[];
  truncated: boolean;
  source: 'git' | 'filesystem';
}

export async function detectGitBranch(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const branch = stdout.trim();
    if (!branch || branch === 'HEAD') {
      const { stdout: sha } = await execFileAsync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      return sha.trim() || undefined;
    }
    return branch;
  } catch {
    return undefined;
  }
}

export async function collectProjectFiles(root: string, settings: SettingsSnapshot): Promise<ProjectFilesResult> {
  const extensions = new Set(settings.realtimeExtensions.map((extension) => extension.toLowerCase()));
  const excludes = settings.exclude;
  const maxFiles = settings.localMaxFiles;

  let candidates: string[] = [];
  let source: 'git' | 'filesystem' = 'filesystem';

  const gitFiles = await listGitFiles(root);
  if (gitFiles) {
    candidates = gitFiles;
    source = 'git';
  } else {
    candidates = await walkFiles(root, root, excludes, maxFiles * 4, 0);
  }

  const files: string[] = [];
  let truncated = false;
  for (const candidate of candidates) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const absolute = path.resolve(root, candidate);
    const relative = normalizeSlashes(path.relative(root, absolute));
    if (!relative || relative.startsWith('..')) {
      continue;
    }
    if (isExcludedPath(relative, excludes)) {
      continue;
    }
    if (!extensions.has(path.extname(absolute).toLowerCase())) {
      continue;
    }
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > PROJECT_FILE_SIZE_LIMIT) {
        continue;
      }
    } catch {
      continue;
    }
    files.push(absolute);
  }

  files.sort((a, b) => a.localeCompare(b));
  return { files, truncated, source };
}

export function isExcludedPath(relativePath: string, excludes: string[]): boolean {
  const normalized = normalizeSlashes(relativePath);
  return excludes.some((pattern) =>
    minimatch(normalized, pattern, {
      dot: true,
      nocase: process.platform === 'win32',
      matchBase: !pattern.includes('/')
    })
  );
}

export function isSupportedFile(file: string, settings: SettingsSnapshot): boolean {
  const extensions = new Set(settings.realtimeExtensions.map((extension) => extension.toLowerCase()));
  return extensions.has(path.extname(file).toLowerCase());
}

export function isExcludedFile(root: string, file: string, settings: SettingsSnapshot): boolean {
  const relative = normalizeSlashes(path.relative(root, file));
  return !relative || relative.startsWith('..') || isExcludedPath(relative, settings.exclude);
}

async function listGitFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024
      }
    );
    return stdout
      .split('\u0000')
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

async function walkFiles(
  root: string,
  directory: string,
  excludes: string[],
  limit: number,
  depth: number
): Promise<string[]> {
  if (depth > 30) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= limit) {
      break;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    const relative = normalizeSlashes(path.relative(root, absolute));
    if (isExcludedPath(relative, excludes) || isExcludedPath(`${relative}/`, excludes)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolute, excludes, limit - files.length, depth + 1)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}