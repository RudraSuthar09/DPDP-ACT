'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import type { DataSource, DataSourceKind } from '@dpdp/shared';

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

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
                              <Link href={`/data-sources/${s.id}/viewer`} className="badge info" style={{ alignSelf: 'center' }}>
                                Open data viewer
                              </Link>
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
