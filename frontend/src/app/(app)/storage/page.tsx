'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import {
  CENTRAL_STORAGE_ROOT_NAME,
  connectCentralStorage,
  getCentralStorageStatus,
  reconnectCentralStorage,
  resolveCustomerFolder,
  writeCustomerInformation,
  type CentralStorageState,
} from '../../../lib/central-storage';
import { browseLocalFolder, createLocalFolder } from '../../../lib/local-storage-provider';

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/** Local mirror of GET /consent/forms — enough to iterate templates for the
 *  pending-sync sweep. */
interface ConsentTemplate {
  id: string;
  name: string;
  retentionMonths: number | null;
}

interface PendingSubmission {
  id: string;
  channel: 'widget' | 'link';
  submittedAt: string;
  subjectRef: string;
  /** The stable INTERNAL customer UUID (data_principals registry) — never
   *  the subjectRef hash. See central-storage.ts's resolveCustomerFolder. */
  customerId: string;
  answers: Array<{ purposeName: string | null; granted: boolean }>;
}

/**
 * DPDP Central Storage — one local folder per tenant, selected once, browsed
 * here, and used as the destination for every DPDP module's evidence. No
 * provider choice, no Gateway pairing surfaced here: this page only ever
 * drives a real, client-selected local folder via the browser's File System
 * Access API (see central-storage.ts). Gateway/Enterprise storage remains
 * available in the platform for the separate Data Source connector workflow
 * — it is simply not part of this screen.
 *
 * The central configuration (that a root named "DPDP Central Storage" exists)
 * lives in PostgreSQL, so it survives a refresh/new login/restart; the
 * BROWSER's permission to actually reach the real folder is a separate,
 * per-device thing this page checks and can ask to restore, but it never
 * forgets or overwrites the central record just because permission lapsed.
 */
export default function StoragePage() {
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [state, setState] = useState<CentralStorageState>({ status: 'checking', root: null, handle: null, displayName: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<string[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<{ synced: number; failed: number } | null>(null);
  const [syncAttempted, setSyncAttempted] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await getCentralStorageStatus());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load storage configuration.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadEntries = useCallback(async (handle: FileSystemDirectoryHandle, at: string[]) => {
    setEntriesLoading(true);
    try {
      setEntries(await browseLocalFolder(handle, at));
    } catch {
      setError('Could not read this folder from the connected storage.');
    } finally {
      setEntriesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (state.status === 'connected' && state.handle) void loadEntries(state.handle, path);
  }, [state, path, loadEntries]);

  async function onConnect() {
    setBusy(true);
    setError(null);
    try {
      setState(await connectCentralStorage());
      setPath([]);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : 'Could not connect to local storage.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onReconnect() {
    setBusy(true);
    setError(null);
    try {
      setState(await reconnectCentralStorage(state));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reconnect to local storage.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!state.handle) return;
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await createLocalFolder(state.handle, path, name);
      setNewFolderName('');
      await loadEntries(state.handle, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the folder.');
    } finally {
      setBusy(false);
    }
  }

  async function onSyncPending() {
    if (!state.handle || !state.root) return;
    setSyncing(true);
    setError(null);
    let synced = 0;
    let failed = 0;
    try {
      const { forms } = await apiFetch<{ forms: ConsentTemplate[] }>('/consent/forms');
      for (const form of forms) {
        const { submissions } = await apiFetch<{ submissions: PendingSubmission[] }>(
          `/consent/forms/${form.id}/submissions/pending-local-sync`,
        );
        for (const submission of submissions) {
          try {
            // Deferred sync only ever has the opaque subjectRef/customerId —
            // the raw identity value (and any field VALUE, which never
            // reached the backend at all — I1) was never sent to or stored
            // by the backend (I2). Only the customer's folder + Customer
            // Information/ can be recovered here; field values collected on
            // a device with no connected storage are simply not
            // recoverable, by design — resolveCustomerFolder still reuses
            // (never duplicates) the SAME folder a later/earlier synchronous
            // write for this same customerId would use.
            const displayNameHint = `customer-${submission.customerId.slice(0, 8)}`;
            const customer = await resolveCustomerFolder(state.handle, state.root.id, submission.customerId, displayNameHint);
            await writeCustomerInformation(
              state.handle,
              customer.name,
              { customerId: submission.customerId, subjectRef: submission.subjectRef, displayName: null, createdAt: submission.submittedAt },
              { templateName: form.name, retentionMonths: form.retentionMonths },
            );

            await apiFetch(`/consent/forms/${form.id}/submissions/${submission.id}/mark-synced`, { method: 'POST' });
            synced += 1;
          } catch {
            failed += 1;
          }
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check for pending submissions.');
    } finally {
      setSyncSummary({ synced, failed });
      setSyncAttempted(true);
      setSyncing(false);
    }
  }

  // Automatic first sync attempt once connected (staff opening the page IS
  // the sync trigger for the hybrid model) — still re-triggerable manually.
  useEffect(() => {
    if (state.status === 'connected' && state.handle && canManage && !syncAttempted && !syncing) {
      void onSyncPending();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, canManage]);

  return (
    <div>
      <h1>DPDP Central Storage</h1>
      <p className="muted">
        Select the local folder on this organisation&apos;s own computer/server where DPDP files its
        modules&apos; evidence. Nothing here — file contents, documents, customer data — is ever sent to or
        stored in DPDP&apos;s central database; only this configuration (that a folder is connected) is
        remembered centrally, so it is still here after a refresh, a new login, or a restart.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Central DPDP Storage</h2>

        {state.status === 'checking' && <p className="muted">Checking…</p>}

        {state.status === 'unsupported' && (
          <p className="notice">
            This browser does not support local folder selection. Use a Chromium-based browser (Chrome/Edge)
            on this device to connect Central DPDP Storage.
          </p>
        )}

        {state.status === 'not_configured' && (
          <div>
            <p className="muted">Central DPDP Storage is not configured yet.</p>
            {canManage ? (
              <button className="primary" type="button" disabled={busy} onClick={() => void onConnect()}>
                {busy ? 'Working…' : 'Select Folder'}
              </button>
            ) : (
              <p className="muted" style={{ fontSize: '0.85rem' }}>Ask an owner/DPO/compliance officer to configure this.</p>
            )}
          </div>
        )}

        {state.status === 'needs_reconnect' && (
          <div className="notice">
            Storage permission needs to be restored on this device.{' '}
            {canManage && (
              <button type="button" disabled={busy} onClick={() => void onReconnect()}>
                {busy ? 'Working…' : 'Reconnect Storage'}
              </button>
            )}
          </div>
        )}

        {state.status === 'connected' && (
          <div>
            <p>
              <span className="badge success">✓ Connected</span>{' '}
              <span className="mono">{state.displayName ?? CENTRAL_STORAGE_ROOT_NAME}</span>
            </p>
            {canManage && (
              <button type="button" disabled={busy} onClick={() => void onConnect()}>
                Browse / Change Folder
              </button>
            )}
          </div>
        )}
      </div>

      {state.status === 'connected' && state.handle && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Browse storage</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            {path.length === 0 ? state.displayName ?? CENTRAL_STORAGE_ROOT_NAME : path.join(' / ')}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button type="button" disabled={path.length === 0} onClick={() => setPath([])}>Top level</button>
            {path.length > 0 && (
              <button type="button" onClick={() => setPath((p) => p.slice(0, -1))}>Up one level</button>
            )}
          </div>

          {entriesLoading ? (
            <p className="muted">Loading…</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {entries.map((name) => (
                <li key={name} style={{ padding: '4px 0' }}>
                  <button
                    type="button"
                    onClick={() => setPath((p) => [...p, name])}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                  >
                    📁 {name}
                  </button>
                </li>
              ))}
              {entries.length === 0 && <li className="muted">No folders here yet.</li>}
            </ul>
          )}

          {canManage && (
            <form onSubmit={onCreateFolder} style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px' }}>
                <label htmlFor="new-folder">New folder</label>
                <input id="new-folder" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} disabled={busy} />
              </div>
              <button className="primary" type="submit" disabled={busy || newFolderName.trim().length < 1}>
                {busy ? 'Working…' : 'Create Folder'}
              </button>
            </form>
          )}
        </div>
      )}

      {state.status === 'connected' && canManage && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Sync pending consent submissions</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Consent submitted from a device that was not connected to this storage (e.g. a customer&apos;s own
            self-service link) is recorded centrally and written here the next time this page is opened —
            named by the customer&apos;s pseudonymised reference, since the platform never stores their raw
            name (see CLAUDE.md I2).
          </p>
          {syncSummary && (
            <p>
              Last sync: <strong>{syncSummary.synced}</strong> written
              {syncSummary.failed > 0 && <span className="error"> — {syncSummary.failed} failed</span>}.
            </p>
          )}
          <button type="button" disabled={syncing} onClick={() => void onSyncPending()}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      )}
    </div>
  );
}
