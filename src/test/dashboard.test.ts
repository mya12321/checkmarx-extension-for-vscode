import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDashboardHtml } from '../ui/dashboardHtml';
import { emptyDashboardState } from '../ui/dashboardState';

test('dashboard HTML exposes all primary scan and session actions', () => {
  const html = renderDashboardHtml('vscode-webview://test', 'test-nonce');
  for (const action of [
    'scanProjectCloud',
    'scanProjectLocal',
    'setApplication',
    'scanFileCloud',
    'scanFileLocal',
    'realtime',
    'cancel',
    'installCli',
    'selectCli',
    'showResults',
    'clearResults',
    'restartMcp',
    'openSettings',
    'logout',
    'loginButton'
  ]) {
    assert.match(html, new RegExp(`(data-action="${action}"|id="${action}")`), `missing ${action}`);
  }
  assert.match(html, /id="baseUri"/);
  assert.match(html, /id="tenant"/);
  assert.match(html, /id="apiKey"/);
  assert.match(html, /id="realtime"/);
  assert.match(html, /nonce="test-nonce"/);
  assert.match(html, /Content-Security-Policy/);
});

test('dashboard empty state has zero counts and no active scan', () => {
  const state = emptyDashboardState();
  assert.equal(state.total, 0);
  assert.equal(state.active, undefined);
  assert.equal(state.counts.HIGH, 0);
  assert.equal(state.authenticated, false);
});
