import { compareSeverity, emptyCounts, meetsMinSeverity } from '../severity';
import type { Finding, FindingType, ResultsQuery, ScanEngine, Severity } from '../types';
import { isInsideRoot, normalizeSlashes } from '../paths';

export interface FileOverride {
  scanId: string;
  findings: Finding[];
  /** Engine that produced the override; used to scope what it may replace. */
  engine?: ScanEngine;
  /** Scan types the override covered, e.g. ["sast"]. */
  scanTypes?: string[];
}

export interface ResultSources {
  project?: {
    scanId: string;
    findings: Finding[];
  };
  files: Map<string, FileOverride>;
  realtime: Map<string, FileOverride>;
}

export function createEmptySources(): ResultSources {
  return {
    files: new Map(),
    realtime: new Map()
  };
}

function sameFile(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return normalizeSlashes(a).toLowerCase() === normalizeSlashes(b).toLowerCase();
}

const SCAN_TYPE_TO_FINDING_TYPE: Record<string, FindingType> = {
  sast: 'sast',
  asca: 'sast',
  sca: 'sca',
  'iac-security': 'iac',
  iac: 'iac',
  kics: 'iac',
  secrets: 'secret',
  'secret-detection': 'secret',
  'secrets-detection': 'secret',
  scs: 'secret',
  'api-security': 'other',
  'container-security': 'other',
  containers: 'other',
  dast: 'other'
};

function coveredFindingTypes(override: FileOverride): Set<FindingType> | undefined {
  const fromScanTypes = new Set<FindingType>();
  for (const scanType of override.scanTypes ?? []) {
    const type = SCAN_TYPE_TO_FINDING_TYPE[scanType.trim().toLowerCase()];
    if (type) {
      fromScanTypes.add(type);
    }
  }
  if (fromScanTypes.size > 0) {
    return fromScanTypes;
  }
  // Older persisted entries have no scanTypes; infer them from their findings.
  if (override.findings.length > 0) {
    return new Set(override.findings.map((finding) => finding.type));
  }
  return undefined;
}

/**
 * Merge result sources with file-level overrides.
 *
 * Project results form the base. A single-file scan replaces the project
 * findings for that file **that it could actually have detected**: only the
 * same engine and only the scan types it ran. This keeps an ASCA rescan from
 * erasing Checkmarx One findings, and a SAST-only rescan from erasing SCA or
 * IaC findings for the same file.
 */
export function mergeSources(sources: ResultSources): Finding[] {
  const byKey = new Map<string, Finding>();

  for (const finding of sources.project?.findings ?? []) {
    byKey.set(finding.key, finding);
  }

  const overrides: Array<[string, FileOverride]> = [
    ...sources.files.entries(),
    ...sources.realtime.entries()
  ];

  for (const [file, override] of overrides) {
    const engine = override.engine ?? override.findings[0]?.engine;
    const types = coveredFindingTypes(override);
    for (const [key, finding] of byKey) {
      if (!sameFile(finding.file, file)) {
        continue;
      }
      // Unknown engine/scope (e.g. an override persisted by an older version
      // with no findings): never delete project results we cannot compare to.
      if (!engine || !types) {
        continue;
      }
      if (finding.engine !== engine || !types.has(finding.type)) {
        continue;
      }
      byKey.delete(key);
    }
    for (const finding of override.findings) {
      byKey.set(finding.key, finding);
    }
  }

  return sortFindings([...byKey.values()]);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severity = compareSeverity(a.severity, b.severity);
    if (severity !== 0) {
      return severity;
    }
    const file = (a.relativeFile ?? a.file ?? '').localeCompare(b.relativeFile ?? b.file ?? '');
    if (file !== 0) {
      return file;
    }
    return (a.line ?? 0) - (b.line ?? 0) || a.title.localeCompare(b.title);
  });
}

export function filterFindings(
  findings: Finding[],
  options: {
    minSeverity?: Severity;
    query?: ResultsQuery;
    root?: string;
  } = {}
): Finding[] {
  const query = options.query;
  const fileFilter = query?.file ? normalizeSlashes(query.file) : undefined;
  const filtered = findings.filter((finding) => {
    if (options.minSeverity && !meetsMinSeverity(finding.severity, options.minSeverity)) {
      return false;
    }
    if (query?.scanId && finding.scanId !== query.scanId) {
      return false;
    }
    if (query?.severity?.length && !query.severity.includes(finding.severity)) {
      return false;
    }
    if (query?.type && finding.type !== query.type) {
      return false;
    }
    if (query?.state && (finding.state ?? '').toUpperCase() !== query.state.toUpperCase()) {
      return false;
    }
    if (fileFilter) {
      const absolute = finding.file ? normalizeSlashes(finding.file) : '';
      const relative = finding.relativeFile ? normalizeSlashes(finding.relativeFile) : '';
      if (!absolute.endsWith(fileFilter) && !relative.endsWith(fileFilter) && !relative.includes(fileFilter)) {
        return false;
      }
    }
    return true;
  });

  return typeof query?.limit === 'number' && query.limit >= 0 ? filtered.slice(0, query.limit) : filtered;
}

export function findingsForFile(findings: Finding[], file: string): Finding[] {
  return findings.filter((finding) => sameFile(finding.file, file));
}

export function groupByFile(findings: Finding[], root: string): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.file && isInsideRoot(root, finding.file) ? finding.file : finding.relativeFile ?? finding.file ?? '';
    const list = groups.get(key) ?? [];
    list.push(finding);
    groups.set(key, list);
  }
  return groups;
}

export function countsRecord(findings: Finding[]): Record<Severity, number> {
  const counts = emptyCounts();
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}