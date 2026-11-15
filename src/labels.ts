import type { FindingType, Severity } from './types';

export function severityLabel(severity: Severity): string {
  return severity.charAt(0) + severity.slice(1).toLowerCase();
}

export function typeLabel(type: FindingType): string {
  switch (type) {
    case 'sast':
      return 'SAST';
    case 'sca':
      return 'SCA';
    case 'iac':
      return 'IaC';
    case 'secret':
      return 'Secrets';
    default:
      return 'Other';
  }
}

export function modeLabel(mode: string): string {
  switch (mode) {
    case 'project':
      return 'Project';
    case 'file':
      return 'File';
    case 'realtime':
      return 'Real-time';
    default:
      return mode;
  }
}
