import type { Finding, FindingDetails, ScanSummary } from '../types';
import { severityLabel, typeLabel } from '../labels';

export function buildFindingFixPrompt(details: FindingDetails, workspaceRoot?: string): string {
  const finding = details.finding;
  const location = finding.relativeFile ?? finding.file ?? 'the affected file';
  const line = finding.line ? `:${finding.line}` : '';
  const flow = (finding.nodes ?? [])
    .map((node, index) => `${index + 1}. ${node.file ?? node.fileName ?? 'unknown'}${node.line ? `:${node.line}` : ''}${node.name ? ` — ${node.name}` : ''}`)
    .join('\n');

  return `Fix this Checkmarx finding in the current workspace.

Finding
- Title: ${finding.title}
- Severity: ${severityLabel(finding.severity)}
- Type: ${typeLabel(finding.type)} (${finding.engine} engine, ${finding.mode} scan)
- Location: ${location}${line}
- Finding id: ${finding.id}${finding.cweId ? `\n- CWE: ${finding.cweId}` : ''}${finding.cveId ? `\n- CVE: ${finding.cveId}` : ''}
${finding.packageName ? `- Package: ${finding.packageName}${finding.packageVersion ? `@${finding.packageVersion}` : ''}${finding.recommendedVersion ? ` (recommended: ${finding.recommendedVersion})` : ''}\n` : ''}
Description
${finding.description || '(no description provided)'}

Remediation guidance
${finding.remediation || '(no provider remediation text; derive the fix from the description and data flow)'}

${flow ? `Data flow\n${flow}\n\n` : ''}${details.codeContext ? `Context around the affected line\n\`\`\`\n${details.codeContext}\n\`\`\`\n\n` : finding.codeSnippet ? `Affected line\n\`\`\`\n${finding.codeSnippet}\n\`\`\`\n\n` : ''}Requirements
1. Fix the root cause at ${location}${line}. Do not merely suppress the diagnostic, catch and ignore errors, disable a security control, or add an ignore comment.
2. Keep the change minimal and preserve existing behavior and public APIs.
3. If the workspace exposes the Checkmarx MCP tools, call checkmarx_get_finding for this key (${finding.key}) first if you need more context, then edit the file.
4. After editing, call checkmarx_scan_file with \`${finding.relativeFile ?? finding.file ?? ''}\` and confirm this finding is gone. If it remains, iterate until it is fixed or explain precisely why it is a false positive.
5. Do not modify unrelated files.${workspaceRoot ? `\n\nWorkspace root: ${workspaceRoot}` : ''}

Report the root cause, the exact edit, and the rescan result.`;
}

export function buildFileFixPrompt(file: string, findings: Finding[]): string {
  const relative = findings.find((finding) => finding.relativeFile)?.relativeFile ?? file;
  const list = findings
    .map(
      (finding, index) =>
        `${index + 1}. [${severityLabel(finding.severity)}] ${finding.title}${finding.line ? ` (line ${finding.line})` : ''} — key: ${finding.key}\n   ${finding.description.replace(/\s+/g, ' ').slice(0, 300)}`
    )
    .join('\n');

  return `Fix all Checkmarx findings in ${relative}.

Findings (${findings.length})
${list}

Requirements
1. Review each finding with checkmarx_get_finding when the MCP tools are available, then fix the root cause in ${relative}. Do not suppress diagnostics or weaken security controls.
2. Keep edits scoped to ${relative} unless a dependency manifest must be updated for an SCA finding.
3. After editing, call checkmarx_scan_file with \`${relative}\` and verify that the findings are gone. Iterate until the file is clean or explain any false positive.
4. Summarize each fix and the rescan result.`;
}

export function buildScanSummaryPrompt(summary: ScanSummary, findings: Finding[]): string {
  const top = findings
    .slice(0, 25)
    .map(
      (finding, index) =>
        `${index + 1}. [${severityLabel(finding.severity)}] ${finding.title} — ${finding.relativeFile ?? finding.file ?? 'unknown'}${finding.line ? `:${finding.line}` : ''} (key: ${finding.key})`
    )
    .join('\n');

  return `Review and remediate the latest Checkmarx scan.

Scan
- Id: ${summary.id}
- Mode: ${summary.mode} (${summary.engine})
- Status: ${summary.status}
- Findings: ${summary.totalFindings}

Findings
${top || 'No findings in this scan.'}

Requirements
1. Triage the highest-severity findings first.
2. For each finding, fetch full details (checkmarx_get_finding) and fix the root cause. Do not suppress findings or weaken security controls.
3. After editing each file, call checkmarx_scan_file to verify the fix, and continue until the important findings are resolved or explained.
4. Summarize the changes and verification results.`;
}