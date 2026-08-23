// Preload for the MAIN DPDP window — exposes a NARROW, native Enterprise
// Storage bridge and nothing else. This is the one deliberate, minimal
// deviation from "the main window has no preload": the renderer (the existing
// DPDP frontend at localhost:3000) gets exactly one namespaced object,
// `window.electronStorage`, whose every method is a typed IPC round-trip to
// the main process. It never exposes `fs`, `require`, `process`, a path
// string it didn't receive, or any generic IPC — only the specific storage
// operations below. All real filesystem work (and all path containment)
// happens in the main process (see main.js's registerEnterpriseStorageIpc).
//
// Runs under sandbox:true — only `electron`'s contextBridge/ipcRenderer are
// available here, which is all this needs. No Node integration is enabled.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  isAvailable: 'enterprise-storage:is-available',
  selectFolder: 'enterprise-storage:select-folder',
  get: 'enterprise-storage:get',
  set: 'enterprise-storage:set',
  clear: 'enterprise-storage:clear',
  verify: 'enterprise-storage:verify',
  browse: 'enterprise-storage:browse',
  createFolder: 'enterprise-storage:create-folder',
  writeText: 'enterprise-storage:write-text',
  writeJson: 'enterprise-storage:write-json',
  writeFile: 'enterprise-storage:write-file',
};

/**
 * The complete, closed API surface. Every call returns a Promise that
 * resolves to a plain JSON-serializable result; the main process never
 * throws across the IPC boundary uncaught — it returns `{ ok:false, error }`
 * shapes the renderer can branch on (see electron-storage.ts).
 */
contextBridge.exposeInMainWorld('electronStorage', {
  /** Marker the renderer uses to detect it is running inside the installed
   *  Electron app (vs a plain browser tab) and should use the native
   *  Enterprise Storage provider instead of the File System Access API. */
  isAvailable: () => ipcRenderer.invoke(CH.isAvailable),

  /** Opens the native OS folder picker. Resolves to
   *  `{ canceled:boolean, path?:string }` — a REAL absolute filesystem path. */
  selectFolder: () => ipcRenderer.invoke(CH.selectFolder),

  /** The persisted Enterprise Storage config: `{ rootPath:string|null }`. */
  getConfig: () => ipcRenderer.invoke(CH.get),

  /** Persist `rootPath` after validating it exists and is writable.
   *  Resolves to `{ ok:true, rootPath }` or `{ ok:false, reason }`. */
  setConfig: (rootPath) => ipcRenderer.invoke(CH.set, { rootPath }),

  /** Forget the configured path (config metadata only — never deletes files). */
  clearConfig: () => ipcRenderer.invoke(CH.clear),

  /** Re-probe the configured root right now: `{ available:boolean, reason:string, rootPath:string|null }`. */
  verify: () => ipcRenderer.invoke(CH.verify),

  // --- contained write/browse primitives (all relative to the configured
  //     root; `path` is an array of plain folder-name segments) -------------
  browse: (path) => ipcRenderer.invoke(CH.browse, { path }),
  createFolder: (path, name) => ipcRenderer.invoke(CH.createFolder, { path, name }),
  writeText: (path, filename, text) => ipcRenderer.invoke(CH.writeText, { path, filename, text }),
  writeJson: (path, filename, data) => ipcRenderer.invoke(CH.writeJson, { path, filename, data }),
  /** Raw bytes for a PDF/Excel upload — `base64` is decoded in main and
   *  written unchanged; the original filename is preserved. */
  writeFile: (path, filename, base64) => ipcRenderer.invoke(CH.writeFile, { path, filename, base64 }),
});

/**
 * Native OS dialogs the renderer may invoke — kept to the narrowest possible
 * surface. Today just the save dialog (the Electron-native replacement for
 * <a download>): the renderer passes the file's bytes (base64) + a suggested
 * name; the user chooses where to save it. No arbitrary filesystem access.
 */
contextBridge.exposeInMainWorld('electronDialog', {
  saveFile: (defaultName, base64) => ipcRenderer.invoke('dialog:save-file', { defaultName, base64 }),
});
