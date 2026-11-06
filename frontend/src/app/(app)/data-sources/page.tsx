'use client';

/**
 * Sources & Storage — the ONE customer-facing screen for connected folders.
 *
 * Deliberately free of Gateway machinery: no enrolment code, no pairing
 * panel, no Gateway address, no heartbeat, no source/storage ids, no
 * provider names, no manual source form. All of that still exists and is
 * still required — it lives on the administration page (components/
 * SourceAdministration.tsx, rendered at /storage), which is linked from
 * Settings, not from here.
 *
 * What a hotel owner or CA firm sees: the folders their Gateway administrator
 * authorized, whether DPDP can reach them, and a way to look inside the ones
 * it may read. Nothing to configure.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DataSource, GatewayRevokeFolderResponse, StorageRoot } from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../lib/api';
import { useCapabilities } from '../../../lib/capabilities';
import { useDialog } from '../../../components/Dialog';
import { GatewayFilePicker } from '../../../components/GatewayFilePicker';
import { connectedFolders, connectedLocations, permissionSentence } from '../../../lib/connected-locations';
import { classifyGatewayConnection } from '../../../lib/gateway-connection';

export default function SourcesAndStoragePage() {
  const { capabilities } = useCapabilities();
  const { confirm } = useDialog();
  const hasGateway = capabilities?.features.enterpriseGateway ?? false;

  const [sources, setSources] = useState<DataSource[]>([]);
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [gatewayOnline, setGatewayOnline] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [browseFolder, setBrowseFolder] = useState<DataSource | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Folder names whose removal DPDP has recorded but the Gateway computer
   *  has not applied yet. Shown as "Removal pending" — never as done. */
  const [pendingRemovals, setPendingRemovals] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);

  /** `quiet` re-reads without blanking the table — used by the poll below, so
   *  a folder approved on the Gateway computer appears on its own. */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([
        apiFetch<{ sources: DataSource[] }>('/data-sources'),
        apiFetch<{ roots: StorageRoot[] }>('/storage/roots').catch(() => ({ roots: [] as StorageRoot[] })),
      ]);
      setSources(s.sources);
      setRoots(r.roots);
      // One connection question, answered centrally: is the Gateway sending
      // heartbeats? No address, no probe, nothing technical surfaced.
      const { device } = await apiFetch<{ device: { status: string; endpoint: string | null; lastHeartbeatAt: string | null } | null }>(
        '/gateway/devices/active',
      ).catch(() => ({ device: null }));
      setGatewayOnline(device ? classifyGatewayConnection(device, null) === 'connected' : false);
      const { removals } = await apiFetch<{ removals: Array<{ label: string }> }>('/gateway/folders/pending-removals').catch(
        () => ({ removals: [] as Array<{ label: string }> }),
      );
      setPendingRemovals(removals.map((r) => r.label));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your connected folders.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A folder is approved on the GATEWAY computer, so nothing here can be
  // notified: the Gateway registers it with DPDP within a few seconds of the
  // approval. Re-reading while this page is open is what makes it appear by
  // itself, instead of leaving someone staring at a page that says "none".
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void load(true);
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const locations = useMemo(() => connectedLocations(sources, roots, { gatewayOnline }), [sources, roots, gatewayOnline]);
  /** One row per folder, not per grant — see connectedFolders. */
  const folders = useMemo(() => connectedFolders(locations), [locations]);
  /** Folders DPDP may READ — the ones worth opening from here. */
  const readable = useMemo(() => folders.filter((f) => f.readSourceId !== null), [folders]);

  /**
   * Remove one folder. The explanation comes BEFORE the confirmation, in the
   * customer's terms: what DPDP stops being able to do, and the one
   * consequence that needs a decision afterwards (a consent-form field that
   * was saving into it). Nothing about ids, paths, devices or protocols.
   */
  async function onRemove(folder: { name: string; capabilities: readonly string[] }) {
    const writes = folder.capabilities.includes('write');
    const ok = await confirm({
      title: `Remove "${folder.name}"?`,
      message:
        'DPDP will no longer be allowed to use this folder. ' +
        (writes ? 'Anything set up to save into it will stop until you choose another folder. ' : '') +
        'Your files are not deleted and stay exactly where they are, and nothing already collected is removed. ' +
        'You can allow the folder again later from DPDP Gateway Setup on the computer that holds it.',
      confirmLabel: 'Remove folder',
      danger: true,
    });
    if (!ok) return;
    setRemoving(folder.name);
    setNotice(null);
    setError(null);
    try {
      const res = await apiFetch<GatewayRevokeFolderResponse>('/gateway/folders/revoke', {
        method: 'POST',
        body: { label: folder.name },
      });
      const affected =
        res.affectedFormFields > 0
          ? ` ${res.affectedFormFields} form question${res.affectedFormFields === 1 ? ' was' : 's were'} saving into this folder and now need a new one — open your consent form to choose it.`
          : '';
      setNotice(
        res.gatewayPending
          ? `"${folder.name}" has been removed in DPDP. The computer that holds it is not connected right now, so it will stop offering the folder as soon as it reconnects.${affected}`
          : `"${folder.name}" has been removed.${affected}`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this folder. Please try again.');
    } finally {
      setRemoving(null);
      await load(true);
    }
  }

  return (
    <div>
      <h1>Sources &amp; Storage</h1>
      <p className="muted">
        The folders your organisation has allowed DPDP to use. Your files stay where they are — DPDP never copies them
        into its own database.
      </p>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* ONE small warning plus one recovery action — never an address or a
          heartbeat time. */}
      {hasGateway && gatewayOnline === false && !loading && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Reconnect required.</strong> DPDP cannot reach your folders right now. On the computer that holds
          them, make sure it is switched on and that <strong>DPDP Gateway</strong> is running, then{' '}
          <button type="button" onClick={() => void load()} disabled={loading}>
            check again
          </button>
          .
        </div>
      )}

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ marginTop: 0, marginBottom: 8 }}>Connected folders</h2>
          <button type="button" className="link-button" onClick={() => void load()} disabled={loading}>
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : folders.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem', margin: 0 }}>
            No folders are connected yet. On the computer that holds your files, open <strong>DPDP Gateway Setup</strong>{' '}
            and choose the folders DPDP may use. They appear here automatically.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Folder</th>
                  <th>What DPDP may do</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.key}>
                    <td>
                      {f.name}
                      <div className="muted" style={{ fontSize: '0.78rem' }}>{f.detail}</div>
                    </td>
                    <td className="muted">{permissionSentence(f.capabilities)}</td>
                    <td>
                      {pendingRemovals.includes(f.name) ? (
                        <span className="badge warning" title="Removed in DPDP; waiting for the computer that holds it to reconnect.">
                          Removal pending
                        </span>
                      ) : (
                        <span className={`badge ${f.availability === 'available' ? 'success' : f.availability === 'unavailable' ? 'warning' : 'neutral'}`}>
                          {f.availability === 'available' ? 'Connection available' : f.availability === 'unavailable' ? 'Reconnect required' : 'Checking…'}
                        </span>
                      )}
                    </td>
                    <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {f.readSourceId !== null && (
                        <button
                          type="button"
                          onClick={() => {
                            setNotice(null);
                            setBrowseFolder(sources.find((s) => s.id === f.readSourceId) ?? null);
                          }}
                        >
                          Choose folder
                        </button>
                      )}
                      {f.removable && (
                        <button type="button" disabled={removing === f.name} onClick={() => void onRemove(f)}>
                          {removing === f.name ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {readable.length > 0 && (
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            Open a folder to look through its files. Nothing is copied to DPDP by browsing.
          </p>
        )}
      </div>

      {/* The existing Gateway file browser, opened per folder rather than as a
          separate registration step. Browsing registers nothing; only the
          explicit confirm adds a file, for the features that need one. */}
      {browseFolder && (
        <GatewayFilePicker
          sources={sources}
          onClose={() => setBrowseFolder(null)}
          onAdded={(r) => {
            setBrowseFolder(null);
            if (r.added > 0 || r.failed.length > 0) {
              setNotice(
                [
                  r.added > 0 ? `${r.added} file${r.added === 1 ? '' : 's'} added to DPDP.` : '',
                  r.skipped ? `${r.skipped} already added.` : '',
                  r.failed.length ? `Problems: ${r.failed.join('; ')}` : '',
                ]
                  .filter(Boolean)
                  .join(' '),
              );
            }
            void load();
          }}
        />
      )}
    </div>
  );
}
