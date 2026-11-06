// Preload -- exposes a NARROW, named bridge and nothing else (same
// discipline as desktop/'s storage-preload.js). The renderer never gets
// `require`, `process`, or a generic IPC call -- only these specific
// operations. Runs under sandbox:true.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gateway', {
  /** { reachable:boolean, health?:object, error?:string } -- health is the
   *  agent's own /health JSON (status/agentVersion/networkMode/gateway). */
  getStatus: () => ipcRenderer.invoke('gateway:get-status'),

  /** { controlPlaneUrl:string|null } -- read from this machine's own
   *  config.json, never from the network. */
  getConfig: () => ipcRenderer.invoke('gateway:get-config'),

  /** { ok:boolean, url?:string, reason?:string } */
  validateWorkspaceUrl: (raw) => ipcRenderer.invoke('gateway:validate-workspace-url', raw),

  /** Triggers ONE UAC prompt; writes config.json + pending-enrollment.json
   *  and restarts the service. { ok:boolean, cancelled?:boolean, error?:string } */
  pair: (enrollmentCode, controlPlaneUrl, displayName) =>
    ipcRenderer.invoke('gateway:pair', { enrollmentCode, controlPlaneUrl, displayName }),

  /** Opens the native folder picker. No UAC, and no access is granted by
   *  choosing: the folder still has to be saved through addSource below.
   *  { ok:boolean, canceled?:boolean, path?:string } */
  pickFolder: () => ipcRenderer.invoke('gateway:pick-folder'),

  /** The customer path: approve one folder for reading, saving, or both.
   *  Triggers ONE UAC prompt. No ids are supplied or returned here — the
   *  service obtains them from DPDP on its next start.
   *  { ok:boolean, cancelled?:boolean, error?:string } */
  authorizeFolder: (root, access) => ipcRenderer.invoke('gateway:authorize-folder', { root, access }),

  /** ADVANCED (databases, or a folder with an id supplied by hand). Triggers
   *  ONE UAC prompt; writes sources.json and restarts the service.
   *  { ok:boolean, sourceCount?:number, cancelled?:boolean, error?:string } */
  addSource: (sourceConfig) => ipcRenderer.invoke('gateway:add-source', sourceConfig),

  /** Triggers ONE UAC prompt; de-enrols with the backend and clears local state. */
  remove: () => ipcRenderer.invoke('gateway:remove'),

  /** Triggers ONE UAC prompt; just restarts the service (e.g. after a
   *  transient failure, or to pick up a config.json edited by support). */
  reconnect: () => ipcRenderer.invoke('gateway:reconnect'),

  /** Opens a URL in the system's default browser. The renderer only ever
   *  passes a URL this app itself derived (the validated workspace origin,
   *  or a fixed docs link) -- never raw, unvalidated user input. */
  openExternal: (url) => ipcRenderer.invoke('gateway:open-external', url),
});
