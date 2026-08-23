/**
 * Renderer bridge to the installed app's native save dialog
 * (window.electronDialog — desktop/src/storage-preload.js →
 * desktop/src/dialog-bridge.js). The Electron-native replacement for
 * <a download>: in the desktop app a generated file (RoPA export, consent
 * proof PDF, …) is written wherever the user chooses via the OS save dialog.
 * Absent in a plain browser tab, where the caller falls back to <a download>.
 */

interface ElectronDialogBridge {
  saveFile(
    defaultName: string,
    base64: string,
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
}

declare global {
  interface Window {
    electronDialog?: ElectronDialogBridge;
  }
}

function bridge(): ElectronDialogBridge | null {
  if (typeof window === 'undefined') return null;
  return window.electronDialog ?? null;
}

export function isElectronDialogAvailable(): boolean {
  return bridge() !== null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Save a blob to a user-chosen location via the native OS save dialog.
 *  Returns 'saved', 'canceled', or 'unavailable' (not running in Electron —
 *  caller should fall back to a browser download). Throws only on a real
 *  write failure the caller should surface. */
export async function saveBlobNative(blob: Blob, defaultName: string): Promise<'saved' | 'canceled' | 'unavailable'> {
  const b = bridge();
  if (!b) return 'unavailable';
  const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  const res = await b.saveFile(defaultName, base64);
  if (!res.ok) throw new Error(res.error ?? 'Could not save the file.');
  return res.canceled ? 'canceled' : 'saved';
}
