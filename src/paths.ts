import { createHash } from 'node:crypto';
import * as path from 'node:path';

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

export function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function isUriLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function fileUriToPath(value: string): string {
  if (!value.startsWith('file://')) {
    return value;
  }
  try {
    const url = new URL(value);
    let filePath = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return filePath;
  } catch {
    return value;
  }
}

/**
 * Resolve a path reported by Checkmarx into an absolute local path.
 *
 * Cloud SAST results commonly report paths such as `/src/main/App.java`, which are
 * relative to the scanned project root even though they start with a slash. Absolute
 * paths inside the workspace, Windows drive paths, and file URIs are preserved.
 */
export function resolveWorkspaceFile(root: string, reportedPath: string | undefined): string | undefined {
  if (!reportedPath) {
    return undefined;
  }

  let value = fileUriToPath(reportedPath.trim());
  if (!value || value.startsWith('<')) {
    return undefined;
  }

  if (isWindowsDrivePath(value)) {
    return path.normalize(value);
  }

  const normalized = normalizeSlashes(value);
  const rootNormalized = normalizeSlashes(path.resolve(root));

  if (normalized === rootNormalized) {
    return path.resolve(root);
  }
  if (normalized.startsWith(`${rootNormalized}/`)) {
    return path.normalize(normalized);
  }

  // Checkmarx reports project-relative paths with a leading slash.
  const relative = stripLeadingSlash(normalized);
  return path.resolve(root, relative);
}

export function relativeToRoot(root: string, file: string | undefined): string | undefined {
  if (!file) {
    return undefined;
  }
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative === '') {
    return path.basename(resolvedFile);
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return normalizeSlashes(resolvedFile);
  }
  return normalizeSlashes(relative);
}

export function isInsideRoot(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function stableFindingKey(parts: Array<string | number | undefined | null>): string {
  const hash = createHash('sha1');
  hash.update(parts.map((part) => (part === undefined || part === null ? '' : String(part))).join('\u0000'));
  return hash.digest('hex').slice(0, 24);
}

export function hashContent(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

export function safeBaseName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function stripHtml(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function firstLine(value: string, maxLength = 160): string {
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return truncate(line, maxLength);
}