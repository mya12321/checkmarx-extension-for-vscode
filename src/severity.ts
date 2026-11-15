import { SEVERITIES, type Severity, type SeverityCounts, type SeveritySummary } from './types';

const SEVERITY_ALIASES: Record<string, Severity> = {
  CRITICAL: 'CRITICAL',
  BLOCKER: 'CRITICAL',
  HIGH: 'HIGH',
  MAJOR: 'HIGH',
  MEDIUM: 'MEDIUM',
  MODERATE: 'MEDIUM',
  LOW: 'LOW',
  MINOR: 'LOW',
  INFO: 'INFO',
  INFORMATION: 'INFO',
  INFORMATIONAL: 'INFO',
  NONE: 'INFO',
  UNKNOWN: 'INFO'
};

export function normalizeSeverity(value: unknown): Severity {
  if (typeof value !== 'string') {
    return 'INFO';
  }
  return SEVERITY_ALIASES[value.trim().toUpperCase()] ?? 'INFO';
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(a) - severityRank(b);
}

export function meetsMinSeverity(severity: Severity, minimum: Severity): boolean {
  return severityRank(severity) <= severityRank(minimum);
}

export function emptyCounts(): SeverityCounts {
  return {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0
  };
}

export function countBySeverity(findings: ReadonlyArray<{ severity: Severity }>): SeverityCounts {
  const counts = emptyCounts();
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

export function summarize(findings: ReadonlyArray<{ severity: Severity }>): SeveritySummary {
  return {
    counts: countBySeverity(findings),
    total: findings.length
  };
}

export function formatCounts(counts: SeverityCounts): string {
  return SEVERITIES.filter((severity) => counts[severity] > 0)
    .map((severity) => `${severity.slice(0, 1)}${severity.slice(1).toLowerCase()} ${counts[severity]}`)
    .join(' · ');
}

export function highestSeverity(findings: ReadonlyArray<{ severity: Severity }>): Severity | undefined {
  let highest: Severity | undefined;
  for (const finding of findings) {
    if (!highest || severityRank(finding.severity) < severityRank(highest)) {
      highest = finding.severity;
    }
  }
  return highest;
}