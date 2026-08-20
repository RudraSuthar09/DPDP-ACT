// Preload for the SPLASH window only -- never loaded into the main DPDP
// window. Exposes exactly two read-only status callbacks, nothing else: no
// generic IPC, no filesystem, no process access, no way to run a command.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dpdpSplash', {
  onStatus: (callback) => ipcRenderer.on('dpdp:status', (_event, text) => callback(text)),
  onError: (callback) => ipcRenderer.on('dpdp:error', (_event, text) => callback(text)),
});
