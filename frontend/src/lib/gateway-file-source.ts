/**
 * A data source created by picking a file through the Gateway (Data Sources
 * -> Select files). It is an ordinary data_sources row -- no new model: name =
 * the file name, sourceKind from its extension, Gateway-connected access
 * mode, and the file's LOCATION recorded in the existing non-secret
 * `connectionHint` as a small tagged JSON value:
 *
 *   gateway-file:{"src":"<folder source id>","dir":["Exports","2024"],"file":"q1.csv","size":1234}
 *
 * `src` is the authorized Gateway folder source it was picked from, `dir` the
 * folder NAMES the user navigated (never an OS path), `size` the size at
 * selection time. Pure helpers; no I/O.
 */
import type { DataSourceKind } from '@dpdp/shared';

const PREFIX = 'gateway-file:';
const MAX_HINT = 500; // the backend's connectionHint limit

export interface GatewayFileRef {
  /** The authorized Gateway folder source the file was picked from. */
  src: string;
  /** Folder names from the top of that source down to the file's folder. */
  dir: string[];
  file: string;
  /** Bytes at selection time, or null if unknown. */
  size: number | null;
}

export function encodeGatewayFileHint(ref: GatewayFileRef): string {
  const hint = PREFIX + JSON.stringify({ src: ref.src, dir: ref.dir, file: ref.file, size: ref.size });
  if (hint.length > MAX_HINT) throw new Error(`"${ref.file}" is in too deep a folder to record (the location is longer than ${MAX_HINT} characters).`);
  return hint;
}

export function decodeGatewayFileHint(hint: string | null | undefined): GatewayFileRef | null {
  if (!hint || !hint.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(hint.slice(PREFIX.length)) as Record<string, unknown>;
    if (typeof v.src !== 'string' || typeof v.file !== 'string' || !Array.isArray(v.dir) || !v.dir.every((d) => typeof d === 'string')) return null;
    const size = typeof v.size === 'number' && Number.isFinite(v.size) && v.size >= 0 ? v.size : null;
    return { src: v.src, dir: v.dir as string[], file: v.file, size };
  } catch {
    return null;
  }
}

/** The existing source kinds the Gateway's filesystem connector reads. */
export function sourceKindForFile(fileName: string): DataSourceKind {
  const ext = fileExtension(fileName);
  if (ext === 'csv') return 'csv';
  if (ext === 'xlsx') return 'excel';
  return 'filesystem';
}

export function fileExtension(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(i + 1).toLowerCase() : '';
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Exports / 2024" -- or "(top folder)" for a file at the top. */
export function formatLocation(ref: Pick<GatewayFileRef, 'dir'>): string {
  return ref.dir.length ? ref.dir.join(' / ') : '(top folder)';
}

/** A source the picker may browse: an authorized Gateway FOLDER source, i.e.
 *  Gateway-connected, active, file-shaped, and not itself a picked file. */
export function isGatewayFolderSource(s: { status: string; dataAccessMode: string; sourceKind: string; connectionHint?: string | null }): boolean {
  return (
    s.status === 'active' &&
    s.dataAccessMode === 'gateway_connected' &&
    (s.sourceKind === 'filesystem' || s.sourceKind === 'csv' || s.sourceKind === 'excel') &&
    decodeGatewayFileHint(s.connectionHint) === null
  );
}
