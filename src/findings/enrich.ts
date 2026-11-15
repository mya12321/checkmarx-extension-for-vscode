import { readFile } from 'node:fs/promises';
import type { Finding } from '../types';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface CodeContext {
  text: string;
  startLine: number;
  endLine: number;
}

async function readTextCached(
  file: string,
  cache: Map<string, string | undefined>
): Promise<string | undefined> {
  if (cache.has(file)) {
    return cache.get(file);
  }
  try {
    const buffer = await readFile(file);
    if (buffer.byteLength > MAX_FILE_BYTES) {
      cache.set(file, undefined);
      return undefined;
    }
    const text = buffer.toString('utf8');
    cache.set(file, text);
    return text;
  } catch {
    cache.set(file, undefined);
    return undefined;
  }
}

export async function enrichFindingsWithCode(findings: Finding[]): Promise<Finding[]> {
  const cache = new Map<string, string | undefined>();
  const enriched: Finding[] = [];

  for (const finding of findings) {
    if (!finding.codeSnippet && finding.file && finding.line) {
      const text = await readTextCached(finding.file, cache);
      if (text) {
        const lines = text.split(/\r?\n/);
        const snippet = lines[finding.line - 1];
        if (snippet !== undefined) {
          enriched.push({ ...finding, codeSnippet: snippet });
          continue;
        }
      }
    }
    enriched.push(finding);
  }

  return enriched;
}

export async function getCodeContext(
  file: string,
  line: number | undefined,
  radius = 7
): Promise<CodeContext | undefined> {
  if (!line || line < 1) {
    return undefined;
  }
  let text: string;
  try {
    const buffer = await readFile(file);
    if (buffer.byteLength > MAX_FILE_BYTES) {
      return undefined;
    }
    text = buffer.toString('utf8');
  } catch {
    return undefined;
  }

  const lines = text.split(/\r?\n/);
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  const width = String(end).length;
  const rendered = lines
    .slice(start - 1, end)
    .map((value, index) => {
      const number = start + index;
      const marker = number === line ? '>' : ' ';
      return `${marker} ${String(number).padStart(width, ' ')} | ${value}`;
    })
    .join('\n');

  return {
    text: rendered,
    startLine: start,
    endLine: end
  };
}