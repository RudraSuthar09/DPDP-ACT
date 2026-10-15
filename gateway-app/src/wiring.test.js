// Plain-node STATIC test: `node src/wiring.test.js`. Checks that the
// renderer, preload and main process agree with each other, and that the
// Electron security settings this app depends on stay in place.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const html = read('index.html');
const renderer = read('renderer.js');
const preload = read('preload.js');
const main = read('main.js');

check('every element id the renderer looks up exists in index.html', () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...renderer.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]).filter((id) => !ids.has(id));
  assert.deepStrictEqual(missing, []);
});

check('every window.gateway.* call in the renderer is exposed by the preload bridge', () => {
  const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
  const missing = [...new Set([...renderer.matchAll(/window\.gateway\.(\w+)/g)].map((m) => m[1]))].filter((m) => !exposed.has(m));
  assert.deepStrictEqual(missing, []);
});

check('every enrollment error code the agent can report has wizard text (agent startup-tasks.ts)', () => {
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'src', 'startup-tasks.ts'), 'utf8');
  const union = /export type EnrollmentErrorCode =([\s\S]*?);/.exec(agentSrc);
  assert.ok(union, 'EnrollmentErrorCode union not found');
  const codes = [...union[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 7);
  const text = /const ENROLLMENT_ERROR_TEXT = \{([\s\S]*?)\n\};/.exec(renderer)[1];
  assert.deepStrictEqual(codes.filter((c) => !new RegExp(`^\\s+${c}:`, 'm').test(text)), []);
});

check('every IPC channel the preload invokes has a main-process handler, and nothing else is handled', () => {
  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
  assert.deepStrictEqual([...invoked].sort(), [...handled].sort());
});

check('the preload exposes only named functions -- no raw ipcRenderer, send, or on()', () => {
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(preload));
  assert.ok(!/ipcRenderer\.(send|on|sendSync)\(/.test(preload));
});

check('the window keeps contextIsolation, sandbox, no nodeIntegration, no webview', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /webviewTag:\s*false/);
});

check('navigation and new windows are blocked', () => {
  assert.match(main, /'will-navigate',\s*\(event\)\s*=>\s*event\.preventDefault\(\)/);
  assert.match(main, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/);
});

check('openExternal is only reachable through workspace-URL validation', () => {
  const handler = main.slice(main.indexOf("'gateway:open-external'"));
  assert.ok(handler.indexOf('validateWorkspaceUrl') < handler.indexOf('shell.openExternal'));
});

check('the page has a strict CSP and loads no remote content', () => {
  assert.match(html, /Content-Security-Policy" content="default-src 'self'; script-src 'self'/);
  assert.ok(!/(src|href)="https?:/i.test(html));
});

check('the renderer never requires Node modules', () => {
  assert.ok(!/\brequire\(/.test(renderer));
});

check('main.js builds PowerShell commands only via elevated-command.js', () => {
  const spawns = main.match(/spawn\(/g) || [];
  assert.strictEqual(spawns.length, 1);
  assert.match(main, /buildElevatedCommand\(LAYOUT\.helperPath, action, files\.requestPath\)/);
});

console.log(`\n${passed} passed`);
