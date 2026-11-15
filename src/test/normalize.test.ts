import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeAscaResults } from '../findings/normalizeAsca';
import { normalizeCloudResults } from '../findings/normalizeCloud';

const root = '/workspace/project';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), 'src', 'test', 'fixtures', name), 'utf8'));
}

test('normalizes cloud SAST, IaC and SCA findings', () => {
  const findings = normalizeCloudResults(fixture('cx_result.json'), {
    root,
    scanId: 'scan-1',
    mode: 'project'
  });

  assert.equal(findings.length, 4);

  const sast = findings.filter((finding) => finding.type === 'sast');
  assert.equal(sast.length, 2);
  assert.equal(sast[0]!.severity, 'HIGH');
  assert.equal(sast[0]!.title, 'Client_DOM_Stored_XSS');
  assert.equal(sast[0]!.relativeFile, 'challenge8-js.testdata');
  assert.equal(sast[0]!.line, 18);
  assert.equal(sast[0]!.cweId, 'CWE-79');
  assert.ok(sast[0]!.nodes && sast[0]!.nodes.length === 3);

  const iac = findings.find((finding) => finding.type === 'iac');
  assert.ok(iac);
  assert.equal(iac!.relativeFile, 'Dockerfile_desktop');
  assert.equal(iac!.severity, 'HIGH');

  const sca = findings.find((finding) => finding.type === 'sca');
  assert.ok(sca);
  assert.equal(sca!.packageName, 'com.thoughtworks.xstream:xstream');
  assert.equal(sca!.packageVersion, '1.4.5');
  assert.equal(sca!.recommendedVersion, '1.4.20');
  assert.equal(sca!.cveId, 'CVE-2013-7285');
  assert.match(sca!.remediation ?? '', /1\.4\.20/);
});

test('normalizes ASCA local findings using the scanned path', () => {
  const findings = normalizeAscaResults(fixture('asca_result.json'), {
    root,
    scanId: 'scan-2',
    mode: 'file',
    reportedFile: `${root}/test-vuln.py`
  });

  assert.equal(findings.length, 2);
  const sql = findings.find((finding) => finding.id === '4001');
  assert.ok(sql);
  assert.equal(sql!.severity, 'HIGH');
  assert.equal(sql!.type, 'sast');
  assert.equal(sql!.engine, 'local');
  assert.equal(sql!.relativeFile, 'test-vuln.py');
  assert.equal(sql!.line, 6);
  assert.match(sql!.remediation ?? '', /prepared statements/i);
  assert.match(sql!.codeSnippet ?? '', /SELECT/);
});

test('cloud findings get stable keys across scans', () => {
  const first = normalizeCloudResults(fixture('cx_result.json'), { root, scanId: 'a', mode: 'project' });
  const second = normalizeCloudResults(fixture('cx_result.json'), { root, scanId: 'b', mode: 'project' });
  assert.deepEqual(
    first.map((finding) => finding.key),
    second.map((finding) => finding.key)
  );
});