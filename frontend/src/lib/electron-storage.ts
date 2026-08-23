/**
 * The renderer-side bridge to the installed Electron app's native Enterprise
 * Storage (window.electronStorage — exposed by desktop/src/storage-preload.js,
 * backed by desktop/src/enterprise-storage.js in the main process).
 *
 * This is the Electron half of the CentralFsProvider seam: when the DPDP
 * frontend is running inside the installed desktop app, Enterprise Storage
 * uses THIS provider (real native filesystem, real absolute path, persisted
 * across restarts) instead of the browser File System Access API. In a plain
 * browser tab, window.electronStorage is absent and none of this is reachable
 * — the SaaS browser path is completely unaffected.
 *
 * Nothing here ever sees Node's fs or an arbitrary path: it only calls the
 * narrow, closed set of IPC methods the preload exposes; all containment and
 * all real I/O happen in the main process.
 */

import type { CentralFsProvider } from './local-storage-provider';

/**
 * The exact shape the Electron preload exposes as `window.electronStorage`
 * (desktop/src/storage-preload.js). Declared as a global Window augmentation
 * so the renderer references `window.electronStorage` with full types and
 * never an `(window as any)` cast (requirement: proper TS declarations).
 */
export interface ElectronStorageBridge {
  isAvailable(): Promise<{ ok: boolean; available: boolean }>;
  selectFolder(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  getConfig(): Promise<{ ok: boolean; rootPath: string | null }>;
  setConfig(rootPath: string): Promise<{ ok: boolean; available?: boolean; reason?: string; rootPath?: string; error?: string }>;
  clearConfig(): Promise<{ ok: boolean }>;
  verify(): Promise<{ ok: boolean; available: boolean; reason: string; rootPath: string | null }>;
  browse(path: string[]): Promise<{ ok: boolean; entries?: string[]; error?: string }>;
  createFolder(path: string[], name: string): Promise<{ ok: boolean; error?: string }>;
  writeText(path: string[], filename: string, text: string): Promise<{ ok: boolean; error?: string }>;
  writeJson(path: string[], filename: string, data: unknown): Promise<{ ok: boolean; error?: string }>;
  writeFile(path: string[], filename: string, base64: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronStorage?: ElectronStorageBridge;
  }
}

function bridge(): ElectronStorageBridge | null {
  if (typeof window === 'undefined') return null;
  return window.electronStorage ?? null;
}

/** True iff running inside the installed Electron app (the native Enterprise
 *  Storage bridge is present). Synchronous — safe to branch UI/logic on. */
export function isElectronStorageAvailable(): boolean {
  return bridge() !== null;
}

function requireBridge(): ElectronStorageBridge {
  const b = bridge();
  if (!b) throw new Error('Enterprise Storage is only available in the installed DPDP desktop application.');
  return b;
}

export interface ElectronStorageStatus {
  rootPath: string | null;
  available: boolean;
  reason: string;
}

/** Open the native OS folder picker; resolves the chosen absolute path, or
 *  `null` if the user cancelled. */
export async function selectEnterpriseFolder(): Promise<string | null> {
  const res = await requireBridge().selectFolder();
  if (!res.ok || res.canceled || !res.path) return null;
  return res.path;
}

/** Persist a chosen root path (validated + write-probed in main). Returns the
 *  resulting availability so the caller can show Connected/Unavailable. */
export async function setEnterpriseFolder(rootPath: string): Promise<ElectronStorageStatus> {
  const res = await requireBridge().setConfig(rootPath);
  if (!res.ok) {
    return { rootPath: null, available: false, reason: res.error ?? 'Could not save the storage folder.' };
  }
  return { rootPath: res.rootPath ?? rootPath, available: res.available ?? false, reason: res.reason ?? '' };
}

/** The persisted config + a FRESH availability probe from the process that
 *  performs writes — CONFIGURED (rootPath present) and AVAILABLE (reachable
 *  now) are answered separately, never conflated. */
export async function getEnterpriseStatus(): Promise<ElectronStorageStatus> {
  const b = requireBridge();
  const cfg = await b.getConfig();
  const rootPath = cfg.ok ? cfg.rootPath : null;
  if (!rootPath) return { rootPath: null, available: false, reason: 'No Enterprise Storage folder is configured yet.' };
  const v = await b.verify();
  return { rootPath, available: v.ok ? v.available : false, reason: v.reason ?? '' };
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function unwrap(res: { ok: boolean; error?: string }): void {
  if (!res.ok) throw new Error(res.error ?? 'ELECTRON_STORAGE_ERROR');
}

/** The Electron implementation of CentralFsProvider — every op is a contained
 *  native filesystem write in the main process, under the configured root. */
export function electronFsProvider(): CentralFsProvider {
  const b = requireBridge();
  return {
    createFolder: async (path, name) => unwrap(await b.createFolder(path, name)),
    browse: async (path) => {
      const res = await b.browse(path);
      if (!res.ok) throw new Error(res.error ?? 'ELECTRON_STORAGE_ERROR');
      return res.entries ?? [];
    },
    writeText: async (path, filename, text) => unwrap(await b.writeText(path, filename, text)),
    writeJson: async (path, filename, data) => unwrap(await b.writeJson(path, filename, data)),
    writeRaw: async (path, filename, file) => unwrap(await b.writeFile(path, filename, await fileToBase64(file))),
  };
}
