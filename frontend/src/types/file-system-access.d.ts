/**
 * Minimal ambient types for the subset of the File System Access API this
 * project uses. Not yet part of TypeScript's bundled DOM lib, and this project
 * does not depend on @types/wicg-file-system-access — these are the few
 * members frontend/src/lib/local-source-handles.ts actually calls.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  isSameEntry(other: FileSystemHandle): Promise<boolean>;
}

interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean;
}

/** The subset needed to write one small JSON file (Central DPDP Storage's
 *  consent.json dual-write) — never a general streaming/append API. */
interface FileSystemWritableFileStream {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: 'file';
  getFile(): Promise<File>;
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>;
}

interface FileSystemGetFileOptions {
  create?: boolean;
}

interface FileSystemGetDirectoryOptions {
  create?: boolean;
}

/** The subset local-storage-provider.ts calls: create/lookup a subdirectory or
 *  file, and enumerate DIRECT children (folders only are consumed today —
 *  files have kind:'file' and are filtered out at most call sites). */
interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory';
  getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle>;
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
}

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
