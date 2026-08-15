'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GATEWAY_AUTH_HEADER, type DataSource, type ResourceHandle } from '@dpdp/shared';
import { apiFetch } from '../../../../../lib/api';
import { maskForHeader } from '../../../../../lib/pii-mask';

const KIND_LABEL: Record<string, string> = {
  csv: 'CSV', excel: 'Excel', filesystem: 'Filesystem',
  postgresql: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server',
};

/**
 * Phase-3D Gateway browser (minimum UI).
 *
 * Reads a customer's files THROUGH the Enterprise Gateway (the local agent),
 * never through our Azure backend. The browser talks to the Gateway directly at a
 * CONFIGURABLE address (no hardcoded localhost/LAN/IP) using the session token it
 * obtained from the Phase-3C pairing flow. Raw rows returned by the Gateway live
 * ONLY in this component's state, are masked by default, and are dropped on
 * unmount — never persisted, never sent onward.
 */

const DEFAULT_AGENT_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_GATEWAY_AGENT_URL) || '';

interface ReadResult {
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

export default function GatewayBrowserPage() {
  const { id: sourceId } = useParams<{ id: string }>();

  const [agentUrl, setAgentUrl] = useState(DEFAULT_AGENT_URL);
  const [sessionToken, setSessionToken] = useState('');
  const [resources, setResources] = useState<ResourceHandle[]>([]);
  const [selected, setSelected] = useState<ResourceHandle | null>(null);
  const [result, setResult] = useState<ReadResult | null>(null);
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<DataSource | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  // Source metadata (name + connector type) comes from the central API — METADATA
  // ONLY (never rows). The rows themselves only ever come from the Gateway below.
  useEffect(() => {
    let cancelled = false;
    apiFetch<DataSource>(`/data-sources/${sourceId}`)
      .then((s) => !cancelled && setSource(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  // Defence in depth: drop any raw rows if this view ever unmounts.
  useEffect(() => () => setResult(null), []);

  const call = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const base = agentUrl.trim().replace(/\/+$/, '');
      if (!base) throw new Error('Enter the Gateway address.');
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [GATEWAY_AUTH_HEADER]: sessionToken.trim() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ? `Gateway refused: ${j.error}` : `Gateway error (${res.status}).`);
      }
      return res.json();
    },
    [agentUrl, sessionToken],
  );

  async function discover() {
    setBusy(true);
    setError(null);
    setConnected(null);
    setResult(null);
    setSelected(null);
    try {
      // Discovery also serves as the connection test — it connects to the source.
      const res = (await call('/source/discover', { sourceId })) as { handles: ResourceHandle[] };
      setResources(res.handles);
      setConnected(`Connected — ${res.handles.length} resource${res.handles.length === 1 ? '' : 's'} found.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection/discovery failed.');
    } finally {
      setBusy(false);
    }
  }

  async function open(handle: ResourceHandle) {
    setBusy(true);
    setError(null);
    setResult(null);
    setQuery('');
    setReveal(false);
    setSelected(handle);
    try {
      const res = (await call('/source/read', { sourceId, handle: handle.handle, limit: 200 })) as ReadResult;
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Read failed.');
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo(
    () => (result ? result.headers.map((h) => ({ header: h, ...maskForHeader(h) })) : []),
    [result],
  );
  const visibleRows = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    if (!q) return result.rows;
    return result.rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)));
  }, [result, query]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Gateway browser</h1>
        <span className="badge warning">Enterprise Gateway</span>
        <Link href="/data-sources" className="nav-item" style={{ marginLeft: 'auto' }}>← Back to sources</Link>
      </div>
      <p className="muted">
        Reads this source <strong>through your Enterprise Gateway</strong> — files or database tables,
        the data never passes through DPDP Shield&apos;s servers. Enter your Gateway address and the
        session token from pairing. Sensitive columns are masked by default.
      </p>
      {source && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          <strong>{source.name}</strong> · Connector: <span className="badge neutral">{KIND_LABEL[source.sourceKind] ?? source.sourceKind}</span>
          {' · '}
          {source.dataAccessMode === 'gateway_connected' ? (
            <span className="badge success">Gateway-connected</span>
          ) : (
            <span className="badge warning">Not Gateway-connected</span>
          )}
        </p>
      )}

      <div className="panel">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 280px' }}>
            <label htmlFor="gw-url">Gateway address</label>
            <input id="gw-url" value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} placeholder="e.g. https://gateway.your-network.example:7071" disabled={busy} />
          </div>
          <div style={{ flex: '1 1 280px' }}>
            <label htmlFor="gw-token">Session token</label>
            <input id="gw-token" value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} placeholder="from pairing" disabled={busy} />
          </div>
          <button className="primary" type="button" onClick={() => void discover()} disabled={busy || !agentUrl.trim() || !sessionToken.trim()}>
            {busy ? 'Working…' : 'Test connection & discover'}
          </button>
        </div>
        {connected && <div className="notice" style={{ marginTop: 10 }}>{connected}</div>}
        {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {resources.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Resources</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {resources.map((r) => (
              <button key={r.handle} type="button" onClick={() => void open(r)} disabled={busy} className={selected?.handle === r.handle ? 'primary' : undefined}>
                {r.descriptor.label} <span className="muted">({Math.max(1, Math.round((r.descriptor.sizeBytes ?? 0) / 1024))} KB)</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <strong style={{ flex: 1, minWidth: 0 }}>{selected?.descriptor.label}</strong>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" style={{ width: 'auto', flex: '0 1 220px' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontSize: '0.85rem' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
              Show sensitive values
            </label>
            <button type="button" onClick={() => setResult(null)}>Close &amp; clear</button>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
            {result.rows.length} row{result.rows.length === 1 ? '' : 's'} from the Gateway{result.truncated && ' (bounded — more available)'} · {visibleRows.length} shown
          </p>
          <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th key={i}>{c.header || <span className="muted">(col {i + 1})</span>}{c.sensitive && <span className="badge warning" style={{ marginLeft: 6 }}>{c.label}</span>}</th>
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
        </div>
      )}
    </div>
  );
}
