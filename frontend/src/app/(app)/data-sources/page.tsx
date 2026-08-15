'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { DataSource, DataSourceKind } from '@dpdp/shared';
import { classifyGatewayConnection, probeGatewayHealth, type GatewayConnectionState } from '../../../lib/gateway-connection';
import { getHandle, isFileSystemAccessSupported, queryHandlePermission, removeHandle } from '../../../lib/local-source-handles';

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
  connected: 'Connected',
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
function EnterpriseGatewayPanel() {
  const { user } = useAuth();
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

  const probe = useCallback(async (current: GatewayDevice | null) => {
    if (!current || current.status !== 'active' || !current.endpoint) {
      setState(classifyGatewayConnection(current, null));
      return;
    }
    setProbing(true);
    try {
      const result = await probeGatewayHealth(current.endpoint);
      setState(classifyGatewayConnection(current, result));
    } finally {
      setProbing(false);
    }
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
    if (!window.confirm(`Revoke this Enterprise Gateway ("${device.displayName}")? You will need to enrol a new one to reconnect.`)) {
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
          {canManage && (
            <>
              {!enrollCode ? (
                <button className="primary" type="button" onClick={() => void onGenerateCode()} disabled={busy}>
                  {busy ? 'Working…' : 'Connect Enterprise Gateway'}
                </button>
              ) : (
                <div className="panel" style={{ marginTop: 8 }}>
                  <p style={{ marginTop: 0 }}>
                    Enrolment code (shown once): <span className="mono badge neutral">{enrollCode.code}</span>
                  </p>
                  <p className="muted" style={{ fontSize: '0.8rem' }}>
                    Configure this code in your Gateway installation (it expires{' '}
                    {new Date(enrollCode.expiresAt).toLocaleTimeString()}). Once the Gateway has enrolled,
                    click Refresh.
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
            <strong>{device.displayName}</strong> · {device.platform} · agent {device.agentVersion}
          </p>

          {state === 'offline' && (
            <div className="notice">
              Gateway unreachable at the configured endpoint. Start the local Gateway to access connected
              data sources, then retry.
            </div>
          )}
          {state === 'invalid' && (
            <div className="notice">The configured endpoint responded, but not as a DPDP Gateway. Check the address.</div>
          )}

          {canManage && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
              <div style={{ flex: '1 1 320px' }}>
                <label htmlFor="gw-endpoint">Gateway endpoint</label>
                <input
                  id="gw-endpoint"
                  value={endpointInput}
                  onChange={(e) => setEndpointInput(e.target.value)}
                  placeholder="e.g. http://192.168.1.50:7071"
                  disabled={busy}
                />
              </div>
              <button type="button" onClick={() => void onSaveEndpoint()} disabled={busy || endpointInput.trim() === (device.endpoint ?? '')}>
                Save endpoint
              </button>
              <button type="button" onClick={() => void probe(device)} disabled={busy || probing || !device.endpoint}>
                Retry
              </button>
              <button type="button" onClick={() => void onRevoke()} disabled={busy}>
                Revoke Gateway
              </button>
            </div>
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
export default function DataSourcesPage() {
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<DataSourceKind>('excel');
  const [hint, setHint] = useState('');
  const [creating, setCreating] = useState(false);

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
      !window.confirm(
        `Enable Gateway-connected mode for "${s.name}"?\n\n` +
          `This is a configuration state only. It records that this source is explicitly ` +
          `permitted to allow future Gateway-based access to raw values. It does NOT grant any ` +
          `access now — the Gateway does not exist yet, and no raw data can be read.`,
      )
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
    const reason = window.prompt(`Remove data source "${s.name}"? (reason, kept as evidence)`);
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
      <h1>Data Sources</h1>

      <EnterpriseGatewayPanel />

      <p className="muted">
        The systems and files your compliance work draws on. Each source has an <strong>access
        mode</strong>: <em>Metadata-only</em> (the default — structure and descriptions, never a
        customer value) or <em>Gateway-connected</em> (explicitly permitted to allow future
        Gateway-based access to raw values). Gateway access is not built yet — turning a source on
        here only records the permission; it reads nothing.
      </p>

      {error && <div className="error">{error}</div>}

      {canManage && (
        <form className="panel" onSubmit={onCreate} style={{ marginBottom: 16 }}>
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
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}{s.connectionHint && <div className="muted" style={{ fontSize: '0.78rem' }}>{s.connectionHint}</div>}</td>
                  <td className="muted">{KIND_LABEL[s.sourceKind] ?? s.sourceKind}</td>
                  <td>
                    {s.dataAccessMode === 'gateway_connected' ? (
                      <span className="badge warning">Gateway-connected</span>
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
                          {/* Raw viewer offered ONLY for Gateway-connected sources. */}
                          {s.dataAccessMode === 'gateway_connected' &&
                            (s.sourceKind === 'excel' || s.sourceKind === 'csv') && (
                              <>
                                <Link href={`/data-sources/${s.id}/viewer`} className="badge info" style={{ alignSelf: 'center' }}>
                                  Open data viewer
                                </Link>
                                <LocalSourceStatus sourceId={s.id} />
                              </>
                            )}
                          {/* Phase 3D: read via the Enterprise Gateway (files/DB, through the agent). */}
                          {s.dataAccessMode === 'gateway_connected' && (
                            <Link href={`/data-sources/${s.id}/gateway`} className="badge info" style={{ alignSelf: 'center' }}>
                              Gateway browser
                            </Link>
                          )}
                          <button type="button" disabled={busyId === s.id} onClick={() => void onToggleMode(s)}>
                            {s.dataAccessMode === 'metadata_only' ? 'Enable Gateway' : 'Disable Gateway'}
                          </button>
                          <button type="button" disabled={busyId === s.id} onClick={() => void onRemove(s)}>
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
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
