export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as UnknownRecord;
  }
  return undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function getPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

export function pickString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = getPath(value, key.split('.'));
    const text = asString(found);
    if (text) {
      return text;
    }
  }
  return undefined;
}

export function pickNumber(value: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const found = getPath(value, key.split('.'));
    const number = asNumber(found);
    if (number !== undefined) {
      return number;
    }
  }
  return undefined;
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function severityFromCvss(score: number | undefined): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' {
  if (score === undefined) {
    return 'INFO';
  }
  if (score >= 9) {
    return 'CRITICAL';
  }
  if (score >= 7) {
    return 'HIGH';
  }
  if (score >= 4) {
    return 'MEDIUM';
  }
  if (score > 0) {
    return 'LOW';
  }
  return 'INFO';
}