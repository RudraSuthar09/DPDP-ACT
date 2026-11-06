'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError, API_URL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCapabilities } from '../lib/capabilities';
import type { DataSource, DataSourceKind, StorageRoot } from '@dpdp/shared';
import { GatewayFileDetails, GatewayFilePicker } from './GatewayFilePicker';
import { ConnectedLocationsPanel } from './ConnectedLocationsPanel';
import { decodeGatewayFileHint, formatBytes, formatLocation } from '../lib/gateway-file-source';
import {
  classifyBrowserAccess,
  classifyGatewayConnection,
  probeGatewayHealth,
  type BrowserAccessState,
  type GatewayConnectionState,
} from '../lib/gateway-connection';
import { getHandle, isFileSystemAccessSupported, queryHandlePermission, removeHandle } from '../lib/local-source-handles';
import { useDialog } from './Dialog';

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * Phase — persistent SaaS local Excel/CSV source. This status is derived
 * ENTIRELY from this browser's own IndexedDB + a live permission check — it is
 * never stored centrally and never read from the backend, because whether a
 * local file can be reopened is inherently specific to this device and this
 * browser profile, not to the tenant. Each row checks its OWN data source id
 * independently, so one source's handle can never be confused with another's.
 */
type LocalConnectionStatus = 'checking' | 'connected' | 'needs_reconnect' | 'not_connected' | 'unsupported';

const LOCAL_STATUS_LABEL: Record<LocalConnectionStatus, string> = {
  checking: 'Checking…',
  connected: 'Connected',
  needs_reconnect: 'Reconnect required',
  not_connected: 'Not connected',
  unsupported: 'Unsupported browser',
};
const LOCAL_STATUS_BADGE: Record<LocalConnectionStatus, string> = {
  checking: 'neutral',
  connected: 'success',
  needs_reconnect: 'warning',
  not_connected: 'neutral',
  unsupported: 'neutral',
};

/** Local-file connection status for one Excel/CSV row, computed client-side
 *  only. Not rendered at all for sources this feature doesn't apply to. */
function LocalSourceStatus({ sourceId }: { sourceId: string }) {
  const [status, setStatus] = useState<LocalConnectionStatus>('checking');

  useEffect(() => {
    let cancelled = false;
    if (!isFileSystemAccessSupported()) {
      setStatus('unsupported');
      return;
    }
    (async () => {
      const record = await getHandle(sourceId);
      if (cancelled) return;
      if (!record) {
        setStatus('not_connected');
        return;
      }
      const permission = await queryHandlePermission(record.handle);
      if (cancelled) return;
      setStatus(permission === 'granted' ? 'connected' : 'needs_reconnect');
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  return <span className={`badge ${LOCAL_STATUS_BADGE[status]}`} style={{ marginLeft: 6 }}>{LOCAL_STATUS_LABEL[status]}</span>;
}

/** The JSON shape of GET/PATCH /gateway/devices* — mirrors the backend
 *  DeviceView (kept as a local type, same convention as other pages). */
interface GatewayDevice {
  id: string;
  platform: string;
  agentVersion: string;
  displayName: string;
  status: string;
  endpoint: string | null;
  enrolledAt: string;
  lastHeartbeatAt: string | null;
}

const STATE_LABEL: Record<GatewayConnectionState, string> = {
  not_configured: 'Not connected',
  no_endpoint: 'Endpoint not configured',
  connected: 'Online',
  offline: 'Offline',
  invalid: 'Invalid configuration',
};
const STATE_BADGE: Record<GatewayConnectionState, string> = {
  not_configured: 'neutral',
  no_endpoint: 'warning',
  connected: 'success',
  offline: 'denied',
  invalid: 'denied',
};

/**
 * Phase 3G-2.5 — the persistent Enterprise Gateway connection. The CENTRAL
 * database (GET /gateway/devices/active) is the source of truth for "which
 * Gateway is configured for this tenant" — never localStorage/sessionStorage
 * alone, so the connection survives a refresh, a new login, or a different
 * browser. The endpoint is a plain, non-secret URL the client explicitly sets;
 * security still depends entirely on the existing Phase-3C device/session
 * mechanism, untouched here. Reachability is checked directly against the
 * Gateway's own /health — never through the central backend, and never in a
 * way that can crash the page (every fetch is wrapped and classified).
 */
function EnterpriseGatewayPanel({ onConnectionState }: { onConnectionState?: (s: GatewayConnectionState) => void }) {
  const { user } = useAuth();
  const { confirm } = useDialog();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [device, setDevice] = useState<GatewayDevice | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<GatewayConnectionState>('not_configured');
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enrollCode, setEnrollCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [endpointInput, setEndpointInput] = useState('');

  const loadDevice = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetch<{ device: GatewayDevice | null }>('/gateway/devices/active');
      setDevice(res.device);
      setEndpointInput(res.device?.endpoint ?? '');
      return res.device;
    } catch (err) {
      // A failure to reach the CENTRAL backend must never blank the page —
      // report it and let the rest of Data Sources still render.
      setLoadError(err instanceof ApiError ? err.message : 'Could not load the Gateway configuration.');
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  // Online/Offline comes from the Gateway's heartbeat to DPDP (central record).
  // Separately, probe whether THIS browser can open the Gateway's local
  // address (self-registered by the Gateway), which folder browsing needs.
  const [browserAccess, setBrowserAccess] = useState<BrowserAccessState>('no_endpoint');
  const probe = useCallback(async (current: GatewayDevice | null) => {
    const connection = classifyGatewayConnection(current, null);
    setState(connection);
    // Lifted to the page so the unified Connected-locations list can report
    // availability for Gateway-backed locations without a second fetch of
    // the same device record.
    onConnectionState?.(connection);
    if (!current || current.status !== 'active' || !current.endpoint) {
      setBrowserAccess(classifyBrowserAccess(current, null));
      return;
    }
    setProbing(true);
    try {
      const result = await probeGatewayHealth(current.endpoint);
      setBrowserAccess(classifyBrowserAccess(current, result));
    } finally {
      setProbing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadDevice().then((d) => void probe(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onGenerateCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ code: string; codePrefix: string; expiresAt: string }>('/gateway/enrollments', {
        method: 'POST',
        body: {},
      });
      setEnrollCode({ code: res.code, expiresAt: res.expiresAt });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create an enrolment code.');
    } finally {
      setBusy(false);
    }
  }

  async function onRefreshAfterEnroll() {
    setBusy(true);
    setError(null);
    try {
      const d = await loadDevice();
      if (d) setEnrollCode(null);
      await probe(d);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveEndpoint() {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<GatewayDevice>(`/gateway/devices/${device.id}/endpoint`, {
        method: 'PATCH',
        body: { endpoint: endpointInput.trim() || null },
      });
      setDevice(updated);
      await probe(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the Gateway endpoint.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke() {
    if (!device) return;
    if (
      !(await confirm({
        title: 'Revoke Enterprise Gateway',
        message: `Revoke this Enterprise Gateway ("${device.displayName}")? You will need to enrol a new one to reconnect.`,
        confirmLabel: 'Revoke',
        danger: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/gateway/devices/${device.id}/revoke`, { method: 'POST', body: {} });
      setDevice(null);
      setEndpointInput('');
      setState('not_configured');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the Gateway.');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null; // brief — avoids a state flash, never a blank page beyond this

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Enterprise Gateway</h2>
        <span className={`badge ${STATE_BADGE[state]}`}>{STATE_LABEL[state]}</span>
        {probing && <span className="muted" style={{ fontSize: '0.8rem' }}>checking…</span>}
      </div>

      {loadError && (
        <div className="notice" style={{ marginTop: 10 }}>
          Could not reach DPDP&apos;s server to load your Gateway configuration ({loadError}). Data
          Sources below may be incomplete until this is retried.{' '}
          <button type="button" onClick={() => void loadDevice()}>Retry</button>
        </div>
      )}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}

      {!device && !loadError && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Connect a local/Enterprise Gateway once — it stays connected across logins, refreshes, and
            sessions. Your customer files/databases never leave your environment; only Gateway
            configuration (not your data) is stored here.
          </p>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            <strong>Already installed a Gateway on a computer?</strong> It may still hold a pairing this workspace no
            longer has, in which case it refuses to pair again. Open <strong>DPDP Gateway Setup</strong> on that
            computer and check its status screen first: once the Gateway service can run, it clears a pairing the
            workspace has dropped by itself, and <strong>Remove Gateway</strong> there is the deliberate way to clear
            it. Then come back and generate a code.
          </p>
          {canManage && (
            <>
              {!enrollCode ? (
                <button className="primary" type="button" onClick={() => void onGenerateCode()} disabled={busy}>
                  {busy ? 'Working…' : 'Connect Enterprise Gateway'}
                </button>
              ) : (
                <div className="panel" style={{ marginTop: 8 }}>
                  <p style={{ marginTop: 0 }}>
                    Server address: <span className="mono badge neutral">{API_URL}</span>
                  </p>
                  <p>
                    Enrolment code (shown once): <span className="mono badge neutral">{enrollCode.code}</span>
                  </p>
                  <p className="muted" style={{ fontSize: '0.8rem' }}>
                    On the Gateway computer, open <strong>DPDP Gateway Setup</strong> and enter this server
                    address and code (the code expires {new Date(enrollCode.expiresAt).toLocaleTimeString()}).
                    Once the Gateway shows Connected, click Refresh.
                  </p>
                  <button type="button" onClick={() => void onRefreshAfterEnroll()} disabled={busy}>
                    {busy ? 'Checking…' : 'Refresh'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {device && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>{device.displayName}</strong> · {device.platform} · agent {device.agentVersion} · last heartbeat{' '}
            {device.lastHeartbeatAt ? new Date(device.lastHeartbeatAt).toLocaleString() : 'never'}
          </p>

          {state === 'offline' && (
            <div className="notice">
              DPDP has not heard from this Gateway recently. Check that the DPDP Gateway service is running on its
              computer (Windows Services → DPDP Gateway Agent), then click Refresh.
            </div>
          )}
          {state === 'connected' && browserAccess === 'unreachable' && (
            <div className="notice">
              The Gateway is online, but this browser cannot open it. Browsing folders and data through the Gateway works
              from the computer where it is installed (or set a network address under Advanced).
            </div>
          )}
          {state === 'connected' && browserAccess === 'no_endpoint' && (
            <div className="notice">The Gateway is online and will report its local address with its next heartbeat. Click Refresh in a minute.</div>
          )}
          {browserAccess === 'invalid' && (
            <div className="notice">The Gateway address responded, but not as a DPDP Gateway. Check the address under Advanced.</div>
          )}

          {canManage && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
              <button type="button" onClick={() => void onRefreshAfterEnroll()} disabled={busy || probing}>
                Refresh
              </button>
              <button type="button" onClick={() => void onRevoke()} disabled={busy}>
                Revoke Gateway
              </button>
            </div>
          )}

          {canManage && (
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ fontSize: '0.85rem' }}>
                Advanced: Gateway address{device.endpoint ? ` (${device.endpoint})` : ''}
              </summary>
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                Not needed for a Gateway on this computer: it registers its own local address. Set a network address only
                when the dashboard is used from other computers and the Gateway is reachable over your network.
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 320px' }}>
                  <label htmlFor="gw-endpoint">Gateway address</label>
                  <input
                    id="gw-endpoint"
                    value={endpointInput}
                    onChange={(e) => setEndpointInput(e.target.value)}
                    placeholder="e.g. http://192.168.1.50:7071"
                    disabled={busy}
                  />
                </div>
                <button type="button" onClick={() => void onSaveEndpoint()} disabled={busy || endpointInput.trim() === (device.endpoint ?? '')}>
                  Save address
                </button>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

const KIND_OPTIONS: Array<{ value: DataSourceKind; label: string }> = [
  { value: 'excel', label: 'Excel' },
  { value: 'csv', label: 'CSV' },
  { value: 'filesystem', label: 'Filesystem / folder' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'sqlserver', label: 'SQL Server' },
];
const KIND_LABEL = Object.fromEntries(KIND_OPTIONS.map((o) => [o.value, o.label])) as Record<string, string>;

/**
 * Data Sources (Phase 1). Manage the metadata for a client's data sources and
 * each source's access mode. This screen is METADATA/CONFIG ONLY — there is no
 * customer-data viewer here, and enabling "Gateway-connected" grants no raw
 * access yet (the Gateway does not exist). It only records that a source is
 * explicitly permitted to allow future Gateway-based access.
 */
export function SourceAdministration() {
  const { user } = useAuth();
  const { confirm, promptText } = useDialog();
  const canManage = !!user && MANAGE_ROLES.has(user.role);
  // Defaults to false (hidden) while capabilities are still loading, not
  // true — the brief absence of Enterprise-only UI for an Enterprise tenant
  // is a minor flash; showing it to a SaaS tenant even for one frame is not
  // the direction to default a security-adjacent gate in.
  const { capabilities } = useCapabilities();
  const hasGateway = capabilities?.features.enterpriseGateway ?? false;

  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<DataSourceKind>('excel');
  const [hint, setHint] = useState('');
  const [creating, setCreating] = useState(false);

  // "Select files": the Gateway file picker, and the details view of a picked file.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailsOf, setDetailsOf] = useState<DataSource | null>(null);

  // Reported by EnterpriseGatewayPanel; drives nothing here but is kept so
  // the panel's classification has a single owner on this page.
  const [, setGatewayState] = useState<GatewayConnectionState | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ sources: DataSource[] }>('/data-sources');
      setSources(res.sources);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load data sources.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await apiFetch('/data-sources', {
        method: 'POST',
        body: { name: name.trim(), sourceKind: kind, connectionHint: hint.trim() || undefined },
      });
      setName('');
      setHint('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the data source.');
    } finally {
      setCreating(false);
    }
  }

  async function onToggleMode(s: DataSource) {
    const enabling = s.dataAccessMode === 'metadata_only';
    if (
      enabling &&
      !(await confirm({
        title: 'Enable Gateway-connected mode',
        message:
          `Enable Gateway-connected mode for "${s.name}"?\n\n` +
          `This is a configuration state only. It records that this source is explicitly ` +
          `permitted to allow future Gateway-based access to raw values. It does NOT grant any ` +
          `access now — the Gateway does not exist yet, and no raw data can be read.`,
        confirmLabel: 'Enable',
      }))
    ) {
      return;
    }
    setBusyId(s.id);
    setError(null);
    try {
      await apiFetch(`/data-sources/${s.id}/mode`, { method: 'PATCH', body: { enabled: enabling } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the access mode.');
    } finally {
      setBusyId(null);
    }
  }

  async function onRemove(s: DataSource) {
    const reason = await promptText({
      title: 'Remove data source',
      message: `Remove data source "${s.name}"?`,
      label: 'Reason (kept as evidence)',
      multiline: true,
      confirmLabel: 'Remove',
    });
    if (reason === null) return;
    setBusyId(s.id);
    setError(null);
    try {
      await apiFetch(`/data-sources/${s.id}`, { method: 'DELETE', body: { reason: reason.trim() || undefined } });
      // Best-effort local cleanup — this browser's saved handle (if any) is
      // meaningless once the central source is gone. Must never block or fail
      // the deletion itself.
      try {
        await removeHandle(s.id);
      } catch {
        /* best-effort only */
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the data source.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Sources and Gateway administration</h2>

      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Technical configuration for this workspace&apos;s Gateway and data sources. Ordinary users never need this page
        — their connected folders are listed under <Link href="/data-sources">Sources &amp; Storage</Link>. Each source
        has an <strong>access mode</strong>: <em>Metadata-only</em> (the default — structure and descriptions, never a
        customer value) or <em>Gateway-connected</em> (explicitly permitted for real access through the DPDP Gateway).
      </p>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {canManage && hasGateway && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Add files from your Gateway</h2>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
            Registers individual files as data sources, for features that read one specific file. Ordinary browsing
            needs none of this.
          </p>
          <button className="primary" type="button" onClick={() => { setNotice(null); setPickerOpen(true); }} disabled={loading}>
            Select files
          </button>
        </div>
      )}

      {pickerOpen && (
        <GatewayFilePicker
          sources={sources}
          onClose={() => setPickerOpen(false)}
          onAdded={(r) => {
            setPickerOpen(false);
            setNotice(
              [
                `${r.added} file${r.added === 1 ? '' : 's'} added.`,
                r.skipped ? `${r.skipped} already added (skipped).` : '',
                r.failed.length ? `Problems: ${r.failed.join('; ')}` : '',
              ]
                .filter(Boolean)
                .join(' '),
            );
            void load();
          }}
        />
      )}

      {/* Gateway pairing/status: enrolment code, reachability, address and
          revoke. This is THE place these controls live — they are deliberately
          absent from the customer-facing page. */}
      {hasGateway && <EnterpriseGatewayPanel onConnectionState={setGatewayState} />}

      {detailsOf && <GatewayFileDetails source={detailsOf} folderName={sources.find((s) => s.id === decodeGatewayFileHint(detailsOf.connectionHint)?.src)?.name ?? null} onClose={() => setDetailsOf(null)} />}

      {canManage && (
        <details style={{ marginBottom: 16 }} open={!hasGateway}>
          <summary className="muted" style={{ fontSize: '0.85rem', marginBottom: 8 }}>
            Add a source manually (databases, other systems)
          </summary>
        <form className="panel" onSubmit={onCreate}>
          <h2 style={{ marginTop: 0 }}>Add a data source</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <label htmlFor="ds-name">Name</label>
              <input id="ds-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finance shared drive" disabled={creating} />
            </div>
            <div>
              <label htmlFor="ds-kind">Type</label>
              <select id="ds-kind" value={kind} onChange={(e) => setKind(e.target.value as DataSourceKind)} disabled={creating}>
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <label htmlFor="ds-hint">Identifier (optional, non-secret)</label>
              <input id="ds-hint" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. \\nas\finance — never a password" disabled={creating} />
            </div>
            <button className="primary" type="submit" disabled={creating || name.trim().length < 2}>
              {creating ? 'Adding…' : 'Add source'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.78rem', marginTop: 8 }}>
            New sources always start in <strong>Metadata-only</strong>. Never put a password, API key,
            or connection secret in the identifier field.
          </p>
        </form>
        </details>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Access mode</th>
                <th>Status</th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const picked = decodeGatewayFileHint(s.connectionHint);
                return (
                <tr key={s.id}>
                  <td>
                    {s.name}
                    {picked ? (
                      <div className="muted" style={{ fontSize: '0.78rem' }}>
                        Gateway file · {formatLocation(picked)} · {formatBytes(picked.size)} ·{' '}
                        <button type="button" className="link-button" onClick={() => setDetailsOf(s)}>
                          Details
                        </button>
                      </div>
                    ) : (
                      s.connectionHint && <div className="muted" style={{ fontSize: '0.78rem' }}>{s.connectionHint}</div>
                    )}
                  </td>
                  <td className="muted">{KIND_LABEL[s.sourceKind] ?? s.sourceKind}</td>
                  <td>
                    {s.dataAccessMode === 'gateway_connected' ? (
                      <>
                        <span className="badge warning">Gateway-connected</span>
                        {/* For an authorized FOLDER source: the ID the Gateway uses for it
                            (DPDP Gateway Setup -> Manage sources -> Source ID). Picked files
                            need no ID of their own. */}
                        {!picked && (
                          <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
                            Gateway source ID: <span className="mono">{s.id}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="badge neutral">Metadata-only</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${s.status === 'active' ? 'success' : 'muted'}`}>{s.status}</span>
                  </td>
                  {canManage && (
                    <td>
                      {s.status === 'active' && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {/* Raw viewer offered ONLY for Gateway-connected sources (not for a
                              picked Gateway file: its details are shown via "Details"). */}
                          {s.dataAccessMode === 'gateway_connected' && !picked &&
                            (s.sourceKind === 'excel' || s.sourceKind === 'csv') && (
                              <>
                                <Link href={`/data-sources/${s.id}/viewer`} className="badge info" style={{ alignSelf: 'center' }}>
                                  Open data viewer
                                </Link>
                                <LocalSourceStatus sourceId={s.id} />
                              </>
                            )}
                          {/* Phase 3D: read via the Enterprise Gateway (files/DB, through the agent). */}
                          {s.dataAccessMode === 'gateway_connected' && hasGateway && !picked && (
                            <Link href={`/data-sources/${s.id}/gateway`} className="badge info" style={{ alignSelf: 'center' }}>
                              Gateway browser
                            </Link>
                          )}
                          {/* Turning Gateway-connected mode ON requires the enterpriseGateway
                              capability; turning it back OFF never does, so a tenant that lost
                              the capability (e.g. a plan change) can still clean up existing
                              state instead of being stuck with a button that would just 403. */}
                          {(hasGateway || s.dataAccessMode === 'gateway_connected') && (
                            <button type="button" disabled={busyId === s.id} onClick={() => void onToggleMode(s)}>
                              {s.dataAccessMode === 'metadata_only' ? 'Enable Gateway' : 'Disable Gateway'}
                            </button>
                          )}
                          <button type="button" disabled={busyId === s.id} onClick={() => void onRemove(s)}>
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
                );
              })}
              {sources.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 5 : 4} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    No data sources yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
