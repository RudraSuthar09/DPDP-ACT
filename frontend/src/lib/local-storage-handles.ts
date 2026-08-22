/**
 * Persistent local-folder connection for a SaaS (`provider: 'local'`) Storage
 * Root — the "Local Storage Adapter" half of the architecture. Everything
 * here lives in IndexedDB, per-origin/per-browser-profile storage on the
 * CLIENT's own machine, never the central backend. Stores an opaque
 * FileSystemDirectoryHandle keyed by storage_roots.id — nothing else.
 *
 * NEVER stored here: folder contents, customer values, or a filesystem path
 * (a FileSystemDirectoryHandle carries no extractable path). No network call
 * anywhere in this file — mirrors local-source-handles.ts exactly, for a
 * directory instead of a file.
 */

const DB_NAME = 'dpdp-local-storage-roots';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

export interface StoredStorageHandleRecord {
  storageRootId: string;
  handle: FileSystemDirectoryHandle;
  savedAt: number;
}

export function isLocalStorageAdapterSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function' &&
    typeof window.indexedDB !== 'undefined'
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'storageRootId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the local storage handle store.'));
  });
}

export async function saveStorageHandle(storageRootId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const record: StoredStorageHandleRecord = { storageRootId, handle, savedAt: Date.now() };
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save the local storage folder handle.'));
    });
  } finally {
    db.close();
  }
}

export async function getStorageHandle(storageRootId: string): Promise<StoredStorageHandleRecord | null> {
  const db = await openDb();
  try {
    return await new Promise<StoredStorageHandleRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(storageRootId);
      req.onsuccess = () => resolve((req.result as StoredStorageHandleRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('Could not read the local storage folder handle.'));
    });
  } finally {
    db.close();
  }
}

export async function removeStorageHandle(storageRootId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(storageRootId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not remove the local storage folder handle.'));
    });
  } finally {
    db.close();
  }
}

/** Folder creation needs write access, unlike the read-only data-source
 *  handles — 'readwrite' mode throughout. */
export async function queryStorageHandlePermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/** MUST only be called from a user gesture. Never call automatically on load. */
export async function requestStorageHandlePermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  try {
    return await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}
