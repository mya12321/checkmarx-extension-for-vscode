import { normalizeSeverity } from '../severity';
import { relativeToRoot, resolveWorkspaceFile, stableFindingKey } from '../paths';
import type { Finding, ScanEngine, ScanMode } from '../types';
import { asArray, asRecord, asString, pickNumber, pickString } from './util';

export interface AscaPayload {
  request_id?: string;
  status?: boolean;
  message?: string;
  scan_details?: unknown[];
  error?: {
    code?: number;
    description?: string;
  } | string;
}

export interface NormalizeAscaOptions {
  root: string;
  scanId: string;
  mode: ScanMode;
  engine?: ScanEngine;
  /** Absolute path of the file that was scanned. ASCA reports only the basename. */
  reportedFile: string;
}

export function normalizeAscaResults(payload: unknown, options: NormalizeAscaOptions): Finding[] {
  const record = asRecord(payload);
  const details = asArray(record?.scan_details);
  const file = resolveWorkspaceFile(options.root, options.reportedFile) ?? options.reportedFile;
  const relativeFile = relativeToRoot(options.root, file);
  const findings = new Map<string, Finding>();

  details.forEach((rawDetail, index) => {
    const detail = asRecord(rawDetail);
    if (!detail) {
      return;
    }

    const line = pickNumber(detail, ['line']);
    const ruleId = asString(detail.rule_id) ?? `asca-${index}`;
    const ruleName = pickString(detail, ['rule_name', 'ruleName']) ?? 'ASCA finding';
    const severity = normalizeSeverity(pickString(detail, ['severity']));
    const description = pickString(detail, ['description']) ?? '';
    const problematicLine = pickString(detail, ['problematicLine', 'problematic_line']);
    const length = pickNumber(detail, ['length']);
    const key = stableFindingKey(['sast', 'asca', ruleId, relativeFile, line, ruleName]);

    if (findings.has(key)) {
      return;
    }

    findings.set(key, {
      key,
      id: ruleId,
      scanId: options.scanId,
      mode: options.mode,
      engine: options.engine ?? 'local',
      type: 'sast',
      severity,
      title: ruleName,
      description,
      remediation: pickString(detail, ['remediationAdvise', 'remediation_advice', 'remediation']),
      file,
      relativeFile,
      line,
      column: 1,
      length,
      codeSnippet: problematicLine,
      language: pickString(detail, ['language']),
      state: undefined,
      status: undefined,
      nodes: line ? [{ file, line, column: 1, fileName: options.reportedFile }] : [{ file, fileName: options.reportedFile }]
    });
  });

  return [...findings.values()];
}

export function ascaErrorMessage(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const error = record?.error;
  if (typeof error === 'string') {
    return error;
  }
  const errorRecord = asRecord(error);
  if (errorRecord) {
    const description = asString(errorRecord.description);
    if (description) {
      return description;
    }
  }
  if (record?.status === false) {
    return asString(record.message) ?? 'ASCA scan failed';
  }
  return undefined;
}

export function ascaFindingCount(payload: unknown): number {
  return asArray(asRecord(payload)?.scan_details).length;
}
