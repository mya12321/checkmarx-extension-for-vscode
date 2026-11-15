import * as vscode from 'vscode';
import { meetsMinSeverity } from '../severity';
import type { Finding, Severity } from '../types';

export class DiagnosticsManager implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly signatures = new Map<string, string>();

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('checkmarx-local');
  }

  update(findings: Finding[], enabled: boolean, minimum: Severity): void {
    if (!enabled) {
      this.collection.clear();
      this.signatures.clear();
      return;
    }

    const grouped = new Map<string, Finding[]>();
    for (const finding of findings) {
      if (!finding.file || !meetsMinSeverity(finding.severity, minimum)) {
        continue;
      }
      const list = grouped.get(finding.file) ?? [];
      list.push(finding);
      grouped.set(finding.file, list);
    }

    const nextSignatures = new Map<string, string>();
    for (const [file, fileFindings] of grouped) {
      const signature = fileFindings
        .map((finding) => `${finding.key}:${finding.severity}:${finding.line}:${finding.column}:${finding.title}:${finding.state ?? ''}:${finding.description.slice(0, 200)}`)
        .sort()
        .join('|');
      nextSignatures.set(file, signature);
      if (this.signatures.get(file) !== signature) {
        this.collection.set(vscode.Uri.file(file), fileFindings.map((finding) => toDiagnostic(finding)));
      }
    }

    for (const file of this.signatures.keys()) {
      if (!nextSignatures.has(file)) {
        this.collection.delete(vscode.Uri.file(file));
      }
    }

    this.signatures.clear();
    for (const [file, signature] of nextSignatures) {
      this.signatures.set(file, signature);
    }
  }

  clear(): void {
    this.collection.clear();
    this.signatures.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function toDiagnostic(finding: Finding): vscode.Diagnostic {
  const line = Math.max(1, finding.line ?? 1);
  const column = Math.max(1, finding.column ?? 1);
  const length = Math.max(1, finding.length ?? 1);
  const start = new vscode.Position(line - 1, column - 1);
  const endLine = finding.endLine && finding.endLine >= line ? finding.endLine : line;
  const endColumn = finding.endColumn ?? (endLine === line ? column - 1 + length : length);
  const end = new vscode.Position(endLine - 1, Math.max(0, endColumn));
  const range = new vscode.Range(start, end);

  const description = firstSentence(finding.description);
  const message = description ? `${finding.title}\n${description}` : finding.title;
  const diagnostic = new vscode.Diagnostic(range, message, toSeverity(finding.severity));
  diagnostic.source = 'Checkmarx';
  diagnostic.code = finding.cweId ?? finding.queryName ?? finding.id;

  if (finding.state && ['NOT_EXPLOITABLE', 'IGNORED'].includes(finding.state.toUpperCase())) {
    diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
  }

  const related: vscode.DiagnosticRelatedInformation[] = [];
  for (const node of finding.nodes ?? []) {
    if (!node.file || !node.line) {
      continue;
    }
    if (node.file === finding.file && node.line === finding.line) {
      continue;
    }
    related.push(
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(node.file), new vscode.Position(node.line - 1, Math.max(0, (node.column ?? 1) - 1))),
        node.name ? `Data flow: ${node.name}` : 'Data flow'
      )
    );
    if (related.length >= 12) {
      break;
    }
  }
  if (related.length > 0) {
    diagnostic.relatedInformation = related;
  }

  return diagnostic;
}

function toSeverity(severity: Severity): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return vscode.DiagnosticSeverity.Error;
    case 'MEDIUM':
      return vscode.DiagnosticSeverity.Warning;
    case 'LOW':
    case 'INFO':
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const match = normalized.match(/^.{0,400}?[.!?](\s|$)/);
  const sentence = match?.[0]?.trim() ?? normalized.slice(0, 400);
  return sentence.length > 400 ? `${sentence.slice(0, 397)}...` : sentence;
}
