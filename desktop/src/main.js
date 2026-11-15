// DPDP Platform desktop shell -- main process.
//
// This file is deliberately the ENTIRE application. It contains no business
// logic: no authentication, no licensing, no tenancy, no Gateway, no
// database access of any kind. Its only job is to open a native window on the
// hosted DPDP frontend (TRUSTED_ORIGIN, https://app.hhgoa.work), which talks
// to the hosted API itself. Nothing runs locally: no Docker, no backend, no
// database, no secrets on this machine. Every requirement -- SaaS/Enterprise,
// Consent, Data Inventory, Gateway -- lives entirely inside the app it loads.
//
// Native features (Enterprise Storage folder access and the save dialog) are
// exposed through storage-preload.js; their IPC handlers answer only the
// top-level frame of a page on TRUSTED_ORIGIN (see trusted-origin.js).
'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerEnterpriseStorageIpc } = require('./enterprise-storage');
const { registerDialogIpc } = require('./dialog-bridge');
const { TRUSTED_ORIGIN, isTrustedUrl } = require('./trusted-origin');

const APP_URL = `${TRUSTED_ORIGIN}/`;

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

/** Opens an http(s) URL in the user's real browser; anything else is dropped. */
function openExternally(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
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
    // ONE narrow preload: the native Enterprise Central Storage bridge
    // (window.electronStorage — see storage-preload.js). It exposes only a
    // closed set of storage operations, every one a typed IPC round-trip to
    // the main process where the actual filesystem work + path containment
    // happens, and the main process answers only TRUSTED_ORIGIN. The security
    // posture is otherwise unchanged: contextIsolation on, sandbox on,
    // nodeIntegration off — no `fs`/`require`/`process` and no generic IPC
    // ever reach the renderer.
    webPreferences: {
      preload: path.join(__dirname, 'storage-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never open a second Electron window (a second window would get the
  // preload). Every popup / target="_blank" / window.open is denied; an
  // http(s) destination OUTSIDE the trusted origin (e.g. the "Share on
  // WhatsApp" link, an exported PDF) opens in the user's real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isTrustedUrl(url)) openExternally(url);
    return { action: 'deny' };
  });

  // The main window only ever shows the trusted origin, compared by exact
  // origin (never string prefix). A link elsewhere opens in the system browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      openExternally(url);
    }
  });

  // will-navigate does not fire for HTTP redirects: a redirect of the main
  // frame away from the trusted origin is cancelled too, so an untrusted page
  // can never end up in this window holding the preload.
  mainWindow.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isTrustedUrl(url)) {
      event.preventDefault();
      openExternally(url);
    }
  });

  let loadFailed = false;
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 (ERR_ABORTED) is a navigation the app itself replaced; not a failure.
    if (!isMainFrame || errorCode === -3 || mainWindow.isVisible()) return;
    loadFailed = true;
    mainWindow.destroy();
    mainWindow = null;
    setError(
      `Could not reach DPDP at ${TRUSTED_ORIGIN}.\n\n${errorDescription || 'Network error'} (${errorCode})\n\n` +
        'Check this computer’s internet connection (and proxy/firewall), then open DPDP Platform again.',
    );
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (loadFailed || !mainWindow) return;
    mainWindow.show();
    if (splash && !splash.isDestroyed()) splash.close();
  });

  mainWindow.loadURL(APP_URL).catch(() => {
    // Reported through did-fail-load above.
  });
}

function boot() {
  createSplash();
  setStatus(`Connecting to ${TRUSTED_ORIGIN} ...`);
  createMainWindow();
}

app.whenReady().then(() => {
  // Register the native Enterprise Storage IPC handlers once, before any
  // window exists, so window.electronStorage is answerable the moment the
  // renderer loads. These touch only this machine's filesystem and the
  // per-user config file, and answer only TRUSTED_ORIGIN.
  registerEnterpriseStorageIpc();
  registerDialogIpc();
  boot();
});

app.on('window-all-closed', () => {
  app.quit();
});
