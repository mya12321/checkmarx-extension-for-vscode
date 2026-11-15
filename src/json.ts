import { stripAnsi } from './paths';

/**
 * The Checkmarx CLI occasionally writes human-readable warnings before its JSON
 * payload. This extracts the first balanced JSON object/array from mixed output.
 */
export function extractJson<T = unknown>(raw: string): T {
  const text = stripAnsi(raw).replace(/^\uFEFF/, '').trim();
  if (!text) {
    throw new Error('CLI returned no output');
  }

  // Fast path for the normal case: the CLI wrote only JSON.
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to extracting a payload from mixed log output.
  }

  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate.
    }
  }

  const preview = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  throw new Error(`Unable to parse JSON from CLI output:\n${preview}`);
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '{' && char !== '[') {
      continue;
    }
    const end = findBalancedEnd(text, index);
    if (end !== -1) {
      candidates.push(text.slice(index, end + 1));
    }
  }
  return candidates;
}

function findBalancedEnd(text: string, start: number): number {
  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

export function lastNonEmptyLine(value: string): string {
  const lines = stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
}