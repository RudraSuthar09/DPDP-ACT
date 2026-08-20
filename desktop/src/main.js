// DPDP Platform desktop shell -- main process.
//
// This file is deliberately the ENTIRE application. It contains no business
// logic: no authentication, no licensing, no tenancy, no Gateway, no
// database access of any kind. Its only jobs are: (1) start the EXISTING
// Docker runtime via the EXISTING installer\scripts\start.ps1 if it isn't
// already running, (2) wait for the EXISTING health endpoints, (3) open a
// window pointed at the EXISTING frontend (http://localhost:3000). Every
// other requirement -- SaaS/Enterprise, Consent, Data Inventory, Gateway --
// is unchanged and lives entirely inside the app it loads.
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_URL = 'http://localhost:3000';
const HEALTH_URLS = [
  'http://localhost:3001/health',
  'http://localhost:7071/health',
  'http://localhost:3000/',
];

/**
 * The install root is passed explicitly by the Inno Setup shortcut
 * (--install-root="{app}"), so this never has to guess its own location
 * relative to the packaged .exe. Falls back to the sibling `installer/`
 * directory for local development (`pnpm --filter @dpdp/desktop start`
 * from a source checkout, no real install).
 */
function getInstallRoot() {
  const prefix = '--install-root=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (arg) return arg.slice(prefix.length).replace(/^"|"$/g, '');
  return path.resolve(__dirname, '..', '..', 'installer');
}

const INSTALL_ROOT = getInstallRoot();
const SCRIPTS_DIR = path.join(INSTALL_ROOT, 'scripts');

let splash = null;
let mainWindow = null;

function createSplash() {
  splash = new BrowserWindow({
    width: 440,
    height: 280,
    frame: false,
    resizable: false,
    center: true,
    title: 'DPDP Platform',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
}

function setStatus(text) {
  if (splash && !splash.isDestroyed()) splash.webContents.send('dpdp:status', text);
}

function setError(text) {
  if (splash && !splash.isDestroyed()) splash.webContents.send('dpdp:error', text);
}

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function isRuntimeHealthy() {
  const results = await Promise.all(HEALTH_URLS.map(probe));
  return results.every(Boolean);
}

/**
 * Runs one of the EXISTING installer\scripts\*.ps1 files -- never
 * reimplements what they do. No database credential is ever passed here;
 * the desktop shell never sees APP_DATABASE_URL/DATABASE_URL (they live
 * only in config\.env, written once by generate-env.ps1 -- see
 * installer\README.md for how that's supplied during this testing phase).
 */
function runScript(name, args = []) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, name), ...args],
      { windowsHide: true },
    );
    let lastLine = '';
    const onData = (buf) => {
      const text = buf.toString();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length) {
        lastLine = lines[lines.length - 1];
        setStatus(lastLine);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => resolve({ code: code ?? 1, lastLine }));
    child.on('error', (err) => resolve({ code: 1, lastLine: err.message }));
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DPDP Platform',
    autoHideMenuBar: true,
    // No preload script here, deliberately: the loaded origin is the
    // existing DPDP frontend (localhost:3000), which gets exactly the
    // security posture a normal browser tab already has -- nothing added,
    // nothing exposed. All app logic (auth, licensing, capability, Gateway)
    // stays entirely inside that existing web app.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never open a second window for target="_blank"/window.open, and never
  // navigate this window anywhere outside the DPDP app itself.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (splash && !splash.isDestroyed()) splash.close();
  });

  mainWindow.loadURL(APP_URL);
}

async function boot() {
  createSplash();
  setStatus('Checking DPDP runtime...');

  if (!(await isRuntimeHealthy())) {
    setStatus('Starting DPDP Platform services (this can take a minute on first run)...');
    // -NoBrowser: the shell itself will show the window; no external
    // browser tab should also pop open.
    const result = await runScript('start.ps1', ['-NoBrowser']);
    if (result.code !== 0) {
      setError(
        `Could not start DPDP Platform.\n\n${result.lastLine || 'See installer\\logs for details.'}\n\n` +
          'Common causes: Docker Desktop is not installed/running, or this is the very first run and the central database connection has not been configured yet (see installer\\README.md).',
      );
      return;
    }
  }

  setStatus('Waiting for DPDP to become ready...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isRuntimeHealthy()) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!(await isRuntimeHealthy())) {
    setError('DPDP services started but are not responding yet. Try reopening DPDP Platform in a moment.');
    return;
  }

  setStatus('Loading DPDP...');
  createMainWindow();
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  // Deliberately does NOT stop the Docker runtime and does NOT touch the
  // central database -- closing the window must never affect either. The
  // containers keep running in the background; reopening the shortcut
  // reconnects (isRuntimeHealthy() short-circuits the start step above).
  app.quit();
});
