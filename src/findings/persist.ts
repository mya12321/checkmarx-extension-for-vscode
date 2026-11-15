import type { Finding, PersistedSources, PersistedState, ScanSummary } from '../types';
import type { ResultSources } from './merge';

const MAX_FINDINGS_PER_SOURCE = 2000;
const MAX_TOTAL_FINDINGS = 3000;
const MAX_TEXT = 6000;

function limitText(value: string | undefined, max = MAX_TEXT): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function toPersistedFinding(finding: Finding): Finding {
  const copy: Finding = { ...finding };
  delete copy.raw;
  const rest = copy;
  return {
    ...rest,
    description: limitText(rest.description) ?? '',
    remediation: limitText(rest.remediation),
    codeSnippet: limitText(rest.codeSnippet, 2000),
    nodes: rest.nodes?.slice(0, 25)
  };
}

export function serializeSources(sources: ResultSources): PersistedSources {
  let budget = MAX_TOTAL_FINDINGS;
  const files: PersistedSources['files'] = [];
  const realtime: PersistedSources['realtime'] = [];

  const take = (findings: Finding[]): Finding[] => {
    const limited = findings.slice(0, Math.min(MAX_FINDINGS_PER_SOURCE, budget)).map(toPersistedFinding);
    budget -= limited.length;
    return limited;
  };

  const project = sources.project
    ? {
        scanId: sources.project.scanId,
        findings: take(sources.project.findings)
      }
    : undefined;

  for (const [file, entry] of sources.files) {
    if (budget <= 0) {
      break;
    }
    files.push({ file, scanId: entry.scanId, findings: take(entry.findings) });
  }

  for (const [file, entry] of sources.realtime) {
    if (budget <= 0) {
      break;
    }
    realtime.push({ file, scanId: entry.scanId, findings: take(entry.findings) });
  }

  return { project, files, realtime };
}

export function deserializeSources(persisted: PersistedSources | undefined): ResultSources {
  const sources: ResultSources = {
    files: new Map(),
    realtime: new Map()
  };
  if (!persisted) {
    return sources;
  }

  if (persisted.project) {
    sources.project = {
      scanId: persisted.project.scanId,
      findings: persisted.project.findings
    };
  }
  for (const entry of persisted.files) {
    sources.files.set(entry.file, { scanId: entry.scanId, findings: entry.findings });
  }
  for (const entry of persisted.realtime) {
    sources.realtime.set(entry.file, { scanId: entry.scanId, findings: entry.findings });
  }
  return sources;
}

function cleanSummary(scan: ScanSummary): ScanSummary {
  const copy: ScanSummary = { ...scan };
  delete copy.findingsBuffer;
  return copy;
}

export function buildPersistedState(sources: ResultSources, history: ScanSummary[], latest?: ScanSummary): PersistedState {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    sources: serializeSources(sources),
    history: history.slice(0, 25).map(cleanSummary),
    latest: latest ? cleanSummary(latest) : undefined
  };
}