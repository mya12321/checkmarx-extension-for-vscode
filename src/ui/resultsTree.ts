import * as vscode from 'vscode';
import { meetsMinSeverity, severityRank } from '../severity';
import type { Finding, FindingType, Severity } from '../types';
import { modeLabel, severityIcon, severityLabel, typeLabel } from './icons';

type GroupKind = 'severity' | 'file' | 'type';

interface MessageNode {
  kind: 'message';
  label: string;
  description?: string;
  command?: vscode.Command;
  icon?: vscode.ThemeIcon;
}

interface GroupNode {
  kind: 'group';
  id: string;
  groupKind: GroupKind;
  label: string;
  description?: string;
  severity?: Severity;
  findings: Finding[];
}

interface FindingNode {
  kind: 'finding';
  finding: Finding;
}

interface DetailNode {
  kind: 'detail';
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  command?: vscode.Command;
  children?: ResultNode[];
}

export type ResultNode = MessageNode | GroupNode | FindingNode | DetailNode;

export class ResultsTreeProvider implements vscode.TreeDataProvider<ResultNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ResultNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly getFindings: () => Finding[],
    private readonly getGroupBy: () => GroupKind,
    private readonly getMinSeverity: () => Severity
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  find(key: string): Finding | undefined {
    return this.getFindings().find((finding) => finding.key === key || finding.id === key);
  }

  getChildren(element?: ResultNode): ResultNode[] {
    if (!element) {
      return this.rootNodes();
    }
    if (element.kind === 'group') {
      return element.findings
        .sort(compareFindings)
        .map((finding) => ({ kind: 'finding', finding }));
    }
    if (element.kind === 'finding') {
      return this.detailNodes(element.finding);
    }
    if (element.kind === 'detail') {
      return element.children ?? [];
    }
    return [];
  }

  getTreeItem(element: ResultNode): vscode.TreeItem {
    if (element.kind === 'message') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.iconPath = element.icon ?? new vscode.ThemeIcon('info');
      item.command = element.command;
      return item;
    }

    if (element.kind === 'group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = element.id;
      item.description = element.description;
      item.iconPath = element.severity ? severityIcon(element.severity) : new vscode.ThemeIcon('shield');
      item.contextValue = element.groupKind === 'file' ? 'checkmarxFileGroup' : 'checkmarxGroup';
      item.tooltip = `${element.label}${element.description ? ` — ${element.description}` : ''}`;
      return item;
    }

    if (element.kind === 'finding') {
      const finding = element.finding;
      const item = new vscode.TreeItem(finding.title, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = finding.key;
      item.description = [finding.relativeFile ?? finding.file, finding.line].filter(Boolean).join(':');
      item.iconPath = severityIcon(finding.severity);
      item.contextValue = 'checkmarxFinding';
      item.command = {
        command: 'checkmarxLocal.openFinding',
        title: 'Open finding',
        arguments: [finding.key]
      };
      item.tooltip = findingTooltip(finding);
      return item;
    }

    const item = new vscode.TreeItem(element.label, element.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.iconPath = element.icon ?? new vscode.ThemeIcon('circle-small');
    item.tooltip = element.tooltip;
    item.command = element.command;
    item.contextValue = 'checkmarxDetail';
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private rootNodes(): ResultNode[] {
    const minimum = this.getMinSeverity();
    const findings = this.getFindings().filter((finding) => meetsMinSeverity(finding.severity, minimum));
    if (findings.length === 0) {
      return [
        {
          kind: 'message',
          label: 'No Checkmarx findings',
          description: 'Run a scan to populate results',
          icon: new vscode.ThemeIcon('shield'),
          command: { command: 'checkmarxLocal.scanProject', title: 'Scan project' }
        }
      ];
    }

    const groupBy = this.getGroupBy();
    if (groupBy === 'file') {
      const groups = new Map<string, Finding[]>();
      for (const finding of findings) {
        const key = finding.relativeFile ?? finding.file ?? 'No file location';
        const list = groups.get(key) ?? [];
        list.push(finding);
        groups.set(key, list);
      }
      return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, list]) => ({
          kind: 'group',
          id: `file:${file}`,
          groupKind: 'file',
          label: file,
          description: `${list.length} finding${list.length === 1 ? '' : 's'}`,
          findings: list
        }));
    }

    if (groupBy === 'type') {
      const order: FindingType[] = ['sast', 'sca', 'iac', 'secret', 'other'];
      return order
        .map((type) => {
          const list = findings.filter((finding) => finding.type === type);
          return {
            kind: 'group' as const,
            id: `type:${type}`,
            groupKind: 'type' as const,
            label: typeLabel(type),
            description: `${list.length} finding${list.length === 1 ? '' : 's'}`,
            findings: list
          };
        })
        .filter((group) => group.findings.length > 0);
    }

    const severityOrder: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
    return severityOrder
      .map((severity) => {
        const list = findings.filter((finding) => finding.severity === severity);
        return {
          kind: 'group' as const,
          id: `severity:${severity}`,
          groupKind: 'severity' as const,
          label: severityLabel(severity),
          description: `${list.length} finding${list.length === 1 ? '' : 's'}`,
          severity,
          findings: list
        };
      })
      .filter((group) => group.findings.length > 0);
  }

  private detailNodes(finding: Finding): ResultNode[] {
    const nodes: ResultNode[] = [
      {
        kind: 'detail',
        label: 'Severity',
        description: `${severityLabel(finding.severity)} · ${typeLabel(finding.type)}`,
        icon: severityIcon(finding.severity)
      }
    ];

    if (finding.description) {
      nodes.push({
        kind: 'detail',
        label: 'Description',
        description: truncate(finding.description, 80),
        tooltip: finding.description,
        icon: new vscode.ThemeIcon('book'),
        command: { command: 'checkmarxLocal.showFindingDetails', title: 'Show details', arguments: [finding.key] }
      });
    }

    if (finding.remediation) {
      nodes.push({
        kind: 'detail',
        label: 'Remediation',
        description: truncate(finding.remediation, 80),
        tooltip: finding.remediation,
        icon: new vscode.ThemeIcon('lightbulb'),
        command: { command: 'checkmarxLocal.showFindingDetails', title: 'Show details', arguments: [finding.key] }
      });
    }

    if (finding.cweId || finding.cveId) {
      nodes.push({
        kind: 'detail',
        label: finding.cveId ? 'CVE' : 'CWE',
        description: finding.cveId ?? finding.cweId,
        icon: new vscode.ThemeIcon('warning')
      });
    }

    if (finding.packageName) {
      nodes.push({
        kind: 'detail',
        label: 'Package',
        description: `${finding.packageName}${finding.packageVersion ? `@${finding.packageVersion}` : ''}${finding.recommendedVersion ? ` → ${finding.recommendedVersion}` : ''}`,
        icon: new vscode.ThemeIcon('package')
      });
    }

    if (finding.nodes && finding.nodes.length > 1) {
      nodes.push({
        kind: 'detail',
        label: 'Data flow',
        description: `${finding.nodes.length} steps`,
        icon: new vscode.ThemeIcon('git-branch'),
        children: finding.nodes.map((node, index) => ({
          kind: 'detail',
          label: `${index + 1}. ${node.name ?? node.domType ?? 'flow step'}`,
          description: [node.file ? pathLabel(node.file) : node.fileName, node.line].filter(Boolean).join(':'),
          tooltip: node.fullName,
          icon: new vscode.ThemeIcon('arrow-right'),
          command: node.file
            ? {
                command: 'checkmarxLocal.openLocation',
                title: 'Open flow step',
                arguments: [node.file, node.line, node.column]
              }
            : undefined
        }))
      });
    }

    nodes.push({
      kind: 'detail',
      label: 'Finding',
      description: `${finding.id} · ${modeLabel(finding.mode)}`,
      tooltip: `Scan ${finding.scanId}`,
      icon: new vscode.ThemeIcon('tag')
    });

    return nodes;
  }
}

function compareFindings(a: Finding, b: Finding): number {
  const severity = severityRank(a.severity) - severityRank(b.severity);
  if (severity !== 0) {
    return severity;
  }
  return (a.line ?? 0) - (b.line ?? 0) || a.title.localeCompare(b.title);
}

function findingTooltip(finding: Finding): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${severityLabel(finding.severity)} · ${typeLabel(finding.type)} · ${finding.title}**\n\n`);
  if (finding.relativeFile || finding.file) {
    tooltip.appendMarkdown(`\`${finding.relativeFile ?? finding.file}${finding.line ? `:${finding.line}` : ''}\`\n\n`);
  }
  if (finding.description) {
    tooltip.appendMarkdown(`${truncate(finding.description, 500)}\n\n`);
  }
  if (finding.remediation) {
    tooltip.appendMarkdown(`**Remediation:** ${truncate(finding.remediation, 400)}\n\n`);
  }
  tooltip.appendMarkdown(`*${finding.engine} · ${finding.mode} · ${finding.id}*`);
  return tooltip;
}

function truncate(value: string, max: number): string {
  const first = value.replace(/\s+/g, ' ').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function pathLabel(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}