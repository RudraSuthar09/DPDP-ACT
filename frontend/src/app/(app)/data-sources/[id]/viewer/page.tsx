'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { parseLocalFile, LocalFileError, type ParsedFile } from '../../../../../lib/local-file';
import { maskForHeader } from '../../../../../lib/pii-mask';
import {
  getHandle,
  isFileSystemAccessSupported,
  queryHandlePermission,
  requestHandlePermission,
  saveHandle,
} from '../../../../../lib/local-source-handles';
import type { DataSource } from '@dpdp/shared';

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

const FILE_PICKER_TYPES = [
  {
    description: 'Excel / CSV',
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    },
  },
];

/**
 * The LOCAL FILE connection state for this source, in THIS browser profile
 * only — purely client-side/derived, never sent to or read from the backend (a
 * local file's reachability is inherently device- and browser-specific).
 *
 *   checking        — looking up a saved handle on mount.
 *   idle            — nothing to report: either no handle was ever saved here,
 *                      or the last attempt resolved cleanly. The chooser is
 *                      always available regardless of this state.
 *   auto_loading    — silently reopening a handle whose permission is granted.
 *   needs_reconnect — a handle exists but the browser needs it re-confirmed.
 *   unavailable     — the handle no longer resolves to a readable file (moved/
 *                      renamed/deleted).
 *   unsupported     — this browser has no File System Access API at all; never
 *                      pretend a persistent connection exists here.
 */
type ConnectionState = 'checking' | 'idle' | 'auto_loading' | 'needs_reconnect' | 'unavailable' | 'unsupported';

/**
 * Phase-2 raw-data viewer (Mode-B proof), extended with a persistent LOCAL file
 * connection.
 *
 * The customer's data is read and displayed ENTIRELY in this browser. The file
 * the user picks, its bytes, and the parsed rows never leave the page — the only
 * backend interaction is a metadata-only "raw-access" call (row count), which
 * (a) re-verifies server-side that this is an active, gateway_connected source
 * the user is authorized for, and (b) records the audited fact of access. The
 * table is revealed ONLY after that call succeeds; if it fails, the parsed data
 * is discarded and NEVER uploaded. Leaving/closing this view clears the rows.
 *
 * Persistence: where the browser supports the File System Access API, the
 * chosen file's FileSystemFileHandle is saved in this browser's IndexedDB
 * (frontend/src/lib/local-source-handles.ts), keyed by this data source's id —
 * never centrally. On return, if the browser still grants read permission on
 * that handle, the file reopens without asking the user to re-select it. If
 * permission needs renewing, or the browser doesn't support persistent handles
 * at all, the user sees an explicit action (Reconnect / choose the file) —
 * never a silent or pretended connection. requestPermission() is only ever
 * called from a click handler, per the API's own user-gesture requirement.
 */
export default function RawDataViewerPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canView = !!user && MANAGE_ROLES.has(user.role);

  const [source, setSource] = useState<DataSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  // Raw data lives ONLY in this component's local state. No context, no store,
  // no browser persistence. It is dropped on unmount and on close.
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The LOCAL FILE CONNECTION — a FileSystemFileHandle (never file content),
  // held only in this component's memory + this browser's IndexedDB.
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [handle, setHandle] = useState<FileSystemFileHandle | null>(null);
  const supported = useMemo(() => isFileSystemAccessSupported(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Server-authoritative check (RLS-scoped): mode + tenant + existence.
        const s = await apiFetch<DataSource>(`/data-sources/${id}`);
        if (!cancelled) setSource(s);
      } catch (err) {
        if (!cancelled) setSourceError(err instanceof ApiError ? err.message : 'Failed to load this data source.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Defence in depth: if this component ever unmounts with data in state, drop it.
  useEffect(() => {
    return () => {
      setParsed(null);
    };
  }, []);

  /** Parse + audit a File that has already been obtained (from an <input>, a
   *  fresh picker selection, or a reopened handle). Never uploads the file —
   *  the only backend call is the metadata-only raw-access audit. Returns
   *  whether it succeeded so callers can decide the connection state. */
  const loadParsedFile = useCallback(
    async (file: File): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const result = await parseLocalFile(file);
        await apiFetch(`/data-sources/${id}/raw-access`, {
          method: 'POST',
          body: { rowCount: result.rows.length },
        });
        setParsed(result);
        setFileName(file.name);
        return true;
      } catch (err) {
        setParsed(null);
        if (err instanceof LocalFileError) setError(err.message);
        else if (err instanceof ApiError)
          setError(
            err.status === 403
              ? 'This source is not Gateway-connected, so its data cannot be viewed.'
              : `Could not authorize this view (${err.message}). Nothing was uploaded.`,
          );
        else setError('Could not open this file. Nothing was uploaded.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  // On mount: look up a saved local handle for THIS data source. Never prompts
  // for permission automatically — only checks the CURRENT permission state.
  useEffect(() => {
    if (!supported) {
      setConnection('unsupported');
      return;
    }
    let cancelled = false;
    (async () => {
      const record = await getHandle(id);
      if (cancelled) return;
      if (!record) {
        setConnection('idle');
        return;
      }
      setHandle(record.handle);
      setFileName(record.fileName);
      const permission = await queryHandlePermission(record.handle);
      if (cancelled) return;
      if (permission !== 'granted') {
        // 'prompt' or 'denied' — do NOT auto-request. Wait for an explicit click.
        setConnection('needs_reconnect');
        return;
      }
      setConnection('auto_loading');
      try {
        const file = await record.handle.getFile();
        if (cancelled) return;
        await loadParsedFile(file);
        if (!cancelled) setConnection('idle');
      } catch {
        if (!cancelled) {
          setError('The original file could not be accessed. It may have been moved, renamed, or deleted.');
          setConnection('unavailable');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, supported]);

  const clearView = useCallback(() => {
    setParsed(null);
    setQuery('');
    setReveal(false);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  async function onReconnectClick() {
    if (!handle) return;
    setBusy(true);
    setError(null);
    try {
      // requestPermission() is called ONLY from this click handler — the File
      // System Access API requires a user gesture for it to succeed at all.
      const permission = await requestHandlePermission(handle);
      if (permission !== 'granted') {
        setConnection('needs_reconnect');
        setError('Permission was not granted. Click Reconnect to try again, or choose a file below.');
        return;
      }
      const file = await handle.getFile().catch(() => null);
      if (!file) {
        setConnection('unavailable');
        setError('The original file could not be accessed. It may have been moved, renamed, or deleted.');
        return;
      }
      await loadParsedFile(file);
      setConnection('idle');
    } finally {
      setBusy(false);
    }
  }

  /** The File System Access picker — lets us save a reconnectable handle for
   *  next time. Only ever offered when the browser supports it. */
  async function onChooseFile() {
    if (!window.showOpenFilePicker) return;
    setBusy(true);
    setError(null);
    try {
      const [picked] = await window.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: FILE_PICKER_TYPES,
      });
      if (!picked) return;
      const file = await picked.getFile();
      await saveHandle(id, picked, file.name);
      setHandle(picked);
      setConnection('idle');
      await loadParsedFile(file);
    } catch (err) {
      // AbortError = the user cancelled the picker — not a failure to surface.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('Could not open the file picker.');
    } finally {
      setBusy(false);
    }
  }

  /** The plain <input type="file"> path — the ONLY option on a browser without
   *  the File System Access API. No handle is saved; nothing here pretends a
   *  persistent connection exists. */
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setQuery('');
    setReveal(false);
    await loadParsedFile(file);
  }

  const columns = useMemo(
    () => (parsed ? parsed.headers.map((h) => ({ header: h, ...maskForHeader(h) })) : []),
    [parsed],
  );

  const visibleRows = useMemo(() => {
    if (!parsed) return [];
    const q = query.trim().toLowerCase();
    if (!q) return parsed.rows;
    // Search runs on the RAW values (local only) so it is useful; display stays masked.
    return parsed.rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)));
  }, [parsed, query]);

  if (sourceError) return <div className="error">{sourceError}</div>;
  if (!source) return <p className="muted">Loading…</p>;

  const isGateway = source.dataAccessMode === 'gateway_connected' && source.status === 'active';
  // "Connected" is only ever claimed when this browser actually supports a
  // reconnectable handle AND one is currently backing what's on screen.
  const showConnectedBadge = supported && !!handle && !!parsed;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Data viewer</h1>
        <span className="badge warning">Gateway-connected</span>
        <Link href="/data-sources" className="nav-item" style={{ marginLeft: 'auto' }}>← Back to sources</Link>
      </div>
      <p className="muted">
        <strong>{source.name}</strong> ({source.sourceKind}). This viewer reads the file you choose
        entirely inside your browser and shows it here. The file and its contents are never uploaded
        to DPDP Shield — only the fact that you viewed it (and how many rows) is recorded.
      </p>

      {!isGateway ? (
        <div className="notice">
          This data source is <strong>Metadata-only</strong>. Raw data viewing is available only for
          sources explicitly set to <strong>Gateway-connected</strong>. Nothing can be read here.
        </div>
      ) : !canView ? (
        <div className="notice">Your role does not permit viewing raw data.</div>
      ) : (
        <>
          <div className="panel">
            {!supported && (
              <p className="muted" style={{ fontSize: '0.78rem', marginBottom: 8 }}>
                Your browser cannot keep a local file connected between visits. Choose the file again
                each time you open this viewer.
              </p>
            )}

            {connection === 'checking' && <p className="muted">Checking for a connected local file…</p>}
            {connection === 'auto_loading' && <p className="muted">Reopening your connected file…</p>}

            {connection === 'needs_reconnect' && (
              <div className="notice" style={{ marginBottom: 10 }}>
                {fileName ? <>Reconnect to <strong>{fileName}</strong></> : 'Reconnect to the local file'} —
                your browser needs you to confirm access again before this file can be reopened.
                <div style={{ marginTop: 8 }}>
                  <button type="button" onClick={() => void onReconnectClick()} disabled={busy}>
                    {busy ? 'Reconnecting…' : 'Reconnect'}
                  </button>
                </div>
              </div>
            )}

            {connection === 'unavailable' && (
              <div className="notice" style={{ marginBottom: 10 }}>
                The original file{fileName ? ` (${fileName})` : ''} could not be accessed. It may have
                been moved, renamed, or deleted. Choose another file below.
              </div>
            )}

            <label htmlFor="ds-file">Choose a local Excel (.xlsx) or CSV file</label>
            {supported ? (
              <div>
                <button type="button" onClick={() => void onChooseFile()} disabled={busy}>
                  {busy ? 'Working…' : handle ? 'Choose a different file' : 'Choose file'}
                </button>
              </div>
            ) : (
              <input
                id="ds-file"
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => void onFile(e)}
                disabled={busy}
              />
            )}
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: 6 }}>
              The file stays on your computer and in this browser only. Sensitive-looking columns are
              masked by default.
            </p>

            {busy && connection !== 'auto_loading' && <p className="muted">Reading in your browser…</p>}
            {error && <div className="error">{error}</div>}
          </div>

          {parsed && (
            <div className="panel" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <strong style={{ flex: 1, minWidth: 0 }}>{fileName}</strong>
                {showConnectedBadge && <span className="badge success">Connected</span>}
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  style={{ width: 'auto', flex: '0 1 240px' }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontSize: '0.85rem' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
                  Show sensitive values
                </label>
                <button type="button" onClick={clearView}>Close &amp; clear</button>
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
                {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} in browser
                {parsed.truncated && ' (showing the first rows only)'} · {visibleRows.length} shown
              </p>
              <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      {columns.map((c, i) => (
                        <th key={i}>
                          {c.header || <span className="muted">(col {i + 1})</span>}
                          {c.sensitive && <span className="badge warning" style={{ marginLeft: 6 }}>{c.label}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.slice(0, 500).map((row, ri) => (
                      <tr key={ri}>
                        {columns.map((c, ci) => (
                          <td key={ci} className={c.sensitive ? 'mono' : undefined}>
                            {c.sensitive && !reveal ? c.mask(row[ci] ?? '') : (row[ci] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {visibleRows.length > 500 && (
                <p className="muted" style={{ fontSize: '0.8rem' }}>Showing the first 500 matching rows.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
