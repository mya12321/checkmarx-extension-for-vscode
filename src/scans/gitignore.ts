import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * A gitignore engine with real git semantics, used to keep ignored paths out of
 * cloud uploads.
 *
 * The CLI's own `--use-gitignore` only reads the `.gitignore` at the source
 * root, matches patterns against basenames, and drops negations. This module
 * instead evaluates every `.gitignore` in the tree against workspace-relative
 * paths, so nested files, anchoring, `**`, directory-only rules and `!`
 * re-inclusion behave the way git does.
 */

export interface GitignoreRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
}

export interface GitignoreGroup {
  /** Directory containing the `.gitignore`, relative to the workspace root. */
  readonly base: string;
  readonly rules: readonly GitignoreRule[];
}

export interface GitignoreExclusions {
  /** Ant-style exclusions for `cx scan create --file-filter-ext`. */
  patterns: string[];
  /** Number of ignored entries that produced a pattern. */
  ignoredEntries: number;
  /** True when a safety limit stopped the walk before it finished. */
  truncated: boolean;
}

export interface GitignoreWalkOptions {
  signal?: AbortSignal;
  maxEntries?: number;
  maxPatterns?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_MAX_PATTERNS = 2_000;
const DEFAULT_MAX_DEPTH = 40;

export function parseGitignore(content: string, base: string): GitignoreGroup {
  const rules: GitignoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = trimTrailingSpaces(rawLine);
    if (!line) {
      continue;
    }

    let body = line;
    if (body.startsWith('\\#')) {
      body = body.slice(1);
    } else if (body.startsWith('#')) {
      continue;
    }

    let negated = false;
    if (body.startsWith('\\!')) {
      body = body.slice(1);
    } else if (body.startsWith('!')) {
      negated = true;
      body = body.slice(1);
    }
    if (!body) {
      continue;
    }

    let dirOnly = false;
    if (body.endsWith('/')) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    if (!body) {
      continue;
    }

    // A slash anywhere (or a leading slash) anchors the pattern to this
    // .gitignore's directory. Otherwise git matches the basename at any depth.
    const anchored = body.includes('/');
    if (body.startsWith('/')) {
      body = body.slice(1);
    }
    if (!body) {
      continue;
    }

    const prefix = anchored ? '' : '(?:[^/]+/)*';
    rules.push({
      negated,
      dirOnly,
      regex: new RegExp(`^${prefix}${globToRegex(body)}$`)
    });
  }
  return { base, rules };
}

/** Returns true when git would ignore `relPath` (relative to the workspace root). */
export function isIgnored(groups: readonly GitignoreGroup[], relPath: string, isDir: boolean): boolean {
  // Deeper .gitignore files override shallower ones, and within one file the
  // last matching rule wins.
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const rel = relativeToBase(group.base, relPath);
    if (rel === undefined) {
      continue;
    }
    let decision: boolean | undefined;
    for (const rule of group.rules) {
      if (rule.dirOnly && !isDir) {
        continue;
      }
      if (rule.regex.test(rel)) {
        decision = !rule.negated;
      }
    }
    if (decision !== undefined) {
      return decision;
    }
  }
  return false;
}

/**
 * Walks the workspace, collects the paths git would ignore, and converts them
 * into Ant deny patterns. Ignored directories are not descended into, matching
 * git's rule that a file cannot be re-included when its parent is excluded.
 */
export async function collectGitignoreExclusions(
  root: string,
  options: GitignoreWalkOptions = {}
): Promise<GitignoreExclusions> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxPatterns = options.maxPatterns ?? DEFAULT_MAX_PATTERNS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const patterns: string[] = [];
  const groups: GitignoreGroup[] = [];
  let visited = 0;
  let truncated = false;

  const walk = async (directory: string, base: string, depth: number): Promise<void> => {
    throwIfAborted(options.signal);
    const group = await readGroup(directory, base);
    if (group) {
      groups.push(group);
    }
    try {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
      if (!entries) {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        throwIfAborted(options.signal);
        if (truncated) {
          return;
        }
        // `.git` itself is stripped by --exclude-git-folder.
        if (entry.name === '.git') {
          continue;
        }
        if (visited >= maxEntries || patterns.length >= maxPatterns) {
          truncated = true;
          return;
        }
        visited += 1;

        const rel = base ? `${base}/${entry.name}` : entry.name;
        const isDir = entry.isDirectory();
        if (isIgnored(groups, rel, isDir)) {
          // Quote the whole value: pflag parses each occurrence as one CSV
          // record, and a quote is only honoured at the start of a field.
          patterns.push(csvEscape(`!${rel}`));
          continue;
        }
        if (isDir && depth + 1 < maxDepth) {
          await walk(path.join(directory, entry.name), rel, depth + 1);
        }
      }
    } finally {
      if (group) {
        groups.pop();
      }
    }
  };

  await walk(root, '', 0);
  return { patterns, ignoredEntries: patterns.length, truncated };
}

async function readGroup(directory: string, base: string): Promise<GitignoreGroup | undefined> {
  try {
    const content = await readFile(path.join(directory, '.gitignore'), 'utf8');
    return parseGitignore(content, base);
  } catch {
    return undefined;
  }
}

function relativeToBase(base: string, relPath: string): string | undefined {
  if (!base) {
    return relPath;
  }
  const prefix = `${base}/`;
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Scan cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

/** pflag parses each --file-filter-ext value as CSV, so quote commas. */
function csvEscape(value: string): string {
  if (!value.includes(',') && !value.includes('"')) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** Trims unescaped trailing spaces, as git does. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    let backslashes = 0;
    for (let i = end - 2; i >= 0 && line[i] === '\\'; i -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) {
      break;
    }
    end -= 1;
  }
  return line.slice(0, end);
}

function globToRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; ) {
    const char = pattern[i]!;

    if (char === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) {
        out += '\\\\';
        i += 1;
      } else {
        out += escapeRegex(next);
        i += 2;
      }
      continue;
    }

    if (char === '*') {
      let end = i;
      while (pattern[end] === '*') {
        end += 1;
      }
      const stars = end - i;
      const atSegmentStart = i === 0 || pattern[i - 1] === '/';
      const nextIsSlash = pattern[end] === '/';
      const atEnd = end === pattern.length;

      if (stars >= 2 && atSegmentStart && nextIsSlash) {
        // "**/" matches zero or more leading directories.
        out += '(?:[^/]+/)*';
        i = end + 1;
        continue;
      }
      if (stars >= 2 && atSegmentStart && atEnd) {
        // A trailing "/**" matches everything inside the directory.
        out += '.*';
        i = end;
        continue;
      }
      // Anywhere else, consecutive asterisks behave like a single one.
      out += '[^/]*';
      i = end;
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (char === '[') {
      const parsed = parseCharacterClass(pattern, i);
      if (parsed) {
        out += parsed.text;
        i = parsed.next;
      } else {
        out += '\\[';
        i += 1;
      }
      continue;
    }

    out += escapeRegex(char);
    i += 1;
  }
  return out;
}

function parseCharacterClass(pattern: string, start: number): { text: string; next: number } | undefined {
  let i = start + 1;
  let body = '';
  if (pattern[i] === '!' || pattern[i] === '^') {
    body += '^';
    i += 1;
  }
  if (pattern[i] === ']') {
    body += '\\]';
    i += 1;
  }
  for (; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '\\') {
      body += `\\${pattern[i + 1] ?? '\\'}`;
      i += 1;
      continue;
    }
    if (char === ']') {
      return { text: `[${body}]`, next: i + 1 };
    }
    if (char === '[' || char === '^') {
      body += `\\${char}`;
      continue;
    }
    body += char;
  }
  return undefined;
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}