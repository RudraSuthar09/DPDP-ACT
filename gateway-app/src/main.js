// DPDP Gateway Setup -- main process. A separate, small Electron app (not
// desktop/). It never talks to the DPDP backend, never sees a device token,
// and has exactly two ways to affect the Gateway:
//   1. read-only: GET http://127.0.0.1:7071/health (local status) and read
//      config.json (non-secret workspace URL);
//   2. privileged: run elevated-helper.ps1 through one UAC prompt, with a
//      fixed action and a request file (see elevated-command.js and
//      request-file.js). There is no other privileged path.
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const { validateWorkspaceUrl } = require('./workspace-url');
const { buildElevatedCommand, EXIT_UAC_CANCELLED } = require('./elevated-command');
const { consumeResult, createRequestFile, scrubAndDelete, validatePairPayload, validateSourcePayload } = require('./request-file');
const { defaultConfigFilePath, resolveInstallLayout } = require('./paths');

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

ipcMain.handle('gateway:get-status', () => probeHealth());

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

ipcMain.handle('gateway:open-external', (_event, url) => {
  // Only an https workspace origin (or http on localhost) -- never file:,
  // javascript:, a UNC path, or anything else a compromised renderer might pass.
  const checked = validateWorkspaceUrl(url);
  if (!checked.ok) return { ok: false };
  return shell.openExternal(checked.url).then(() => ({ ok: true }));
});

// --- the single privileged path ----------------------------------------------

function runElevatedHelper(action, payload) {
  if (!LAYOUT.installed) {
    return Promise.resolve({ ok: false, error: 'This action is only available in an installed DPDP Gateway.' });
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
      finish({ ok: false, error: (result && result.error) || `The setup step failed (exit code ${code}).` });
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

ipcMain.handle('gateway:remove', () => runElevatedHelper('remove', {}));

ipcMain.handle('gateway:reconnect', () => runElevatedHelper('restart', {}));
