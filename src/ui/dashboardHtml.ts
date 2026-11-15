export function renderDashboardHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Checkmarx Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 10px 10px 24px;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: transparent;
  }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .brand svg { flex: 0 0 auto; color: var(--vscode-textLink-foreground); }
  .brand-text { min-width: 0; }
  .brand-title { font-weight: 600; font-size: 13px; }
  .brand-sub { color: var(--vscode-descriptionForeground); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon-button { background: transparent; border: 0; color: var(--vscode-foreground); cursor: pointer; padding: 2px 4px; border-radius: 3px; font-size: 14px; }
  .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .card {
    background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 8px;
  }
  h2 { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 0 0 8px; font-weight: 600; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .section-head h2 { margin: 0; }
  .section-head .badge { max-width: 55%; overflow: hidden; text-overflow: ellipsis; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 9px; font-weight: 700; letter-spacing: .04em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .badge.ok { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
  .badge.warn { background: var(--vscode-editorWarning-foreground, #cca700); color: #1f1f1f; }
  .badge.err { background: var(--vscode-errorForeground, #f14c4c); color: #fff; }
  .badge.info { background: var(--vscode-textLink-foreground, #3794ff); color: #fff; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 10px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.45; word-break: break-word; }
  button { font-family: inherit; }
  button.action {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    padding: 7px 8px;
    margin-top: 6px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
  }
  button.action:first-of-type { margin-top: 0; }
  button.action:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); border-color: var(--vscode-focusBorder); }
  button.action:disabled { opacity: .45; cursor: not-allowed; }
  button.action .glyph { flex: 0 0 auto; width: 18px; text-align: center; font-size: 14px; opacity: .9; }
  button.action b { display: block; font-weight: 600; font-size: 11px; }
  button.action small { display: block; font-size: 9px; opacity: .78; margin-top: 1px; }
  button.primary, button.secondary { border: 0; border-radius: 3px; padding: 5px 9px; cursor: pointer; font-size: 11px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.link { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 10px; }
  button.link:hover { text-decoration: underline; }
  .wide { width: 100%; }
  .button-row { display: flex; gap: 6px; margin-top: 8px; }
  .button-row button { flex: 1; }
  label { display: block; margin: 6px 0 0; color: var(--vscode-descriptionForeground); font-size: 10px; }
  input, select {
    width: 100%;
    margin-top: 3px;
    padding: 4px 6px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 11px;
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .optional { opacity: .7; }
  .error { color: var(--vscode-errorForeground); font-size: 10px; margin-top: 6px; line-height: 1.4; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 10px; margin: 0 0 6px; line-height: 1.4; }
  .switch { position: relative; display: inline-block; width: 34px; height: 18px; flex: 0 0 auto; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
  .switch span { position: absolute; inset: 0; border-radius: 18px; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); cursor: pointer; transition: .15s; }
  .switch span:before { content: ""; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; border-radius: 50%; background: var(--vscode-foreground); transition: .15s; }
  .switch input:checked + span { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .switch input:checked + span:before { transform: translateX(16px); background: var(--vscode-button-foreground); }
  .switch input:disabled + span { opacity: .45; cursor: not-allowed; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-progressBar-background); opacity: .35; overflow: hidden; margin-top: 7px; }
  .bar > div { height: 100%; width: 0; background: var(--vscode-progressBar-background); transition: width .25s ease; }
  .bar.indeterminate > div { width: 35% !important; animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
  .severity { display: grid; grid-template-columns: 50px 1fr 22px; align-items: center; gap: 6px; margin: 4px 0; font-size: 9px; color: var(--vscode-descriptionForeground); }
  .severity .track { height: 5px; border-radius: 3px; background: var(--vscode-progressBar-background); opacity: .3; overflow: hidden; }
  .severity .fill { height: 100%; width: 0; }
  .fill.CRITICAL, .fill.HIGH { background: var(--vscode-errorForeground, #f14c4c); }
  .fill.MEDIUM { background: var(--vscode-editorWarning-foreground, #cca700); }
  .fill.LOW { background: var(--vscode-textLink-foreground, #3794ff); }
  .fill.INFO { background: var(--vscode-descriptionForeground, #9d9d9d); }
  .severity b { text-align: right; color: var(--vscode-foreground); font-weight: 600; }
  .file { font-size: 10px; color: var(--vscode-foreground); background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 4px 6px; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toast { position: fixed; left: 10px; right: 10px; bottom: 10px; padding: 7px 9px; border-radius: 4px; font-size: 10px; line-height: 1.4; background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border)); color: var(--vscode-notifications-foreground, var(--vscode-foreground)); box-shadow: 0 2px 8px rgba(0,0,0,.3); z-index: 10; }
  .toast.error { border-color: var(--vscode-errorForeground); }
  .toast.success { border-color: var(--vscode-testing-iconPassed, #2ea043); }
  .divider { height: 1px; background: var(--vscode-panel-border); margin: 8px 0; }
  .app-row { margin: -2px 0 7px; align-items: flex-start; }
  .app-row .meta { flex: 1; }
  .app-row .link { flex: 0 0 auto; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="top">
    <div class="brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.25 4.5 5.1v6.02c0 4.63 3.2 8.95 7.5 10.63 4.3-1.68 7.5-6 7.5-10.63V5.1L12 2.25Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="m8.65 11.65 2.2 2.2 4.5-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="brand-text">
        <div class="brand-title">Checkmarx</div>
        <div class="brand-sub" id="workspace">Loading workspace…</div>
      </div>
    </div>
    <button class="icon-button" id="refresh" title="Refresh dashboard" aria-label="Refresh dashboard">⟳</button>
  </div>

  <div id="toast" class="toast" hidden></div>

  <section class="card" id="accountCard" hidden>
    <div class="row">
      <span class="badge ok" id="authBadge">Signed in</span>
      <button class="link" data-action="logout">Sign out</button>
    </div>
    <div class="meta" id="accountMeta">—</div>
  </section>

  <section class="card" id="loginCard">
    <h2>Sign in with API key</h2>
    <p class="hint">The key is stored in VS Code SecretStorage and passed to the CLI through an environment variable. Local ASCA scans work without signing in.</p>
    <label>Region
      <select id="region">
        <option value="us">Checkmarx One US</option>
        <option value="eu">Checkmarx One EU</option>
        <option value="custom">Custom / on-premises</option>
      </select>
    </label>
    <label>Base URI<input id="baseUri" type="url" placeholder="https://ast.checkmarx.net" autocomplete="off" spellcheck="false"></label>
    <label>IAM URI <span class="optional">(optional)</span><input id="baseAuthUri" type="url" placeholder="https://iam.checkmarx.net" autocomplete="off" spellcheck="false"></label>
    <label>Tenant<input id="tenant" type="text" placeholder="my-tenant" autocomplete="off" spellcheck="false"></label>
    <label>API key<input id="apiKey" type="password" placeholder="Paste your API key" autocomplete="off"></label>
    <div id="loginError" class="error" hidden></div>
    <div class="button-row">
      <button class="primary wide" id="loginButton">Sign in</button>
    </div>
  </section>

  <section class="card">
    <div class="section-head">
      <h2>Project scan</h2>
      <span class="badge" id="projectBadge">—</span>
    </div>
    <div class="row app-row">
      <span class="meta" id="applicationLine">Application: not set</span>
      <button class="link" id="setApplication" data-action="setApplication">Set</button>
    </div>
    <button class="action" id="projectCloud" data-action="scanProjectCloud">
      <span class="glyph">☁</span>
      <span><b>Upload project to cloud</b><small>Full Checkmarx One scan</small></span>
    </button>
    <button class="action" id="projectLocal" data-action="scanProjectLocal">
      <span class="glyph">⌂</span>
      <span><b>Scan project locally</b><small>Local ASCA engine, no upload</small></span>
    </button>
  </section>

  <section class="card">
    <div class="section-head">
      <h2>Current file</h2>
      <span class="badge" id="fileBadge">—</span>
    </div>
    <div class="file" id="currentFile">No active editor file</div>
    <button class="action" id="fileCloud" data-action="scanFileCloud">
      <span class="glyph">☁</span>
      <span><b>Upload file to cloud</b><small>Filtered Checkmarx One scan</small></span>
    </button>
    <button class="action" id="fileLocal" data-action="scanFileLocal">
      <span class="glyph">⌂</span>
      <span><b>Scan file locally</b><small>Local ASCA engine, no upload</small></span>
    </button>
  </section>

  <section class="card">
    <div class="row">
      <div>
        <h2 style="margin-bottom:2px">Real-time scan</h2>
        <div class="meta" id="realtimeMeta">Disabled</div>
      </div>
      <label class="switch" title="Toggle real-time scanning">
        <input type="checkbox" id="realtime">
        <span></span>
      </label>
    </div>
    <div class="meta" id="realtimeHint">Scans the active file on save or while typing.</div>
  </section>

  <section class="card" id="progressCard" hidden>
    <div class="row">
      <span class="badge info" id="activeBadge">Scanning</span>
      <button class="link" id="cancelButton" data-action="cancel">Cancel</button>
    </div>
    <div class="meta" id="activeTitle" style="margin-top:6px"></div>
    <div class="meta" id="activeMessage"></div>
    <div class="bar" id="activeBar"><div></div></div>
  </section>

  <section class="card">
    <div class="section-head">
      <h2>Findings</h2>
      <span class="badge" id="totalBadge">0</span>
    </div>
    <div class="severity"><span>Critical</span><div class="track"><div class="fill CRITICAL" data-fill="CRITICAL"></div></div><b data-count="CRITICAL">0</b></div>
    <div class="severity"><span>High</span><div class="track"><div class="fill HIGH" data-fill="HIGH"></div></div><b data-count="HIGH">0</b></div>
    <div class="severity"><span>Medium</span><div class="track"><div class="fill MEDIUM" data-fill="MEDIUM"></div></div><b data-count="MEDIUM">0</b></div>
    <div class="severity"><span>Low</span><div class="track"><div class="fill LOW" data-fill="LOW"></div></div><b data-count="LOW">0</b></div>
    <div class="severity"><span>Info</span><div class="track"><div class="fill INFO" data-fill="INFO"></div></div><b data-count="INFO">0</b></div>
    <div class="meta" id="latestLine" style="margin-top:8px">No scans yet.</div>
    <div class="button-row">
      <button class="primary" id="showResults" data-action="showResults">Open results</button>
      <button class="secondary" id="clearResults" data-action="clearResults">Clear</button>
    </div>
  </section>

  <section class="card">
    <div class="section-head">
      <h2>Checkmarx CLI</h2>
      <span class="badge" id="cliBadge">—</span>
    </div>
    <div class="meta" id="cliPath">Not found</div>
    <div class="button-row">
      <button class="secondary" id="installCli" data-action="installCli">Install / update</button>
      <button class="secondary" id="selectCli" data-action="selectCli">Select path</button>
    </div>
  </section>

  <section class="card">
    <div class="section-head">
      <h2>MCP server</h2>
      <span class="badge" id="mcpBadge">—</span>
    </div>
    <div class="meta" id="mcpMeta">The MCP server lets AI agents read findings and rescan files.</div>
    <div class="button-row">
      <button class="secondary" id="restartMcp" data-action="restartMcp">Restart MCP</button>
      <button class="secondary" id="openSettings" data-action="openSettings">Settings</button>
    </div>
  </section>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const REGIONS = {
    us: { base: 'https://ast.checkmarx.net', auth: 'https://iam.checkmarx.net' },
    eu: { base: 'https://eu.ast.checkmarx.net', auth: 'https://eu.iam.checkmarx.net' }
  };
  let lastState;
  let formInitialized = false;
  let toastTimer;

  function text(id, value) {
    const element = $(id);
    if (element) { element.textContent = value == null ? '' : String(value); }
  }

  function badge(id, label, kind) {
    const element = $(id);
    if (!element) { return; }
    element.textContent = label;
    element.className = 'badge' + (kind ? ' ' + kind : '');
  }

  function showError(message) {
    const element = $('loginError');
    if (!element) { return; }
    element.textContent = message || '';
    element.hidden = !message;
  }

  function toast(message, kind) {
    const element = $('toast');
    if (!element) { return; }
    element.textContent = message;
    element.className = 'toast' + (kind ? ' ' + kind : '');
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { element.hidden = true; }, 5000);
  }

  function shorten(value, max) {
    if (!value) { return ''; }
    if (value.length <= max) { return value; }
    return '…' + value.slice(value.length - max + 1);
  }

  function updateFormDefaults(state) {
    if (formInitialized || state.authenticated) { return; }
    formInitialized = true;
    if (state.baseUri) { $('baseUri').value = state.baseUri; }
    if (state.baseAuthUri) { $('baseAuthUri').value = state.baseAuthUri; }
    if (state.tenant) { $('tenant').value = state.tenant; }
    const known = Object.keys(REGIONS).find(function (key) { return REGIONS[key].base === state.baseUri; });
    if (known) {
      $('region').value = known;
      $('baseAuthUri').value = REGIONS[known].auth;
    } else if (!state.baseUri) {
      $('region').value = 'us';
      $('baseUri').value = REGIONS.us.base;
      $('baseAuthUri').value = REGIONS.us.auth;
    } else {
      $('region').value = 'custom';
    }
  }

  function render(state) {
    lastState = state;
    text('workspace', state.projectName || state.workspace || 'Workspace');
    text('projectBadge', state.projectName || 'workspace');
    text('applicationLine', state.applicationName ? 'Application: ' + state.applicationName : 'Application: not set');
    $('applicationLine').className = 'meta' + (state.applicationName ? '' : ' small');
    $('applicationLine').style.color = state.applicationName ? '' : 'var(--vscode-editorWarning-foreground)';
    $('setApplication').textContent = state.applicationName ? 'Change' : 'Set';

    const authenticated = Boolean(state.authenticated);
    $('loginCard').hidden = authenticated;
    $('accountCard').hidden = !authenticated;
    if (authenticated) {
      const tenant = state.tenant ? 'Tenant: ' + state.tenant : 'Tenant: not set';
      const base = state.baseUri ? ' · ' + state.baseUri : '';
      text('accountMeta', tenant + base);
      badge('authBadge', 'Signed in', 'ok');
    } else {
      updateFormDefaults(state);
    }

    const active = Boolean(state.active);
    $('projectCloud').disabled = !authenticated || active;
    $('projectLocal').disabled = !state.cliAvailable || active;
    $('fileCloud').disabled = !authenticated || !state.activeFile || active;
    $('fileLocal').disabled = !state.cliAvailable || !state.activeFile || active;
    $('installCli').disabled = active;
    $('selectCli').disabled = active;
    text('currentFile', state.activeFile ? shorten(state.activeFile, 52) : 'No active editor file');
    $('currentFile').title = state.activeFile || '';
    badge('fileBadge', state.activeFile ? 'editor' : 'none', state.activeFile ? 'info' : '');

    $('realtime').checked = Boolean(state.realtimeEnabled);
    $('realtime').disabled = !state.cliAvailable;
    text('realtimeMeta', state.realtimeEnabled ? 'Enabled · ' + (state.realtimeTrigger === 'onType' ? 'while typing' : 'on save') : 'Disabled');
    text('realtimeHint', state.cliAvailable ? 'Scans the active file on save or while typing.' : 'Install the Checkmarx CLI to enable real-time scanning.');

    if (state.cliAvailable) {
      badge('cliBadge', state.cliVersion ? 'v' + state.cliVersion : 'ready', 'ok');
      text('cliPath', state.cliPath || 'cx');
    } else {
      badge('cliBadge', 'missing', 'warn');
      text('cliPath', 'Checkmarx CLI (cx) was not found.');
    }

    badge('mcpBadge', state.mcpRunning ? 'running' : 'stopped', state.mcpRunning ? 'ok' : 'warn');
    text('mcpMeta', state.mcpRunning
      ? 'Registered with VS Code. AI agents can read findings and rescan files.'
      : 'MCP server is not running. Enable it in settings or restart it.');

    if (active) {
      $('progressCard').hidden = false;
      const scan = state.active;
      const progress = scan.progress || {};
      badge('activeBadge', (scan.mode === 'project' ? 'Project' : 'File') + ' · ' + scan.engine, 'info');
      text('activeTitle', scan.status + ' · ' + (scan.file || scan.projectName || 'workspace'));
      text('activeMessage', progress.message || 'Working…');
      const bar = $('activeBar');
      const fill = bar.firstElementChild;
      if (typeof progress.current === 'number' && typeof progress.total === 'number' && progress.total > 0) {
        bar.classList.remove('indeterminate');
        fill.style.width = Math.max(2, Math.min(100, Math.round((progress.current / progress.total) * 100))) + '%';
      } else {
        bar.classList.add('indeterminate');
        fill.style.width = '35%';
      }
    } else {
      $('progressCard').hidden = true;
    }

    text('totalBadge', String(state.total || 0));
    const severities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
    const max = Math.max(1, state.total || 0);
    severities.forEach(function (severity) {
      const count = (state.counts && state.counts[severity]) || 0;
      const countElement = document.querySelector('[data-count="' + severity + '"]');
      if (countElement) { countElement.textContent = String(count); }
      const fill = document.querySelector('[data-fill="' + severity + '"]');
      if (fill) { fill.style.width = Math.round((count / max) * 100) + '%'; }
    });

    if (state.latest) {
      const latest = state.latest;
      text('latestLine', 'Latest: ' + latest.mode + ' / ' + latest.engine + ' · ' + latest.status + ' · ' + latest.totalFindings + ' findings');
    } else {
      text('latestLine', 'No scans yet.');
    }

    $('clearResults').disabled = !state.total && !state.latest;
    $('showResults').disabled = !state.total;
  }

  ['baseUri', 'baseAuthUri', 'tenant', 'apiKey'].forEach(function (id) {
    const input = $(id);
    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          $('loginButton').click();
        }
      });
    }
  });

  $('region').addEventListener('change', function () {
    const region = REGIONS[$('region').value];
    if (region) {
      $('baseUri').value = region.base;
      $('baseAuthUri').value = region.auth;
    }
  });

  $('loginButton').addEventListener('click', function () {
    const input = {
      baseUri: $('baseUri').value.trim(),
      baseAuthUri: $('baseAuthUri').value.trim(),
      tenant: $('tenant').value.trim(),
      apiKey: $('apiKey').value.trim()
    };
    if (!input.baseUri || !input.tenant || !input.apiKey) {
      showError('Base URI, tenant and API key are required.');
      return;
    }
    showError('');
    $('loginButton').disabled = true;
    $('loginButton').textContent = 'Signing in…';
    vscode.postMessage({ type: 'login', input: input });
  });

  $('realtime').addEventListener('change', function () {
    vscode.postMessage({ type: 'toggleRealtime' });
  });

  document.querySelectorAll('[data-action]').forEach(function (button) {
    button.addEventListener('click', function () {
      const action = button.getAttribute('data-action');
      if (action) {
        vscode.postMessage({ type: action });
      }
    });
  });

  $('refresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || !message.type) { return; }
    if (message.type === 'state') {
      render(message.state);
    } else if (message.type === 'loginResult') {
      $('loginButton').disabled = false;
      $('loginButton').textContent = 'Sign in';
      if (message.ok) {
        $('apiKey').value = '';
        showError('');
        toast('Signed in to Checkmarx.', 'success');
      } else {
        showError(message.error || 'Sign in failed.');
      }
    } else if (message.type === 'toast') {
      toast(message.message || '', message.kind || '');
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}