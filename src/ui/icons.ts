import * as vscode from 'vscode';
import type { Severity } from '../types';
export { modeLabel, severityLabel, typeLabel } from '../labels';

const SEVERITY_COLORS: Record<Severity, string> = {
  CRITICAL: 'problemsErrorIcon.foreground',
  HIGH: 'problemsErrorIcon.foreground',
  MEDIUM: 'problemsWarningIcon.foreground',
  LOW: 'problemsInfoIcon.foreground',
  INFO: 'problemsInfoIcon.foreground'
};

export function severityIcon(severity: Severity): vscode.ThemeIcon {
  const name =
    severity === 'CRITICAL' || severity === 'HIGH'
      ? 'error'
      : severity === 'MEDIUM'
        ? 'warning'
        : 'info';
  return new vscode.ThemeIcon(name, new vscode.ThemeColor(SEVERITY_COLORS[severity]));
}

export function statusIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case 'completed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
    case 'running':
      return new vscode.ThemeIcon('sync~spin');
    default:
      return new vscode.ThemeIcon('clock');
  }
}
