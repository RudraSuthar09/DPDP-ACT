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

check('the folder is chosen with the native picker, never typed', () => {
  // The customer's path field is read-only, with a picker button beside it,
  // and shows no example path to invite typing. (The Advanced pane keeps a
  // typed field on purpose, for support cases — a different element.)
  const rootField = /<input[^>]*id="source-root"[^>]*>/.exec(html);
  assert.ok(rootField, 'source-root field not found');
  assert.ok(rootField[0].includes('readonly'), 'the folder path must not be typeable');
  assert.ok(!/placeholder="[A-Z]:\\/.test(rootField[0]), 'no path placeholder on the customer field');
  assert.ok(html.includes('id="btn-pick-folder"'));
  assert.ok(renderer.includes('window.gateway.pickFolder()'));
});

check('the customer folder flow asks for NO ids at all', () => {
  // Both id fields are gone from the customer pane. The only remaining id
  // input lives inside the Advanced disclosure.
  assert.ok(!html.includes('id="source-storage-id"'), 'the storage location ID field must be gone');
  const advancedAt = html.indexOf('id="source-advanced"');
  assert.ok(advancedAt > -1, 'the advanced disclosure should exist');
  assert.ok(html.indexOf('id="source-id"') > advancedAt, 'any remaining id field belongs under Advanced');
  // The customer action sends only the folder and the permission.
  assert.ok(renderer.includes('window.gateway.authorizeFolder(root, access)'));
  assert.ok(preload.includes('authorizeFolder:'));
});

check('the folder picker grants nothing by itself: it only returns a path, through the existing add-source route', () => {
  assert.ok(main.includes("ipcMain.handle('gateway:pick-folder'"));
  assert.ok(main.includes("properties: ['openDirectory']"));
  // The dialog handler itself (up to its own closing `});`) must not touch
  // the filesystem or run the elevated helper.
  const start = main.indexOf("ipcMain.handle('gateway:pick-folder'");
  const handler = main.slice(start, main.indexOf('\n});', start) + 4);
  for (const forbidden of ['runElevatedHelper', 'writeFileSync', 'readFileSync', 'icacls']) {
    assert.ok(!handler.includes(forbidden), `pick-folder must not call ${forbidden}`);
  }
  assert.ok(preload.includes('pickFolder:'));
});

check('approving a folder never shows a console window, and never claims more than it knows', () => {
  const handler = renderer.slice(renderer.indexOf("getElementById('btn-sources-approve')"));
  // Feedback on BOTH outcomes.
  assert.ok(handler.includes("setError('sources-error'"), 'failures must be shown');
  assert.ok(handler.includes("setNotice('sources-notice'"), 'success must be shown');
  assert.ok(html.includes('id="sources-notice"'), 'the success element must exist');
  // Success wording must not assert the record already exists in DPDP: the
  // guarantee at that moment is "durably queued + service restarting".
  assert.ok(/waiting to reach DPDP|within a few seconds/.test(handler), 'success must describe the real guarantee');
  assert.ok(handler.includes('lastKnownPendingAuthorizations'), 'pending work must drive the message');
  // The success wording appears only AFTER the helper returned ok.
  assert.ok(handler.indexOf('if (!result.ok)') < handler.indexOf('Folder allowed'), 'the success message must come after the ok check');
  assert.ok(/setNotice\('sources-notice', null\)/.test(handler), 'a previous message must be cleared on retry');
});

check('a paired-but-unreachable Gateway lands on the status screen, where Remove/Reconnect live', () => {
  // THE DEAD END THIS FIXES (observed on a real Windows machine): another
  // program held port 7071, so the service crash-looped and /health was
  // answered by that other program. The wizard therefore never showed the
  // status screen, pairing refused ("already paired" — the local credential
  // was still there), and Remove Gateway was unreachable.
  const boot = renderer.slice(renderer.lastIndexOf('const status = await window.gateway.getStatus()'));
  assert.ok(/serviceInstalled\s*=\s*status\.problem\s*!==\s*'SERVICE_MISSING'/.test(boot), 'the boot path must know whether the service exists');
  assert.ok(/if \(enrolled \|\| \(!status\.reachable && serviceInstalled\)\)/.test(boot), 'unreachable-but-installed must reach the status screen');
  assert.ok(boot.includes("showScreen('status')"));
  // The lifecycle actions are on that screen.
  for (const id of ['btn-status-remove', 'btn-status-reconnect']) assert.ok(html.includes(`id="${id}"`), `${id} must exist`);
});

check('removal always confirms, and tells the truth when the service cannot run', () => {
  const handler = renderer.slice(renderer.indexOf("getElementById('btn-status-remove')"));
  assert.ok(handler.includes('window.confirm('), 'removal must be deliberate');
  assert.ok(handler.includes('lastKnownReachable'), 'the message must depend on whether the service is answering');
  assert.ok(/QUEUED/.test(handler), 'an unreachable service must be told its removal is queued');
  // Removal goes through the existing authenticated path, never a local wipe.
  assert.ok(handler.includes('window.gateway.remove()'));
  for (const forbidden of ['unlink', 'rmSync', 'device-credential']) {
    assert.ok(!handler.includes(forbidden), `the renderer must not touch state directly (${forbidden})`);
  }
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

check('every sources error code the agent can report has wizard text (sources-file.ts + health.ts)', () => {
  const agentDir = path.join(__dirname, '..', '..', 'agent', 'src');
  const fileCodes = /export type SourcesFileErrorCode =([^;]*);/.exec(fs.readFileSync(path.join(agentDir, 'sources-file.ts'), 'utf8'));
  const healthField = /sourcesError: ([^;]*);/.exec(fs.readFileSync(path.join(agentDir, 'health.ts'), 'utf8'));
  assert.ok(fileCodes && healthField, 'sources error code definitions not found');
  const codes = [...`${fileCodes[1]} ${healthField[1]}`.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.includes('TLS_CA_INVALID'));
  const text = /const SOURCES_ERROR_TEXT = \{([\s\S]*?)\n\};/.exec(renderer)[1];
  assert.deepStrictEqual(codes.filter((c) => !new RegExp(`^\\s+${c}:`, 'm').test(text)), []);
});

check('(Phase 6) "Try again" after a failed pairing restarts the service, not just the status polling', () => {
  const handler = /getElementById\('btn-verify-retry'\)\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n\}\);/.exec(renderer);
  assert.ok(handler, 'verify retry handler not found');
  assert.match(handler[1], /window\.gateway\.reconnect\(\)/);
  assert.match(handler[1], /startVerification\(\)/);
});

check('(Phase 6) the wizard waits longer than the agent\'s own enrolment retries before giving up', () => {
  const attempts = Number(/const VERIFY_MAX_ATTEMPTS = (\d+);/.exec(renderer)[1]);
  const intervalMs = Number(/const VERIFY_INTERVAL_MS = (\d+);/.exec(renderer)[1]);
  // agent: up to 5 attempts, 10 s connect timeout each, ~30 s of back-off, plus a service restart
  assert.ok(attempts * intervalMs >= 120000, `wizard waits only ${attempts * intervalMs} ms`);
});

check('(Phase 6) no button opens the stored server address as if it were the dashboard', () => {
  assert.ok(!/openExternal\(workspaceUrl\)/.test(renderer));
});

check('(Phase 6) a missing Windows service is reported BEFORE any UAC prompt, and helper failures use describeHelperExit', () => {
  const body = /function runElevatedHelper\(action, payload\) \{([\s\S]*?)\n\}\n/.exec(main);
  assert.ok(body, 'runElevatedHelper not found');
  const pre = body[1].indexOf('serviceMissing()');
  const spawnAt = body[1].indexOf('spawn(');
  assert.ok(pre > -1 && spawnAt > -1 && pre < spawnAt, 'service check must come before the elevated spawn');
  assert.match(body[1], /describeHelperExit\(code\)/);
  assert.ok(!/exit code \$\{code\}/.test(body[1]), 'no raw exit codes in customer messages');
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
