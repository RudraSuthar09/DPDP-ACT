/**
 * The SaaS "Local Storage Adapter" — browses/creates/verifies REAL folders on
 * the client's own machine via the browser's File System Access API. This
 * runs ENTIRELY client-side; the central backend never receives a path or any
 * folder content, only the resulting metadata the caller separately chooses
 * to persist (see the /storage page: a real create is attempted FIRST, and
 * the central POST /storage/folders call happens only after it succeeds —
 * so the central record and the real folder can never silently diverge by
 * one existing and the other not).
 *
 * `path` is always an array of plain folder NAME segments — exactly what the
 * agent-side Gateway storage plane expects too (see
 * agent/src/storage/path-safety.ts), so the two "Local Storage Adapter" /
 * "GatewayStorageProvider" implementations share the same logical contract
 * even though one runs in the browser and one runs in Node.
 */

export class LocalStorageError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_SUPPORTED' | 'NOT_CONNECTED' | 'PERMISSION_DENIED' | 'NOT_FOUND' = 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'LocalStorageError';
  }
}

/** Walk from `root` through `path` (folder names). `create` controls whether
 *  a missing segment is created along the way (createFolder) or causes a
 *  NOT_FOUND (browse/verify). Every step uses the browser's own handle-based
 *  API, so containment is structural — there is no OS path string anywhere
 *  in this function to validate or escape. */
async function walk(root: FileSystemDirectoryHandle, path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of path) {
    try {
      dir = await dir.getDirectoryHandle(segment, { create });
    } catch {
      throw new LocalStorageError(`Folder "${segment}" was not found in the connected local storage.`, 'NOT_FOUND');
    }
  }
  return dir;
}

/** List the direct subfolder NAMES of the folder at `path` under `root`. */
export async function browseLocalFolder(root: FileSystemDirectoryHandle, path: string[]): Promise<string[]> {
  const dir = await walk(root, path, false);
  const names: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') names.push(entry.name);
  }
  return names.sort();
}

/** Create `name` under `path` (creating it if it does not already exist —
 *  idempotent, matching the Gateway-side provider's behaviour). */
export async function createLocalFolder(root: FileSystemDirectoryHandle, path: string[], name: string): Promise<void> {
  const parent = await walk(root, path, false);
  try {
    await parent.getDirectoryHandle(name, { create: true });
  } catch {
    throw new LocalStorageError(`Could not create folder "${name}" in the connected local storage.`, 'PERMISSION_DENIED');
  }
}

/** True iff the folder at `path` exists in the connected local storage. */
export async function verifyLocalFolder(root: FileSystemDirectoryHandle, path: string[]): Promise<boolean> {
  try {
    await walk(root, path, false);
    return true;
  } catch {
    return false;
  }
}

async function writeLocalFile(
  root: FileSystemDirectoryHandle,
  path: string[],
  filename: string,
  content: string | File,
): Promise<void> {
  const dir = await walk(root, path, true);
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await dir.getFileHandle(filename, { create: true });
  } catch {
    throw new LocalStorageError(`Could not create file "${filename}" in the connected local storage.`, 'PERMISSION_DENIED');
  }
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

/** Write ONE small JSON file at `path`/`filename` under `root` (creating any
 *  missing folders in `path` along the way — idempotent, like createLocalFolder).
 *  Central DPDP Storage's consent-submission dual-write: the caller composes
 *  `data` from the same answers already submitted to the backend — this
 *  function only ever writes what it's given, never reads/reshapes anything
 *  server-side, and never touches the network. Overwrites any existing file
 *  at that path (the caller is expected to pick a path that is unique per
 *  submission, e.g. including the submission id). */
export async function writeLocalJsonFile(
  root: FileSystemDirectoryHandle,
  path: string[],
  filename: string,
  data: unknown,
): Promise<void> {
  await writeLocalFile(root, path, filename, JSON.stringify(data, null, 2));
}

/** Write ONE plain text value at `path`/`filename` under `root` — a readable
 *  `.txt` file, never JSON-wrapped. A text field's submitted value (e.g.
 *  "Aadhaar Number") is stored exactly as typed, so opening it needs no
 *  understanding of this platform's own JSON shape. */
export async function writeLocalTextFile(
  root: FileSystemDirectoryHandle,
  path: string[],
  filename: string,
  text: string,
): Promise<void> {
  await writeLocalFile(root, path, filename, text);
}

/** Write ONE raw file's actual bytes (e.g. a PDF/Excel field upload) at
 *  `path`/`filename` under `root` — the browser writes the File object
 *  straight through (FileSystemWritableFileStream.write accepts a Blob),
 *  never reading it into a JS string/JSON, never touching the network. This
 *  is the ONLY place a field's raw file content is ever written anywhere —
 *  never through the backend, never into PostgreSQL (I1). */
export async function writeLocalRawFile(
  root: FileSystemDirectoryHandle,
  path: string[],
  filename: string,
  file: File,
): Promise<void> {
  await writeLocalFile(root, path, filename, file);
}
