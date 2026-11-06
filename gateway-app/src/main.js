// DPDP Gateway Setup -- main process. A separate, small Electron app (not
// desktop/). It never talks to the DPDP backend, never sees a device token,
// and has exactly two ways to affect the Gateway:
//   1. read-only: GET http://127.0.0.1:7071/health (local status) and read
//      config.json (non-secret workspace URL);
//   2. privileged: run elevated-helper.ps1 through one UAC prompt, with a
//      fixed action and a request file (see elevated-command.js and
//      request-file.js). There is no other privileged path.
'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const { validateWorkspaceUrl } = require('./workspace-url');
const { buildElevatedCommand, describeHelperExit, EXIT_UAC_CANCELLED } = require('./elevated-command');
const {
  consumeResult,
  createRequestFile,
  scrubAndDelete,
  validateFolderApprovalPayload,
  validatePairPayload,
  validateSourcePayload,
} = require('./request-file');
const { defaultConfigFilePath, resolveInstallLayout } = require('./paths');
const { interpretStatus, parseServiceState } = require('./status-check');

const LAYOUT = resolveInstallLayout();
const AGENT_HEALTH_URL = 'http://127.0.0.1:7071/health';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 680,
    resizable: false,
    title: 'DPDP Gateway Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // The window only ever shows our own local page: no navigation, no popups.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (process.env.GATEWAY_APP_DEBUG) {
    mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
      console.log(`[renderer] ${sourceId}:${line} ${message}`);
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// --- read-only status -------------------------------------------------------
// From the main process (Node http): no Origin header and a loopback Host,
// which is exactly the caller the agent serves detailed status to.

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(AGENT_HEALTH_URL, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve({ reachable: true, health: JSON.parse(data) });
        } catch {
          resolve({ reachable: false, error: 'The Gateway service responded, but not with valid status data.' });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, error: 'The Gateway service is not responding. It may still be starting up.' });
    });
    req.on('error', () => {
      resolve({ reachable: false, error: 'Could not reach the Gateway service on this machine. It may not be running.' });
    });
  });
}

/** 'running' | 'starting' | 'stopped' | 'missing' | 'unknown' (sc.exe query needs no elevation). */
function queryServiceState() {
  try {
    const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe'), ['query', 'DPDPGatewayAgent'], {
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8',
    });
    return parseServiceState(r.status, r.stdout);
  } catch {
    return 'unknown';
  }
}

// Status counts only if it comes from THIS computer's Gateway service (see
// status-check.js): another program on port 7071 is reported as such.
ipcMain.handle('gateway:get-status', async () => interpretStatus(queryServiceState(), await probeHealth()));

ipcMain.handle('gateway:get-config', () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(defaultConfigFilePath(), 'utf8'));
    const url = validateWorkspaceUrl(parsed.controlPlaneUrl);
    return { controlPlaneUrl: url.ok ? url.url : null };
  } catch {
    return { controlPlaneUrl: null };
  }
});

ipcMain.handle('gateway:validate-workspace-url', (_event, raw) => validateWorkspaceUrl(raw));

// The native Windows folder picker, so an administrator never types a path.
// The renderer gets back ONLY the chosen folder's own path, which it then
// sends through the SAME validated add-source route as before (the elevated
// helper and the Gateway service re-validate it) -- the dialog grants no
// access by itself, and nothing else on this machine is exposed.
ipcMain.handle('gateway:pick-folder', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const opts = { properties: ['openDirectory'], title: 'Choose a folder DPDP may use' };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true };
  return { ok: true, canceled: false, path: res.filePaths[0] };
});

ipcMain.handle('gateway:open-external', (_event, url) => {
  // Only an https workspace origin (or http on localhost) -- never file:,
  // javascript:, a UNC path, or anything else a compromised renderer might pass.
  const checked = validateWorkspaceUrl(url);
  if (!checked.ok) return { ok: false };
  return shell.openExternal(checked.url).then(() => ({ ok: true }));
});

// --- the single privileged path ----------------------------------------------

/** Whether the Windows service exists. `sc.exe query` needs no elevation;
 *  1060 = ERROR_SERVICE_DOES_NOT_EXIST. Anything unexpected is treated as
 *  "unknown" and does not block (the helper reports its own error then). */
function serviceMissing() {
  return queryServiceState() === 'missing';
}

function runElevatedHelper(action, payload) {
  if (!LAYOUT.installed) {
    return Promise.resolve({ ok: false, error: 'This action is only available in an installed DPDP Gateway.' });
  }
  if (serviceMissing()) {
    // Checked BEFORE asking for UAC: elevation cannot help here.
    return Promise.resolve({
      ok: false,
      error: 'The DPDP Gateway service is not installed on this computer, so the installation did not finish. Run the DPDP Gateway installer again, then retry. Reference: GW-SERVICE-MISSING.',
    });
  }
  let files;
  try {
    files = createRequestFile(payload);
  } catch {
    return Promise.resolve({ ok: false, error: 'Could not prepare the request.' });
  }

  return new Promise((resolve) => {
    const finish = (outcome) => {
      scrubAndDelete(files.requestPath);
      resolve(outcome);
    };
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildElevatedCommand(LAYOUT.helperPath, action, files.requestPath)],
        { windowsHide: true },
      );
    } catch {
      finish({ ok: false, error: 'Could not start the setup step.' });
      return;
    }
    child.on('error', () => finish({ ok: false, error: 'Could not start the setup step.' }));
    child.on('close', (code) => {
      const result = consumeResult(files.resultPath);
      if (code === 0 && result && result.ok) return finish({ ok: true });
      if (code === EXIT_UAC_CANCELLED) return finish({ ok: false, cancelled: true, error: 'Permission was not granted.' });
      // With a result file, the helper ran and says what failed. Without one
      // it never reached its own error handling: name that stage instead of
      // showing a raw (often unsigned 32-bit) exit code.
      finish({ ok: false, error: (result && result.error) || describeHelperExit(code) });
    });
  });
}

ipcMain.handle('gateway:pair', (_event, input) => {
  const checked = validatePairPayload(input);
  if (!checked.ok) return { ok: false, error: checked.reason };
  return runElevatedHelper('pair', checked.payload);
});

ipcMain.handle('gateway:add-source', (_event, input) => {
  const checked = validateSourcePayload(input);
  if (!checked.ok) return { ok: false, error: checked.reason };
  return runElevatedHelper('add-source', checked.payload);
});

// The customer path: approve a folder. No ids are entered or invented here —
// the service asks DPDP for them, which is why this payload has none.
ipcMain.handle('gateway:authorize-folder', (_event, input) => {
  const checked = validateFolderApprovalPayload(input);
  if (!checked.ok) return { ok: false, error: checked.reason };
  return runElevatedHelper('authorize-folder', checked.payload);
});

ipcMain.handle('gateway:remove', () => runElevatedHelper('remove', {}));

ipcMain.handle('gateway:reconnect', () => runElevatedHelper('restart', {}));
