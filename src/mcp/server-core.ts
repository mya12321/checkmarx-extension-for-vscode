import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeState } from './protocol';
import { BridgeClient, BridgeError } from './bridgeClient';
import { formatCounts } from '../severity';
import type { Finding, FindingDetails, ResultsResponse, ScanSummary, Severity } from '../types';

const severitySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
const findingTypeSchema = z.enum(['sast', 'sca', 'iac', 'secret', 'other']);

const INSTRUCTIONS = `You are connected to Checkmarx through the user's local VS Code extension. The extension runs the Checkmarx CLI and keeps the latest scan results for the open workspace.

Follow this workflow for security review and remediation:
1. Call checkmarx_get_state to see the latest scan, authentication status, and finding counts.
2. Use checkmarx_get_results or checkmarx_get_file_findings to inspect findings before editing code. Do not guess finding ids or file paths.
3. Use checkmarx_get_finding for full details, including remediation advice and data-flow nodes.
4. Fix the root cause, preserve existing behavior, and keep the change minimal. Never suppress a finding or weaken a security control just to make a scan pass.
5. After editing, call checkmarx_scan_file on each changed file. If findings remain, continue fixing and rescanning.
6. Report which files changed and the verification result.

Cloud scans upload source code to Checkmarx One. Local scans run on this machine. Do not start a cloud scan unless the user asks for it or the workspace already uses the cloud engine. 'checkmarx_scan_file' defaults to the local engine; pass engine="cloud" only when the user explicitly wants that file uploaded.`;

export function createCheckmarxServer(client: BridgeClient): McpServer {
  const server = new McpServer(
    {
      name: 'Checkmarx Local Scan',
      version: process.env.CHECKMARX_EXTENSION_VERSION ?? '0.1.0'
    },
    {
      instructions: INSTRUCTIONS
    }
  );

  registerTool(server, {
    name: 'checkmarx_get_state',
    title: 'Get Checkmarx state',
    description:
      'Returns authentication status, CLI status, the latest scan summary, finding counts, and active scan progress. Call this first.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {},
    handler: async () => {
      const state = await client.getState();
      return result(formatState(state), { state });
    }
  });

  registerTool(server, {
    name: 'checkmarx_scan_project',
    title: 'Run a Checkmarx project scan',
    description:
      'Starts a scan of the whole workspace. engine="local" runs the ASCA engine file-by-file locally (no source upload). engine="cloud" uploads the workspace to Checkmarx One. By default the call waits for completion and returns the summary. Large projects can take several minutes.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      engine: z.enum(['local', 'cloud']).optional().describe('Scan engine. Defaults to the extension setting.'),
      scan_types: z
        .array(z.enum(['sast', 'sca', 'iac-security', 'api-security', 'aisc']))
        .optional()
        .describe('Cloud scan types. Ignored by the local engine.'),
      wait: z.boolean().optional().describe('Wait for completion. Default true.')
    },
    handler: async (args) => {
      const response = await client.scanProject({
        engine: args.engine,
        scanTypes: args.scan_types,
        wait: args.wait !== false
      });
      const text = response.waiting
        ? `Project scan started.\n${formatScan(response.scan)}`
        : `Project scan finished.\n${formatScan(response.scan)}`;
      return result(text, { ...response });
    }
  });

  registerTool(server, {
    name: 'checkmarx_scan_file',
    title: 'Scan a single file',
    description:
      'Scans one file. engine="local" (default) runs the ASCA engine on this machine with no upload; engine="cloud" uploads the file for a filtered Checkmarx One scan and requires the user to confirm the upload. Use the local engine after editing code to verify a fix. The file must be inside the workspace. The call waits for completion by default.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      file: z.string().describe('Workspace-relative or absolute path to one file.'),
      engine: z
        .enum(['local', 'cloud'])
        .optional()
        .describe('Scan engine. Defaults to local for MCP file scans; cloud uploads the file and requires confirmation.'),
      wait: z.boolean().optional().describe('Wait for completion. Default true.')
    },
    handler: async (args) => {
      const engine = args.engine ?? 'local';
      const response = await client.scanFile(args.file, { engine, wait: args.wait !== false });
      const findings = response.scan.totalFindings;
      const text = response.waiting
        ? `File scan started for ${args.file}.`
        : `File scan finished for ${args.file}: ${findings} finding${findings === 1 ? '' : 's'}. ${formatScan(response.scan)}`;
      return result(text, { ...response });
    }
  });

  registerTool(server, {
    name: 'checkmarx_get_results',
    title: 'Get scan findings',
    description:
      'Returns findings from the latest scan or a specific scan, with optional severity/type/file filters. Findings include file, line, severity, title, and description. Set include_flow=true to include data-flow nodes.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      scan_id: z.string().optional().describe('Scan id from checkmarx_list_scans. Defaults to the latest scan view.'),
      severity: z.array(severitySchema).optional().describe('Only include these severities.'),
      type: findingTypeSchema.optional().describe('Only include this finding type.'),
      file: z.string().optional().describe('Filter by a workspace-relative or absolute file path.'),
      state: z.string().optional().describe('Filter by Checkmarx state, for example TO_VERIFY.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum findings to return (default 50).'),
      include_flow: z.boolean().optional().describe('Include data-flow nodes. Default false.')
    },
    handler: async (args) => {
      const response = await client.getResults({
        scanId: args.scan_id,
        severity: args.severity as Severity[] | undefined,
        type: args.type,
        file: args.file,
        state: args.state,
        limit: args.limit ?? 50,
        includeFlow: args.include_flow === true
      });
      return result(formatResults(response), { ...response });
    }
  });

  registerTool(server, {
    name: 'checkmarx_get_finding',
    title: 'Get full finding details',
    description:
      'Returns one finding with its full description, remediation advice, data-flow nodes, and surrounding source code. Use the key returned by checkmarx_get_results.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      key: z.string().describe('Finding key or provider id.'),
      include_code: z.boolean().optional().describe('Include surrounding source code. Default true.')
    },
    handler: async (args) => {
      const details = await client.getFinding(args.key, args.include_code !== false);
      if (!details) {
        return errorResult(`Finding not found: ${args.key}`);
      }
      return result(formatFindingDetails(details), { ...details });
    }
  });

  registerTool(server, {
    name: 'checkmarx_get_file_findings',
    title: 'Get findings for a file',
    description:
      'Returns all current findings for one workspace file. Use this before fixing a file, or after a rescan to verify the result.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      file: z.string().describe('Workspace-relative or absolute path.'),
      include_code: z.boolean().optional().describe('Include the surrounding code for each finding. Default true.')
    },
    handler: async (args) => {
      const response = await client.getFileFindings(args.file);
      const includeCode = args.include_code !== false;
      let details: Array<{ key: string; codeContext?: string }> = [];
      if (includeCode && response.findings.length > 0) {
        details = await Promise.all(
          response.findings.slice(0, 20).map(async (finding) => {
            try {
              const detail = await client.getFinding(finding.key, true);
              return { key: finding.key, codeContext: detail?.codeContext };
            } catch {
              return { key: finding.key };
            }
          })
        );
      }
      const contextByKey = new Map(details.map((entry) => [entry.key, entry.codeContext]));
      const text = [
        `${response.findings.length} finding(s) in ${response.relativeFile}:`,
        ...response.findings.map((finding) => formatFindingLine(finding, contextByKey.get(finding.key))),
        '',
        'After editing this file, call checkmarx_scan_file with this path to verify the fix.'
      ].join('\n');
      return result(text, {
        ...response,
        findings: response.findings.map((finding) => ({
          ...finding,
          codeContext: contextByKey.get(finding.key)
        }))
      });
    }
  });

  registerTool(server, {
    name: 'checkmarx_list_scans',
    title: 'List recent scans',
    description: 'Lists recent scan summaries in this workspace, newest first. Use the scan id with checkmarx_get_results.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe('Maximum scans (default 10).')
    },
    handler: async (args) => {
      const scans = await client.listScans(args.limit ?? 10);
      const text =
        scans.length === 0
          ? 'No scans have been run in this workspace yet.'
          : scans.map((scan, index) => `${index + 1}. ${formatScan(scan)}`).join('\n');
      return result(text, { scans });
    }
  });

  registerTool(server, {
    name: 'checkmarx_get_files',
    title: 'List files with findings',
    description: 'Returns files that currently have Checkmarx findings, with severity counts.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {},
    handler: async () => {
      const files = await client.getFiles();
      const text =
        files.length === 0
          ? 'No files currently have Checkmarx findings.'
          : files.map((file) => `${file.relativeFile}: ${file.findings} finding(s) (${formatCounts(file.counts)})`).join('\n');
      return result(text, { files });
    }
  });

  registerTool(server, {
    name: 'checkmarx_cancel_scan',
    title: 'Cancel a running scan',
    description: 'Cancels the active scan, or the specified scan when it is the active one.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      scan_id: z.string().optional().describe('Scan id. Omit to cancel the active scan.')
    },
    handler: async (args) => {
      const cancelled = await client.cancel(args.scan_id);
      return result(cancelled ? 'Scan cancellation requested.' : 'No matching active scan to cancel.', { cancelled });
    }
  });

  registerTool(server, {
    name: 'checkmarx_open_finding',
    title: 'Open a finding in the editor',
    description: 'Reveals a finding in the VS Code editor at its file and line.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      key: z.string().describe('Finding key or provider id.')
    },
    handler: async (args) => {
      const details = await client.getFinding(args.key, false);
      if (!details?.finding.file) {
        return errorResult(`Finding has no file location: ${args.key}`);
      }
      await client.reveal(details.finding.file, details.finding.line, details.finding.column);
      return result(`Opened ${details.finding.relativeFile ?? details.finding.file}:${details.finding.line ?? 1}.`, {
        file: details.finding.file,
        line: details.finding.line
      });
    }
  });

  server.registerPrompt(
    'fix_findings',
    {
      title: 'Fix Checkmarx findings',
      description: 'Fetch current findings, fix the root causes, and verify with a rescan.',
      argsSchema: {
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional().describe('Only fix findings at or above this severity.'),
        file: z.string().optional().describe('Limit remediation to one file.')
      }
    },
    (args) => {
      const target = args.file ? `the file ${args.file}` : 'the workspace';
      const severity = args.severity ? ` with severity ${args.severity} or higher` : '';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Use the Checkmarx tools to review and fix security findings${severity} in ${target}.

1. Call checkmarx_get_results (or checkmarx_get_file_findings for a single file) and choose the highest-severity findings.
2. Call checkmarx_get_finding for each finding to understand the data flow and remediation advice.
3. Edit the source code to fix the root cause. Keep changes minimal and preserve behavior.
4. After each edit, call checkmarx_scan_file for the changed file and confirm the finding is gone.
5. Summarize the fixes and the verification results.

Do not suppress, ignore, or weaken a finding just to make the scan pass. If a finding is a false positive, explain why instead of silently skipping it.`
            }
          }
        ]
      };
    }
  );

  return server;
}

interface ToolRegistration<Schema extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: z.infer<z.ZodObject<Schema>>) => Promise<ReturnType<typeof result> | ReturnType<typeof errorResult>>;
}

function registerTool<Schema extends z.ZodRawShape>(server: McpServer, tool: ToolRegistration<Schema>): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    },
    (async (args: z.infer<z.ZodObject<Schema>>) => {
      try {
        return await tool.handler(args);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }) as never
  );
}

function result(text: string, data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: data
  };
}

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text }]
  };
}

function formatError(error: unknown): string {
  if (error instanceof BridgeError) {
    if (error.code === 'UNREACHABLE' || error.code === 'NO_CONFIG') {
      return `Checkmarx extension is not reachable: ${error.message}`;
    }
    return `Checkmarx error (${error.code}): ${error.message}`;
  }
  return `Checkmarx error: ${error instanceof Error ? error.message : String(error)}`;
}

function formatState(state: BridgeState): string {
  const lines = [
    `Workspace: ${state.workspace}`,
    `Authenticated: ${state.authenticated ? 'yes' : 'no'}`,
    `CLI: ${state.cliAvailable ? `${state.cliVersion ?? 'unknown version'} (${state.cliPath})` : 'not available'}`,
    `Real-time scanning: ${state.realtimeEnabled ? 'enabled' : 'disabled'}`,
    `Findings: ${state.total}${state.total > 0 ? ` (${formatCounts(state.counts)})` : ''}`
  ];
  if (state.active) {
    lines.push(`Active scan: ${formatScan(state.active)}`);
  }
  if (state.latest) {
    lines.push(`Latest scan: ${formatScan(state.latest)}`);
  }
  return lines.join('\n');
}

function formatScan(scan: ScanSummary): string {
  const progress = scan.progress?.message ? ` — ${scan.progress.message}` : '';
  const counts = scan.totalFindings > 0 ? ` (${formatCounts(scan.counts)})` : '';
  return `${scan.id} [${scan.mode}/${scan.engine}] ${scan.status}${progress}: ${scan.totalFindings} finding(s)${counts}`;
}

function formatResults(response: ResultsResponse): string {
  if (response.findings.length === 0) {
    return `No findings matched. Scan: ${response.scan ? formatScan(response.scan) : 'none'}`;
  }
  const lines = [
    `${response.total} finding(s) matched${response.scan ? ` in ${formatScan(response.scan)}` : ''}.`,
    `Counts: ${formatCounts(response.counts)}`,
    ''
  ];
  for (const finding of response.findings) {
    lines.push(formatFindingLine(finding));
  }
  if (response.total > response.findings.length) {
    lines.push('', `Showing the first ${response.findings.length} findings. Increase limit or filter to narrow the results.`);
  }
  return lines.join('\n');
}

function formatFindingLine(finding: Finding, codeContext?: string): string {
  const location = finding.relativeFile ?? finding.file ?? '(no file)';
  const line = finding.line ? `:${finding.line}` : '';
  const cwe = finding.cweId ? ` ${finding.cweId}` : '';
  const cve = finding.cveId ? ` ${finding.cveId}` : '';
  const lines = [
    `- [${finding.severity}] ${finding.title}${cwe}${cve}`,
    `  key: ${finding.key}`,
    `  at ${location}${line} (${finding.type}/${finding.engine})`
  ];
  if (finding.packageName) {
    lines.push(`  package: ${finding.packageName}${finding.packageVersion ? `@${finding.packageVersion}` : ''}`);
  }
  if (codeContext) {
    lines.push('  code:', indent(codeContext, 4));
  } else if (finding.codeSnippet) {
    lines.push(`  code: ${finding.codeSnippet.trim()}`);
  }
  return lines.join('\n');
}

function formatFindingDetails(details: FindingDetails): string {
  const finding = details.finding;
  const lines = [formatFindingLine(finding), ''];
  if (finding.description) {
    lines.push('Description:', indent(finding.description, 2), '');
  }
  if (finding.remediation) {
    lines.push('Remediation:', indent(finding.remediation, 2), '');
  }
  if (finding.nodes?.length) {
    lines.push('Data flow:');
    finding.nodes.forEach((node, index) => {
      const location = node.file ?? node.fileName ?? '(unknown)';
      lines.push(`  ${index + 1}. ${location}${node.line ? `:${node.line}` : ''}${node.name ? ` — ${node.name}` : ''}`);
    });
    lines.push('');
  }
  if (details.codeContext) {
    lines.push(`Code (${details.codeStartLine}-${details.codeEndLine}):`, '```', details.codeContext, '```');
  } else if (finding.codeSnippet) {
    lines.push('Code:', finding.codeSnippet);
  }
  return lines.join('\n');
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
