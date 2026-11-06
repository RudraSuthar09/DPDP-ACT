'use client';

/**
 * Data Sources -> "Select files": browse the files the connected Gateway is
 * AUTHORIZED to expose and add the chosen ones as data sources.
 *
 * Reuses, rather than duplicates:
 *   - the Gateway session handshake (lib/gateway-session.ts: active device ->
 *     /gateway/pairings -> {endpoint}/session/establish);
 *   - the Gateway data plane's /source/browse (one folder level by OPAQUE
 *     handle on an authorized folder source -- no path ever sent or shown);
 *   - the existing data-source API (POST /data-sources, PATCH .../mode).
 * Listing is metadata only (names, sizes); no file content is read here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GATEWAY_AUTH_HEADER, type DataSource, type GatewaySourceBrowseEntry } from '@dpdp/shared';
import { apiFetch, ApiError } from '../lib/api';
import { openGatewaySession, type GatewaySession } from '../lib/gateway-session';
import {
  decodeGatewayFileHint,
  encodeGatewayFileHint,
  formatBytes,
  formatLocation,
  isGatewayFolderSource,
  sourceKindForFile,
  type GatewayFileRef,
} from '../lib/gateway-file-source';

interface Crumb {
  label: string;
  handle: string | null;
}

interface Picked extends GatewayFileRef {
  key: string;
}

export function GatewayFilePicker({
  sources,
  onClose,
  onAdded,
}: {
  sources: DataSource[];
  onClose: () => void;
  onAdded: (summary: { added: number; skipped: number; failed: string[] }) => void;
}) {
  const folders = useMemo(() => sources.filter(isGatewayFolderSource), [sources]);
  const [folderId, setFolderId] = useState<string | null>(folders[0]?.id ?? null);
  const folder = folders.find((f) => f.id === folderId) ?? null;

  const [session, setSession] = useState<GatewaySession | null>(null);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<GatewaySourceBrowseEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Map<string, Picked>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (s: GatewaySession, sourceId: string, handle: string | null): Promise<{ entries: GatewaySourceBrowseEntry[]; truncated: boolean }> => {
      const res = await fetch(`${s.agentUrl}/source/browse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [GATEWAY_AUTH_HEADER]: s.sessionToken },
        body: JSON.stringify(handle ? { sourceId, folder: handle } : { sourceId }),
      }).catch(() => null);
      if (!res) throw new Error('This browser could not reach the Gateway. Browse from the computer where the DPDP Gateway is installed.');
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(`The Gateway refused to list this folder (${j.error ?? res.status}).`), { code: j.error });
      }
      return (await res.json()) as { entries: GatewaySourceBrowseEntry[]; truncated: boolean };
    },
    [],
  );

  // Open (or re-open) the session for the chosen authorized folder, then list its top.
  const openFolder = useCallback(
    async (f: DataSource) => {
      setBusy(true);
      setError(null);
      setEntries([]);
      setTrail([]);
      try {
        const s = await openGatewaySession(f.id);
        setSession(s);
        const r = await browse(s, f.id, null);
        setTrail([{ label: f.name, handle: null }]);
        setEntries(r.entries);
        setTruncated(r.truncated);
      } catch (err) {
        setSession(null);
        setError(err instanceof Error ? err.message : 'Could not open the Gateway folder.');
      } finally {
        setBusy(false);
      }
    },
    [browse],
  );

  useEffect(() => {
    if (folder) void openFolder(folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  async function goTo(nextTrail: Crumb[]) {
    if (!session || !folder) return;
    setBusy(true);
    setError(null);
    try {
      const last = nextTrail[nextTrail.length - 1]!;
      let r;
      try {
        r = await browse(session, folder.id, last.handle);
      } catch (err) {
        // A session can expire while the picker is open: re-establish once.
        if ((err as { code?: string }).code !== 'SESSION_EXPIRED' && (err as { code?: string }).code !== 'INVALID_TOKEN') throw err;
        const fresh = await openGatewaySession(folder.id);
        setSession(fresh);
        r = await browse(fresh, folder.id, last.handle);
      }
      setTrail(nextTrail);
      setEntries(r.entries);
      setTruncated(r.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that folder.');
    } finally {
      setBusy(false);
    }
  }

  const dirNames = trail.slice(1).map((c) => c.label);

  function toggle(entry: GatewaySourceBrowseEntry) {
    if (!folder) return;
    const ref: GatewayFileRef = { src: folder.id, dir: dirNames, file: entry.label, size: entry.sizeBytes };
    const key = encodeKey(ref);
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, { ...ref, key });
      return next;
    });
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    const existing = new Set(sources.map((s) => decodeGatewayFileHint(s.connectionHint)).filter((r): r is GatewayFileRef => r !== null).map(encodeKey));
    let added = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const p of picked.values()) {
      if (existing.has(p.key)) {
        skipped += 1; // already a source: never duplicated
        continue;
      }
      try {
        const created = await apiFetch<{ id: string }>('/data-sources', {
          method: 'POST',
          body: { name: p.file, sourceKind: sourceKindForFile(p.file), connectionHint: encodeGatewayFileHint(p) },
        });
        try {
          await apiFetch(`/data-sources/${created.id}/mode`, { method: 'PATCH', body: { enabled: true } });
        } catch (err) {
          failed.push(`${p.file}: added, but Gateway access could not be enabled (${err instanceof ApiError ? err.message : 'error'})`);
        }
        added += 1;
      } catch (err) {
        failed.push(`${p.file}: ${err instanceof Error ? err.message : 'could not be added'}`);
      }
    }
    setBusy(false);
    onAdded({ added, skipped, failed });
  }

  const pickedList = [...picked.values()];

  return (
    <div className="modal-overlay" role="presentation" onClick={() => !busy && onClose()}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gw-picker-title"
        style={{ width: 'min(760px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title" id="gw-picker-title">Select files</h2>

        {folders.length === 0 ? (
          <p className="modal-message">
            No folder has been shared with DPDP yet. On the computer that holds your files, open{' '}
            <strong>DPDP Gateway Setup → Folders DPDP may use</strong>, choose a folder and allow DPDP to{' '}
            <strong>read files in this folder</strong>. It appears here on its own — there is nothing to copy or type.
          </p>
        ) : (
          <>
            {folders.length > 1 && (
              <div style={{ marginBottom: 8 }}>
                <label htmlFor="gw-picker-folder">Authorized Gateway folder</label>
                <select id="gw-picker-folder" value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value)} disabled={busy}>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <nav aria-label="Folder" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: '0.85rem', marginBottom: 6 }}>
              {trail.map((c, i) => (
                <span key={`${i}-${c.label}`}>
                  {i > 0 && <span className="muted"> / </span>}
                  <button type="button" className="link-button" onClick={() => void goTo(trail.slice(0, i + 1))} disabled={busy || i === trail.length - 1}>
                    {c.label}
                  </button>
                </span>
              ))}
            </nav>

            <div className="table-wrap" style={{ flex: '1 1 auto', overflow: 'auto', minHeight: 160 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const key = folder ? encodeKey({ src: folder.id, dir: dirNames, file: e.label }) : '';
                    return e.entryKind === 'folder' ? (
                      <tr key={e.handle} onDoubleClick={() => void goTo([...trail, { label: e.label, handle: e.handle }])}>
                        <td aria-hidden="true">📁</td>
                        <td>
                          <button type="button" className="link-button" onClick={() => void goTo([...trail, { label: e.label, handle: e.handle }])} disabled={busy}>
                            {e.label}
                          </button>
                        </td>
                        <td className="muted">Folder</td>
                        <td></td>
                      </tr>
                    ) : (
                      <tr key={e.handle}>
                        <td>
                          <input type="checkbox" aria-label={`Select ${e.label}`} checked={picked.has(key)} onChange={() => toggle(e)} disabled={busy} style={{ width: 'auto' }} />
                        </td>
                        <td>{e.label}</td>
                        <td className="muted">{sourceKindForFile(e.label).toUpperCase()}</td>
                        <td className="muted">{formatBytes(e.sizeBytes)}</td>
                      </tr>
                    );
                  })}
                  {!busy && session && entries.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">This folder has no sub-folders or supported files (.csv, .xlsx).</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {busy && <p className="muted" style={{ fontSize: '0.8rem' }}>Working…</p>}
            {truncated && <p className="muted" style={{ fontSize: '0.8rem' }}>Only the first 500 entries of this folder are shown.</p>}

            <div style={{ marginTop: 10 }}>
              <strong style={{ fontSize: '0.9rem' }}>
                Selected ({pickedList.length})
              </strong>
              {pickedList.length === 0 ? (
                <p className="muted" style={{ fontSize: '0.8rem', margin: '4px 0' }}>Tick files in any folder; the selection is kept while you navigate.</p>
              ) : (
                <ul style={{ margin: '4px 0', paddingLeft: 18, maxHeight: 110, overflow: 'auto', fontSize: '0.85rem' }}>
                  {pickedList.map((p) => (
                    <li key={p.key}>
                      {p.file} <span className="muted">· {formatLocation(p)} · {formatBytes(p.size)}</span>{' '}
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`Remove ${p.file} from the selection`}
                        onClick={() =>
                          setPicked((prev) => {
                            const next = new Map(prev);
                            next.delete(p.key);
                            return next;
                          })
                        }
                        disabled={busy}
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" type="button" onClick={() => void confirm()} disabled={busy || pickedList.length === 0}>
            {busy ? 'Working…' : pickedList.length === 0 ? 'Add files' : `Add ${pickedList.length} file${pickedList.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Details of a source created by the picker -- METADATA ONLY, from the
 * data-source record (no file content, no customer values).
 */
export function GatewayFileDetails({ source, folderName, onClose }: { source: DataSource; folderName: string | null; onClose: () => void }) {
  const ref = decodeGatewayFileHint(source.connectionHint);
  const rows: Array<[string, string]> = [
    ['File name', ref?.file ?? source.name],
    ['Type', ref ? (ref.file.includes('.') ? ref.file.slice(ref.file.lastIndexOf('.') + 1).toUpperCase() : 'File') : source.sourceKind],
    ['Location', ref ? `${folderName ?? 'Gateway folder (removed)'} / ${formatLocation(ref)}` : '-'],
    ['Size (when added)', ref ? formatBytes(ref.size) : '-'],
    ['Access mode', source.dataAccessMode === 'gateway_connected' ? 'Gateway-connected' : 'Metadata-only'],
    ['Status', source.status],
  ];
  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="gw-file-details" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title" id="gw-file-details">{source.name}</h2>
        <table>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th style={{ textAlign: 'left', paddingRight: 12 }}>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          The file stays on the Gateway computer; DPDP stores only these details. Removing this source never deletes or
          changes the file.
        </p>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Identity of a picked file: same folder source + same folders + same name. */
function encodeKey(ref: Pick<GatewayFileRef, 'src' | 'dir' | 'file'>): string {
  return JSON.stringify([ref.src, ...ref.dir, ref.file]);
}
