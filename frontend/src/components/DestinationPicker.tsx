'use client';

/**
 * ONE destination picker for a consent-form field: pick Central DPDP Storage
 * (always written, the authoritative evidence store) or browse an authorized
 * Enterprise location and pick a folder inside it — with breadcrumbs, folder
 * navigation and new-folder creation, like any file dialog.
 *
 * Everything it uses already exists:
 *   - the storage-plane session + /storage/browse + /storage/folder/create
 *     (lib/gateway-storage-session.ts — the Gateway re-checks containment,
 *     symlinks and write authorization on every call);
 *   - storage_roots / storage_folders for the central record of the chosen
 *     folder, and storage_mappings (moduleKey 'consent_form_field') for the
 *     field -> folder mapping. No new model, no new registry.
 *
 * Only locations authorized FOR WRITING appear: the list comes from
 * Gateway-provider storage roots, never from readable data sources. A
 * location whose Gateway is offline is shown and clearly labelled rather than
 * hidden, so an administrator can still see what is configured.
 */
import { useCallback, useEffect, useState } from 'react';
import type { StorageFolder, StorageRoot } from '@dpdp/shared';
import { apiFetch, ApiError } from '../lib/api';
import { folderNameProblem } from '../lib/gateway-destinations';
import {
  browseStorageFolders,
  createStorageFolder,
  openGatewayStorageSession,
  type GatewayStorageSession,
} from '../lib/gateway-storage-session';

export interface ChosenDestination {
  /** 'central' = no extra copy; otherwise the storage_folders id to map to. */
  kind: 'central' | 'folder';
  folderId?: string;
  /** For the confirmation message only. */
  label: string;
}

export function DestinationPicker({
  fieldLabel,
  locations,
  gatewayOnline,
  onCancel,
  onChosen,
}: {
  fieldLabel: string;
  /** Active Gateway-provider storage roots — the writable locations. */
  locations: StorageRoot[];
  gatewayOnline: boolean | undefined;
  onCancel: () => void;
  onChosen: (d: ChosenDestination) => void;
}) {
  const [rootId, setRootId] = useState<string | null>(null);
  const [session, setSession] = useState<GatewayStorageSession | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');

  const root = locations.find((l) => l.id === rootId) ?? null;

  const list = useCallback(async (s: GatewayStorageSession, at: string[]) => {
    const { entries } = await browseStorageFolders(s, at);
    setFolders(entries.map((e) => e.name));
    setPath(at);
  }, []);

  /** Opens a location: one storage-plane session, then its top level. */
  const open = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      setFolders([]);
      try {
        const s = await openGatewayStorageSession(id);
        setSession(s);
        setRootId(id);
        await list(s, []);
      } catch (err) {
        setSession(null);
        setRootId(id);
        setError(err instanceof Error ? err.message : 'Could not open this location.');
      } finally {
        setBusy(false);
      }
    },
    [list],
  );

  // One location configured: open it straight away, no pointless choice.
  useEffect(() => {
    if (locations.length === 1 && rootId === null) void open(locations[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations.length]);

  async function go(at: string[]) {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await list(session, at);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that folder.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateFolder() {
    if (!session) return;
    const problem = folderNameProblem(newFolder);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The REAL folder first (the Gateway is the authority on its own
      // filesystem); the central record follows only when this succeeds.
      await createStorageFolder(session, path, newFolder.trim());
      setNewFolder('');
      await list(session, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the folder.');
    } finally {
      setBusy(false);
    }
  }

  /** Mirrors the browsed path into storage_folders (resolve-or-create each
   *  segment under its real parent) and hands back the leaf's id — what the
   *  field's existing mapping points at. The backend walks this same parent
   *  chain back into folder names when it hands a copy to the Gateway. */
  async function confirmFolder() {
    if (!root) return;
    if (path.length === 0) {
      setError('Choose or create a folder inside this location — DPDP does not write to its top level.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { folders: existing } = await apiFetch<{ folders: StorageFolder[] }>(`/storage/roots/${root.id}/folders`);
      let parentId: string | null = null;
      let leaf: StorageFolder | null = null;
      for (const name of path) {
        const found: StorageFolder | undefined = existing.find(
          (f) => f.storageRootId === root.id && f.parentFolderId === parentId && f.name === name && f.status === 'active',
        );
        leaf =
          found ??
          (await apiFetch<StorageFolder>('/storage/folders', {
            method: 'POST',
            body: { storageRootId: root.id, parentFolderId: parentId, name },
          }));
        if (!found) existing.push(leaf);
        parentId = leaf.id;
      }
      onChosen({ kind: 'folder', folderId: leaf!.id, label: `${root.name} / ${path.join(' / ')}` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this destination.');
    } finally {
      setBusy(false);
    }
  }

  const offline = gatewayOnline === false;

  return (
    <div className="modal-overlay" role="presentation" onClick={() => !busy && onCancel()}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dest-picker-title"
        style={{ width: 'min(680px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title" id="dest-picker-title">
          Where should “{fieldLabel}” be stored?
        </h2>

        <div className="panel" style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: '0.9rem' }}>Central DPDP Storage</strong>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '4px 0 8px' }}>
            Always used for every submission — this is the organisation&apos;s own evidence store. Choose this if you do
            not want an extra copy anywhere else.
          </p>
          <button type="button" disabled={busy} onClick={() => onChosen({ kind: 'central', label: 'Central DPDP Storage only' })}>
            Use Central storage only
          </button>
        </div>

        {locations.length === 0 ? (
          <p className="notice" style={{ fontSize: '0.85rem' }}>
            No other location is connected yet. To add one: open <strong>Sources &amp; Storage → Advanced storage
            settings</strong> and add a Gateway storage location, then on the Gateway computer open{' '}
            <strong>DPDP Gateway Setup → Manage sources</strong>, choose the folder, and grant it <strong>Write</strong>.
          </p>
        ) : (
          <>
            <label htmlFor="dest-location">Or keep an extra copy in</label>
            <select
              id="dest-location"
              value={rootId ?? ''}
              onChange={(e) => void open(e.target.value)}
              disabled={busy}
              style={{ marginBottom: 10 }}
            >
              <option value="" disabled>
                Choose a connected location…
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {offline ? ' (Gateway offline)' : ''}
                </option>
              ))}
            </select>

            {root && (
              <>
                <nav aria-label="Folder" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: '0.85rem', marginBottom: 6 }}>
                  <button type="button" className="link-button" onClick={() => void go([])} disabled={busy || path.length === 0}>
                    {root.name}
                  </button>
                  {path.map((seg, i) => (
                    <span key={`${i}-${seg}`}>
                      <span className="muted"> / </span>
                      <button type="button" className="link-button" onClick={() => void go(path.slice(0, i + 1))} disabled={busy || i === path.length - 1}>
                        {seg}
                      </button>
                    </span>
                  ))}
                </nav>

                <div className="table-wrap" style={{ flex: '1 1 auto', overflow: 'auto', minHeight: 120, maxHeight: 240 }}>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {folders.map((name) => (
                      <li key={name} style={{ padding: '4px 0' }}>
                        <button type="button" className="link-button" onClick={() => void go([...path, name])} disabled={busy}>
                          📁 {name}
                        </button>
                      </li>
                    ))}
                    {!busy && session && folders.length === 0 && (
                      <li className="muted" style={{ fontSize: '0.85rem' }}>No sub-folders here.</li>
                    )}
                  </ul>
                </div>
                {busy && <p className="muted" style={{ fontSize: '0.8rem' }}>Working…</p>}

                {session && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 180px' }}>
                      <label htmlFor="dest-new-folder">New folder here (optional)</label>
                      <input id="dest-new-folder" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} disabled={busy} />
                    </div>
                    <button type="button" disabled={busy || !newFolder.trim()} onClick={() => void onCreateFolder()}>
                      Create folder
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" type="button" disabled={busy || !session || path.length === 0} onClick={() => void confirmFolder()}>
            {path.length > 0 ? `Use “${path[path.length - 1]}”` : 'Use this folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
