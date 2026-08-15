/**
 * Persistent local-file connection for a SaaS Data Source (Excel/CSV) — the
 * browser half of the architecture. Everything here lives in IndexedDB, which
 * is per-origin, per-browser-profile storage on the CLIENT's own machine, never
 * the central backend. This module stores and retrieves an opaque
 * FileSystemFileHandle plus a human-readable file name, keyed by the existing
 * data_sources.id — nothing else.
 *
 * NEVER stored here: file bytes, parsed rows, customer values, or a filesystem
 * path (a FileSystemFileHandle carries no extractable path — there is no API to
 * read one off it). There is no network call anywhere in this file.
 */

const DB_NAME = 'dpdp-local-source-handles';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

export interface StoredHandleRecord {
  dataSourceId: string;
  handle: FileSystemFileHandle;
  fileName: string;
  savedAt: number;
}

/** Feature-detect: the File System Access API + IndexedDB, both required. */
export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showOpenFilePicker === 'function' &&
    typeof window.indexedDB !== 'undefined'
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'dataSourceId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the local source handle store.'));
  });
}

/** Save (or replace) the handle for exactly this data source. Independent data
 *  source ids never share or overwrite each other's entry (keyPath is the id). */
export async function saveHandle(dataSourceId: string, handle: FileSystemFileHandle, fileName: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const record: StoredHandleRecord = { dataSourceId, handle, fileName, savedAt: Date.now() };
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save the local file handle.'));
    });
  } finally {
    db.close();
  }
}

/** Look up the saved handle for a data source, or null if none was ever saved
 *  in this browser profile. */
export async function getHandle(dataSourceId: string): Promise<StoredHandleRecord | null> {
  const db = await openDb();
  try {
    return await new Promise<StoredHandleRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(dataSourceId);
      req.onsuccess = () => resolve((req.result as StoredHandleRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('Could not read the local file handle.'));
    });
  } finally {
    db.close();
  }
}

/** Remove a data source's saved handle. Best-effort: caller decides whether a
 *  failure here should ever block anything else (it should not — see the
 *  "remove a Data Source" flow, which must never be blocked by this). */
export async function removeHandle(dataSourceId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(dataSourceId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not remove the local file handle.'));
    });
  } finally {
    db.close();
  }
}

/** Check current permission WITHOUT prompting the user (never triggers a
 *  browser permission UI by itself). */
export async function queryHandlePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/** Request permission — MUST only be called from a user gesture (e.g. a click
 *  handler), per the File System Access API's own requirement. Never call this
 *  automatically on page load. */
export async function requestHandlePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  try {
    return await handle.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}
