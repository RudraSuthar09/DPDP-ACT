// Enterprise Central Storage — MAIN PROCESS implementation.
//
// This is the privileged half of the native storage feature: the ONLY place
// Node's filesystem is touched on behalf of the renderer. The renderer can
// reach it only through the narrow `window.electronStorage` bridge
// (src/storage-preload.js) → these `ipcMain.handle` channels. Every write is
// contained under the single configured root; nothing here ever accepts or
// returns an OS path the renderer chose (the picker's result excepted, which
// the USER chose via the native dialog).
//
// No Docker, no bind mount, no container path — this operates directly on the
// installed machine's filesystem (e.g. D:\DPDP-Storage). Config (the chosen
// root path — metadata only, never customer data) is persisted to a JSON file
// in Electron's per-user userData dir, so it survives app/computer restarts.
'use strict';

const { ipcMain, dialog, app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isAbsolutePath } = require('./storage-path-safety');
const fsOps = require('./storage-fs-ops');

const CONFIG_FILENAME = 'enterprise-storage.json';

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

/** Reads `{ rootPath }` from the persisted config, or `{ rootPath: null }`.
 *  Never throws — a missing/corrupt file is treated as "not configured". */
function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const rootPath = parsed && parsed.enterpriseStorage && typeof parsed.enterpriseStorage.rootPath === 'string'
      ? parsed.enterpriseStorage.rootPath
      : null;
    return { rootPath };
  } catch {
    return { rootPath: null };
  }
}

function writeConfig(rootPath) {
  const body = JSON.stringify({ enterpriseStorage: { rootPath } }, null, 2);
  fs.writeFileSync(configPath(), body, 'utf8');
}

// --- path safety: isSafeSegment / isAbsolutePath / resolveContained live in
//     ./storage-path-safety.js (electron-free, unit-tested). -----------------

/** Real availability probe from THIS process (the one that performs writes):
 *  the directory must exist, be a directory, and accept a create+delete of a
 *  throwaway probe file. Never throws — returns a structured result. */
async function probe(rootPath) {
  if (!rootPath) return { available: false, reason: 'No Enterprise Storage folder is configured yet.' };
  if (!isAbsolutePath(rootPath)) {
    return { available: false, reason: `"${rootPath}" is not an absolute filesystem path.` };
  }
  try {
    const st = await fsp.stat(rootPath);
    if (!st.isDirectory()) return { available: false, reason: `"${rootPath}" is not a folder.` };
  } catch {
    return { available: false, reason: `The configured Enterprise Storage folder could not be found: ${rootPath}` };
  }
  const probeFile = path.join(rootPath, `.dpdp-write-probe-${crypto.randomUUID()}`);
  try {
    await fsp.writeFile(probeFile, '');
    await fsp.unlink(probeFile);
  } catch {
    return { available: false, reason: `The configured Enterprise Storage folder is not writable: ${rootPath}` };
  }
  return { available: true, reason: 'The application can read and write this folder.' };
}

// --- IPC registration -------------------------------------------------------

/** Resolve the configured root or throw a stable, renderer-safe error. */
function requireRoot() {
  const { rootPath } = readConfig();
  if (!rootPath) throw new Error('NOT_CONFIGURED');
  if (!isAbsolutePath(rootPath)) throw new Error('NOT_CONFIGURED');
  return rootPath;
}

/** Wraps a handler so any throw becomes a sanitized `{ ok:false, error }` —
 *  a stable code, never a raw path or internal stack, across the IPC boundary. */
function guarded(fn) {
  return async (_event, arg) => {
    try {
      const result = await fn(arg);
      return { ok: true, ...result };
    } catch (err) {
      const code = err && typeof err.message === 'string' ? err.message : 'ERROR';
      return { ok: false, error: code };
    }
  };
}

function registerEnterpriseStorageIpc() {
  ipcMain.handle('enterprise-storage:is-available', () => ({ ok: true, available: true }));

  ipcMain.handle('enterprise-storage:select-folder', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const opts = { title: 'Select the DPDP Enterprise Storage folder', properties: ['openDirectory', 'createDirectory'] };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true };
    return { ok: true, canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('enterprise-storage:get', () => ({ ok: true, ...readConfig() }));

  ipcMain.handle(
    'enterprise-storage:set',
    guarded(async ({ rootPath }) => {
      if (!isAbsolutePath(rootPath)) throw new Error('NOT_ABSOLUTE');
      const p = await probe(rootPath);
      if (!p.available) return { available: false, reason: p.reason };
      writeConfig(rootPath);
      return { rootPath, available: true, reason: p.reason };
    }),
  );

  ipcMain.handle('enterprise-storage:clear', () => {
    try {
      writeConfig(null);
    } catch {
      /* ignore */
    }
    return { ok: true };
  });

  ipcMain.handle('enterprise-storage:verify', async () => {
    const { rootPath } = readConfig();
    const p = await probe(rootPath);
    return { ok: true, available: p.available, reason: p.reason, rootPath };
  });

  // The write/browse handlers delegate to the electron-free ops in
  // storage-fs-ops.js (unit-tested in storage-path-safety.test.js /
  // storage-fs-ops.test.js) — identical behaviour, just factored out so the
  // actual write mechanism has real coverage without needing the Electron
  // runtime.
  ipcMain.handle(
    'enterprise-storage:browse',
    guarded(async ({ path: segments }) => ({ entries: await fsOps.browseDir(requireRoot(), segments ?? []) })),
  );

  ipcMain.handle(
    'enterprise-storage:create-folder',
    guarded(async ({ path: segments, name }) => {
      await fsOps.createFolder(requireRoot(), segments ?? [], name);
      return {};
    }),
  );

  ipcMain.handle(
    'enterprise-storage:write-text',
    guarded(async ({ path: segments, filename, text }) => {
      await fsOps.writeText(requireRoot(), segments ?? [], filename, text);
      return {};
    }),
  );

  ipcMain.handle(
    'enterprise-storage:write-json',
    guarded(async ({ path: segments, filename, data }) => {
      await fsOps.writeJson(requireRoot(), segments ?? [], filename, data);
      return {};
    }),
  );

  ipcMain.handle(
    'enterprise-storage:write-file',
    guarded(async ({ path: segments, filename, base64 }) => {
      await fsOps.writeFileBase64(requireRoot(), segments ?? [], filename, base64);
      return {};
    }),
  );
}

module.exports = { registerEnterpriseStorageIpc, probe };
