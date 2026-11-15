import { normalizeSeverity } from '../severity';
import { resolveWorkspaceFile, relativeToRoot, stableFindingKey, stripHtml } from '../paths';
import type { Finding, FindingType, FlowNode, ScanEngine, ScanMode } from '../types';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  getPath,
  pickNumber,
  pickString,
  severityFromCvss
} from './util';

export interface NormalizeCloudOptions {
  root: string;
  scanId: string;
  mode: ScanMode;
  engine?: ScanEngine;
}

function normalizeType(result: unknown): FindingType {
  const record = asRecord(result);
  const type = (asString(record?.type) ?? asString(record?.label) ?? '').toLowerCase();
  if (type === 'sast') {
    return 'sast';
  }
  if (type === 'sca') {
    return 'sca';
  }
  if (type === 'kics' || type === 'iac-security' || type === 'iac') {
    return 'iac';
  }
  if (type === 'secret' || type === 'secrets' || type === 'secret-detection' || type === 'scs' || type === 'sscs') {
    return 'secret';
  }
  return 'other';
}

function nodeToFlowNode(node: unknown, root: string): FlowNode | undefined {
  const record = asRecord(node);
  if (!record) {
    return undefined;
  }
  const reported = pickString(record, ['fileName', 'filename', 'file', 'path']);
  const file = resolveWorkspaceFile(root, reported);
  const line = pickNumber(record, ['line', 'startLine']);
  if (!file && line === undefined) {
    return undefined;
  }
  return {
    fileName: reported,
    file,
    line,
    column: pickNumber(record, ['column', 'startColumn']),
    endLine: pickNumber(record, ['endLine']),
    name: asString(record.name),
    method: asString(record.method),
    domType: asString(record.domType),
    fullName: asString(record.fullName)
  };
}

function sastLocation(data: unknown, root: string): { file?: string; line?: number; column?: number; length?: number; nodes: FlowNode[] } {
  const nodes = asArray(asRecord(data)?.nodes)
    .map((node) => nodeToFlowNode(node, root))
    .filter((node): node is FlowNode => Boolean(node));

  const sink = [...nodes].reverse().find((node) => node.file && node.line !== undefined) ?? [...nodes].reverse().find((node) => node.file);
  return {
    file: sink?.file,
    line: sink?.line,
    column: sink?.column,
    length: undefined,
    nodes
  };
}

function scaLocation(data: unknown, root: string): { file?: string; line?: number; column?: number; length?: number; nodes: FlowNode[] } {
  const packageData = asRecord(asRecord(data)?.scaPackageData);
  const locations = asArray(packageData?.locations);
  const first = locations.find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const file = resolveWorkspaceFile(root, first ?? pickString(data, ['locations.0', 'fileName', 'filename']));
  return {
    file,
    line: 1,
    column: 1,
    length: undefined,
    nodes: file ? [{ file, line: 1, fileName: first }] : []
  };
}

function genericLocation(data: unknown, root: string): { file?: string; line?: number; column?: number; length?: number; nodes: FlowNode[] } {
  const reported = pickString(data, [
    'filename',
    'fileName',
    'file',
    'path',
    'filePath',
    'sourceFile',
    'location.file',
    'location.fileName',
    'location.path'
  ]);
  const file = resolveWorkspaceFile(root, reported);
  const line = pickNumber(data, ['line', 'startLine', 'location.line', 'location.startLine']);
  const column = pickNumber(data, ['column', 'startColumn', 'location.column']);
  return {
    file,
    line: line ?? (file ? 1 : undefined),
    column: column ?? (file ? 1 : undefined),
    length: pickNumber(data, ['length', 'location.length']),
    nodes: file ? [{ file, line: line ?? 1, column, fileName: reported }] : []
  };
}

function packageIdentity(data: unknown): { name?: string; version?: string } {
  const packageData = asRecord(asRecord(data)?.scaPackageData);
  const dependencyPaths = asArray(packageData?.dependencyPaths);
  const firstPath = asArray(dependencyPaths[0]);
  const lastDependency = asRecord(firstPath.at(-1));
  const name = asString(lastDependency?.name) ?? asString(packageData?.name);
  const version = asString(lastDependency?.version) ?? asString(packageData?.version);
  return { name, version };
}

function cloudTitle(type: FindingType, result: Record<string, unknown>, data: Record<string, unknown> | undefined): string {
  if (type === 'sca') {
    const { name, version } = packageIdentity(data);
    if (name) {
      return version ? `${name}@${version}` : name;
    }
    return pickString(data, ['scaPackageData.id', 'packageIdentifier', 'id']) ?? asString(result.id) ?? 'Vulnerable dependency';
  }

  const queryName = pickString(data, ['queryName', 'ruleName', 'rule_name', 'query.name']);
  if (queryName) {
    return queryName;
  }

  const label = asString(result.label);
  if (label && label.toLowerCase() !== type) {
    return label;
  }

  const description = stripHtml(asString(result.descriptionHTML) ?? asString(result.description));
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine) {
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }

  return `${type.toUpperCase()} finding`;
}

function cloudRemediation(type: FindingType, data: Record<string, unknown> | undefined): string | undefined {
  const explicit = pickString(data, ['remediation', 'remediationAdvise', 'fixRecommendation']);
  if (explicit) {
    return explicit;
  }

  if (type === 'sca') {
    const recommendedVersion = pickString(data, ['recommendedVersion']);
    if (recommendedVersion) {
      const { name } = packageIdentity(data);
      if (name) {
        return `Upgrade ${name} to version ${recommendedVersion} and update the lock file.`;
      }
      return `Upgrade the vulnerable package to version ${recommendedVersion} and update the lock file.`;
    }
    const fixLink = pickString(data, ['scaPackageData.fixLink']);
    if (fixLink) {
      return `See the fix guidance: ${fixLink}`;
    }
  }

  if (type === 'iac') {
    const expected = pickString(data, ['expectedValue']);
    const actual = pickString(data, ['value']);
    if (expected || actual) {
      return [expected, actual].filter(Boolean).join('\n');
    }
  }

  return undefined;
}

function cweIdOf(result: Record<string, unknown>): string | undefined {
  const raw = getPath(result, ['vulnerabilityDetails', 'cweId']) ?? getPath(result, ['data', 'cweId']);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return `CWE-${raw}`;
  }
  const text = asString(raw);
  if (!text) {
    return undefined;
  }
  return /^cwe[-_ ]?\d+$/i.test(text) ? text.toUpperCase().replace(/^CWE[-_ ]?/i, 'CWE-') : text;
}

export function normalizeCloudResults(payload: unknown, options: NormalizeCloudOptions): Finding[] {
  const rootRecord = asRecord(payload);
  const results = asArray(rootRecord?.results ?? (Array.isArray(payload) ? payload : []));
  const findings = new Map<string, Finding>();

  results.forEach((rawResult, index) => {
    const result = asRecord(rawResult);
    if (!result) {
      return;
    }

    const type = normalizeType(result);
    const data = asRecord(result.data);
    const location =
      type === 'sast'
        ? sastLocation(data, options.root)
        : type === 'sca'
          ? scaLocation(data, options.root)
          : genericLocation(data, options.root);

    const vulnerabilityDetails = asRecord(result.vulnerabilityDetails);
    const severity = result.severity
      ? normalizeSeverity(result.severity)
      : severityFromCvss(asNumber(vulnerabilityDetails?.cvssScore));
    const description = stripHtml(asString(result.descriptionHTML) ?? asString(result.description));
    const title = cloudTitle(type, result, data);
    const { name: packageName, version: packageVersion } = packageIdentity(data);
    const resultId = asString(result.id) ?? asString(result.similarityId) ?? `result-${index}`;
    const idText = asString(result.id);
    const cveId = idText && /^CVE-\d{4}-\d+$/i.test(idText) ? idText.toUpperCase() : pickString(vulnerabilityDetails, ['cveName']);
    const relativeFile = relativeToRoot(options.root, location.file);
    const key = stableFindingKey([
      type,
      resultId,
      relativeFile,
      location.line,
      location.column,
      title
    ]);

    const finding: Finding = {
      key,
      id: resultId,
      scanId: options.scanId,
      mode: options.mode,
      engine: options.engine ?? 'cloud',
      type,
      severity,
      title,
      description,
      remediation: cloudRemediation(type, data),
      file: location.file,
      relativeFile,
      line: location.line,
      column: location.column,
      length: location.length,
      language: pickString(data, ['languageName', 'language']),
      cweId: cweIdOf(result),
      cveId,
      queryName: pickString(data, ['queryName', 'ruleName']),
      group: pickString(data, ['group', 'category']),
      state: asString(result.state),
      status: asString(result.status),
      firstFoundAt: asString(result.firstFoundAt),
      packageName,
      packageVersion,
      recommendedVersion: pickString(data, ['recommendedVersion']),
      nodes: location.nodes
    };

    const existing = findings.get(key);
    if (!existing) {
      findings.set(key, finding);
      return;
    }

    // The same finding can be returned multiple times (for example one SAST flow
    // per node). Keep the richest record.
    if (!existing.file && finding.file) {
      findings.set(key, finding);
    }
  });

  return [...findings.values()];
}
