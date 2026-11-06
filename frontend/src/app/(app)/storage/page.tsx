'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { StorageRoot } from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useCapabilities } from '../../../lib/capabilities';
import {
  CENTRAL_STORAGE_ROOT_NAME,
  connectCentralStorage,
  getCentralStorageStatus,
  reconnectCentralStorage,
  syncPendingSubmissions,
  type CentralStorageState,
} from '../../../lib/central-storage';
import type { CentralFsProvider } from '../../../lib/local-storage-provider';
import { isElectronStorageAvailable } from '../../../lib/electron-storage';
import { GatewayStorageLocations } from '../../../components/GatewayStorageLocations';
import { SourceAdministration } from '../../../components/SourceAdministration';

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

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
  // Defaults to false (hidden) while loading — see the same reasoning on the
  // Data Sources page's EnterpriseGatewayPanel gate.
  const { capabilities } = useCapabilities();
  const hasEnterpriseStorage = capabilities?.features.enterpriseGateway ?? false;

  const [state, setState] = useState<CentralStorageState>({ status: 'checking', root: null, handle: null, fs: null, displayName: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<string[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<{ synced: number; failed: number } | null>(null);

  // Whether we're running inside the installed Electron desktop app (native
  // Enterprise Storage bridge present). Computed after mount to avoid any SSR/
  // hydration mismatch — defaults to false so server render and first client
  // render agree, then flips on the client if the bridge exists.
  const [isElectron, setIsElectron] = useState(false);
  useEffect(() => {
    setIsElectron(isElectronStorageAvailable());
  }, []);

  // Enterprise Server Storage — a 'server'-provider root, if this tenant has
  // configured one. Independent of the SaaS browser-storage state above:
  // deployments configure at most one of these two in practice, but nothing
  // here assumes that; each panel just shows whatever exists.
  const [serverRoot, setServerRoot] = useState<StorageRoot | null | undefined>(undefined); // undefined = loading
  const [serverPathInput, setServerPathInput] = useState('');
  const [serverBusy, setServerBusy] = useState(false);
  const [serverVerify, setServerVerify] = useState<{ available: boolean; reason: string } | null>(null);

  // CONFIGURED (this row exists in Postgres) and AVAILABLE (the real
  // filesystem is reachable right now) are two separate questions, fetched
  // in two separate try/catch blocks on purpose: a transient failure to
  // VERIFY availability (a network blip, a slow probe) must never erase the
  // CONFIGURATION this call just successfully loaded — that would be
  // exactly the "configuration disappears" bug this page must not have.
  const loadServerRoot = useCallback(async () => {
    let found: StorageRoot | null;
    try {
      const { roots } = await apiFetch<{ roots: StorageRoot[] }>('/storage/roots');
      found = roots.find((r) => r.provider === 'server') ?? null;
      setServerRoot(found);
      setServerPathInput(found?.rootPath ?? '');
    } catch {
      setServerRoot(null);
      return;
    }
    if (found) {
      try {
        setServerVerify(await apiFetch(`/storage/roots/${found.id}/verify`, { method: 'POST' }));
      } catch {
        // Configuration stays exactly as loaded above; only the availability
        // badge stays "Checking…" until the next successful verify.
      }
    }
  }, []);

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
    void loadServerRoot();
  }, [load, loadServerRoot]);

  /** Persists rootPath (create-or-update the SAME storage_roots row — never
   *  a duplicate) and immediately re-verifies against the real filesystem.
   *  Shared by both the Browse Folder flow (below) and the manual/fallback
   *  path field's Save & Verify button. */
  async function saveServerPath(rootPath: string) {
    setServerBusy(true);
    setError(null);
    setServerVerify(null);
    try {
      const saved = serverRoot
        ? await apiFetch<StorageRoot>(`/storage/roots/${serverRoot.id}`, { method: 'PATCH', body: { name: serverRoot.name, rootPath } })
        : await apiFetch<StorageRoot>('/storage/roots', { method: 'POST', body: { name: 'DPDP Enterprise Server Storage', provider: 'server', rootPath } });
      setServerRoot(saved);
      setServerPathInput(saved.rootPath ?? '');
      setServerVerify(await apiFetch(`/storage/roots/${saved.id}/verify`, { method: 'POST' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the Enterprise storage location.');
    } finally {
      setServerBusy(false);
    }
  }

  /** Mirrors the backend's assertAbsoluteEnterprisePath exactly (storage.dto.
   *  ts / server-storage-fs.ts's isAbsoluteEnterprisePath) — catches the
   *  reproduced failure (a bare picked folder NAME saved as-is, silently
   *  resolving inside the backend's own working directory instead of the
   *  real mounted volume) at the moment of entry, with an immediate message,
   *  rather than only after a round trip to the server. The backend enforces
   *  the SAME rule regardless — this is a UX improvement, not the safety net. */
  function isAbsoluteEnterprisePath(rootPath: string): boolean {
    return /^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(rootPath);
  }

  async function onSaveServerPath(e: React.FormEvent) {
    e.preventDefault();
    const rootPath = serverPathInput.trim();
    if (!rootPath) return;
    if (!isAbsoluteEnterprisePath(rootPath)) {
      setError(
        `"${rootPath}" is not a full path — it looks like just a folder name. Enter the complete path as this server sees it ` +
          `(e.g. "/enterprise-storage" in Docker, or "D:\\CompanyData\\DPDP" on a native Windows install).`,
      );
      return;
    }
    await saveServerPath(rootPath);
  }

  /** Browse Folder — the primary Enterprise Storage UX, same File System
   *  Access API entry point as the working SaaS Browse Storage above. Opens
   *  the native OS picker so the admin visually confirms a real folder on
   *  THIS machine (the browser only ever runs on the machine the Enterprise
   *  runtime is installed on — see the page header).
   *
   *  UNLIKE SaaS storage, the picked DirectoryHandle itself is NEVER saved
   *  or used for Enterprise writes — the File System Access API deliberately
   *  never exposes an absolute OS path to JavaScript (a browser security
   *  boundary, not fixable here), so a handle cannot become a path the
   *  backend/worker process can open. The picker exists ONLY to let the
   *  admin visually confirm the folder exists and read its name off the OS
   *  dialog; the path field is deliberately left for the admin to type/
   *  confirm explicitly (never silently pre-filled with just the bare name,
   *  which is exactly the value that caused a real, reproduced bug: it
   *  looked like a complete answer and was accepted as one, but resolved
   *  inside the backend's own working directory instead of the configured
   *  volume — see isAbsoluteEnterprisePath above and the backend's matching
   *  validation, both of which now reject that shape outright). */
  async function onBrowseServerFolder() {
    if (!('showDirectoryPicker' in window)) {
      setError('This browser does not support folder selection. Use a Chromium-based browser (Chrome/Edge), or enter the path manually below.');
      return;
    }
    try {
      const handle = await (window as unknown as { showDirectoryPicker: (opts?: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      showServerPathConfirmHint(handle.name);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : 'Could not open the folder picker.');
      }
    }
  }

  const [serverPathConfirmHint, setServerPathConfirmHint] = useState<string | null>(null);
  function showServerPathConfirmHint(folderName: string) {
    setServerPathConfirmHint(
      `You selected the folder named "${folderName}". A browser can never read out its full path — type the COMPLETE path to it below, ` +
        `as this server sees it (e.g. "/enterprise-storage" in Docker, or "D:\\...\\${folderName}" on a native Windows install), then Save & Verify.`,
    );
  }

  async function onVerifyServerPath() {
    if (!serverRoot) return;
    setServerBusy(true);
    setError(null);
    try {
      setServerVerify(await apiFetch(`/storage/roots/${serverRoot.id}/verify`, { method: 'POST' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the Enterprise storage location.');
    } finally {
      setServerBusy(false);
    }
  }

  const loadEntries = useCallback(async (fs: CentralFsProvider, at: string[]) => {
    setEntriesLoading(true);
    try {
      setEntries(await fs.browse(at));
    } catch {
      setError('Could not read this folder from the connected storage.');
    } finally {
      setEntriesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (state.status === 'connected' && state.fs) void loadEntries(state.fs, path);
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
    if (!state.fs) return;
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await state.fs.createFolder(path, name);
      setNewFolderName('');
      await loadEntries(state.fs, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the folder.');
    } finally {
      setBusy(false);
    }
  }

  // The actual sync work (syncPendingSubmissions) is shared with
  // (app)/layout.tsx, which already triggers it automatically once per
  // authenticated session, on WHATEVER page a staff member opens — not just
  // this one (Central DPDP Storage automatic sync). This button is only the
  // manual fallback the spec asks to keep.
  async function onSyncPending() {
    if (!state.fs || !state.root) return;
    setSyncing(true);
    setError(null);
    try {
      setSyncSummary(await syncPendingSubmissions(state));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check for pending submissions.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <h1>Gateway &amp; storage administration</h1>
      <p className="muted">
        Technical setup, for administrators. Day to day, nobody needs this page: connected folders are listed under{' '}
        <Link href="/data-sources">Sources &amp; Storage</Link>, and a consent form&apos;s destinations are chosen in the
        form itself. Nothing here — file contents, documents, customer data — is ever sent to or stored in DPDP&apos;s
        central database; only the configuration is remembered centrally.
      </p>

      <div className="panel" style={{ marginBottom: 16 }}>
        <SourceAdministration />
      </div>

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Main storage folder</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          Every consent submission is filed here. This is the only storage a customer has to set up.
        </p>

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
            <span className="badge warning">⚠ Configured but unavailable</span>{' '}
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
              <span className="badge success">✓ Available</span>{' '}
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

      {hasEnterpriseStorage && <GatewayStorageLocations canManage={canManage} />}

      {/* Everything below is secondary: an alternative storage provider for
          server deployments, a folder browser, and the manual sync fallback.
          All of it still works exactly as before — it is collapsed so the
          routine workflow above is not buried under provider choices. */}
      <details style={{ marginBottom: 16 }}>
        <summary className="muted" style={{ fontSize: '0.85rem', marginBottom: 8 }}>
          Advanced storage settings
        </summary>

      {/* The backend/worker `server`-provider path (Docker bind-mount deployment
          model). Hidden inside the installed Electron desktop app, where the
          "Main storage folder" panel above IS Enterprise Storage and writes
          natively to the chosen folder via the Electron main process — no
          manual path typing, no browser folder handle. Still shown in a plain
          browser / dev environment, where that native bridge is absent. */}
      {!isElectron && hasEnterpriseStorage && (
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Enterprise Server Storage</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Choose where DPDP should store enterprise customer data — a filesystem location on this machine
          (or a mounted/network drive it can reach), read and written directly by the backend/worker process
          running here. Synchronization then happens automatically, without the browser or this page needing
          to stay open.
        </p>

        {serverRoot === undefined && <p className="muted">Checking…</p>}

        {serverRoot === null && !canManage && <p className="muted" style={{ fontSize: '0.85rem' }}>Not configured.</p>}

        {serverRoot !== undefined && canManage && (
          <div>
            <button className="primary" type="button" disabled={serverBusy} onClick={() => void onBrowseServerFolder()}>
              Browse Folder
            </button>
            {serverPathConfirmHint && <p className="notice" style={{ marginTop: 8, fontSize: '0.85rem' }}>{serverPathConfirmHint}</p>}

            <form onSubmit={onSaveServerPath} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
              <div style={{ flex: '1 1 320px' }}>
                <label htmlFor="server-path">Storage location {serverRoot ? '' : '(fallback: type the full path directly)'}</label>
                <input
                  id="server-path"
                  value={serverPathInput}
                  onChange={(e) => setServerPathInput(e.target.value)}
                  placeholder="D:\DPDP Central Storage"
                  disabled={serverBusy}
                />
              </div>
              <button type="submit" disabled={serverBusy || serverPathInput.trim().length < 1}>
                {serverBusy ? 'Working…' : serverRoot ? 'Save & Verify' : 'Configure'}
              </button>
              {serverRoot && (
                <button type="button" disabled={serverBusy} onClick={() => void onVerifyServerPath()}>
                  Verify
                </button>
              )}
            </form>
          </div>
        )}

        {serverRoot && (
          <p style={{ marginTop: 12 }}>
            {serverVerify ? (
              <span className={`badge ${serverVerify.available ? 'success' : 'warning'}`}>
                {serverVerify.available ? '✓ Available' : '⚠ Configured but unavailable'}
              </span>
            ) : (
              <span className="muted">Checking availability…</span>
            )}
            <br />
            <span className="mono" style={{ fontSize: '0.85rem' }}>Location: {serverRoot.rootPath}</span>
            {serverVerify && !serverVerify.available && (
              <>
                <br />
                <span className="muted" style={{ fontSize: '0.85rem' }}>Reason: {serverVerify.reason}</span>
              </>
            )}
            <br />
            <span className="muted" style={{ fontSize: '0.85rem' }}>Synchronization: Automatic (submission-time, plus a background sweep every 30s).</span>
          </p>
        )}
      </div>
      )}

      {state.status === 'connected' && state.fs && (
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
      </details>
    </div>
  );
}
