'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GATEWAY_AUTH_HEADER,
  NEW_CUSTOMER_COLUMN_TYPES,
  type DataSource,
  type FieldDescriptor,
  type NewCustomerColumnType,
  type ResourceHandle,
} from '@dpdp/shared';
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

  // --- Phase 3G-2: customer resolution / controlled write / create / column-create
  // (verification UI only — this is NOT the public consent-form submission flow).
  const [fields, setFields] = useState<FieldDescriptor[]>([]);
  const [identityColumnInput, setIdentityColumnInput] = useState('');
  const [identityValue, setIdentityValue] = useState('');
  const [customerRef, setCustomerRef] = useState<string | null>(null);
  const [findStatus, setFindStatus] = useState<'idle' | 'found' | 'not-found'>('idle');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [customerBusy, setCustomerBusy] = useState(false);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [customerNotice, setCustomerNotice] = useState<string | null>(null);
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnType, setNewColumnType] = useState<NewCustomerColumnType>('text');
  const [columnBusy, setColumnBusy] = useState(false);
  const [columnError, setColumnError] = useState<string | null>(null);
  const [columnNotice, setColumnNotice] = useState<string | null>(null);

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
    // Reset the 3G-2 customer-records panel for the newly selected resource.
    setFields([]);
    setCustomerRef(null);
    setFindStatus('idle');
    setFieldValues({});
    setCustomerError(null);
    setCustomerNotice(null);
    try {
      const res = (await call('/source/read', { sourceId, handle: handle.handle, limit: 200 })) as ReadResult;
      setResult(res);
      if (handle.descriptor.resourceKind === 'table') {
        const f = (await call('/source/fields', { sourceId, handle: handle.handle })) as { fields: FieldDescriptor[] };
        setFields(f.fields);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Read failed.');
    } finally {
      setBusy(false);
    }
  }

  /** Record a METADATA-ONLY fact centrally, after the Gateway operation already
   *  completed. Never sends identityValue/fields/customerRef — only the action
   *  name and an optional row count. Best-effort: a failure here never blocks
   *  or reverses the Gateway-side operation that already happened. */
  async function auditGatewayEvent(action: string, rowCount?: number) {
    try {
      await apiFetch(`/data-sources/${sourceId}/gateway-events`, { method: 'POST', body: { action, rowCount } });
    } catch {
      /* best-effort — the Gateway operation already succeeded or failed on its own */
    }
  }

  async function onFindCustomer() {
    if (!selected || !identityValue.trim()) return;
    setCustomerBusy(true);
    setCustomerError(null);
    setCustomerNotice(null);
    setCustomerRef(null);
    setFindStatus('idle');
    try {
      const res = (await call('/source/customer/resolve', {
        sourceId,
        handle: selected.handle,
        identityValue: identityValue.trim(),
      })) as { exists: boolean; customerRef: string | null };
      setFindStatus(res.exists ? 'found' : 'not-found');
      setCustomerRef(res.customerRef);
      setFieldValues({});
      void auditGatewayEvent('gateway.customer.resolved', res.exists ? 1 : 0);
    } catch (err) {
      setCustomerError(err instanceof Error ? err.message : 'Could not resolve this customer.');
    } finally {
      setCustomerBusy(false);
    }
  }

  async function onSaveCustomerFields() {
    if (!customerRef) return;
    const toSend = Object.fromEntries(Object.entries(fieldValues).filter(([, v]) => v.trim().length > 0));
    if (Object.keys(toSend).length === 0) {
      setCustomerError('Enter at least one field value to save.');
      return;
    }
    setCustomerBusy(true);
    setCustomerError(null);
    setCustomerNotice(null);
    try {
      await call('/source/customer/write', { sourceId, customerRef, fields: toSend });
      setCustomerNotice('Saved — the mapped fields were updated through the Gateway.');
      void auditGatewayEvent('gateway.customer.updated');
    } catch (err) {
      setCustomerError(err instanceof Error ? err.message : 'Could not save (unmapped column, or write not configured).');
      void auditGatewayEvent('gateway.customer.write_failed');
    } finally {
      setCustomerBusy(false);
    }
  }

  async function onCreateCustomer() {
    if (!selected || !identityValue.trim()) return;
    const toSend = Object.fromEntries(Object.entries(fieldValues).filter(([, v]) => v.trim().length > 0));
    setCustomerBusy(true);
    setCustomerError(null);
    setCustomerNotice(null);
    try {
      const res = (await call('/source/customer/create', {
        sourceId,
        handle: selected.handle,
        identityValue: identityValue.trim(),
        fields: toSend,
      })) as { created: boolean; exists: boolean; customerRef: string | null };
      setCustomerRef(res.customerRef);
      setFindStatus('found');
      setCustomerNotice(
        res.created ? 'Customer created through the Gateway.' : 'A customer with this identity already existed — using the existing record.',
      );
      void auditGatewayEvent('gateway.customer.created');
    } catch (err) {
      setCustomerError(
        err instanceof Error
          ? `Could not create (${err.message}) — creation may be disabled for this source.`
          : 'Customer creation is disabled for this source.',
      );
    } finally {
      setCustomerBusy(false);
    }
  }

  async function onCreateColumn() {
    if (!selected || !newColumnName.trim()) return;
    if (!window.confirm(`Create a new column "${newColumnName.trim()}" (${newColumnType}) in this table? This changes the client's database schema.`)) {
      return;
    }
    setColumnBusy(true);
    setColumnError(null);
    setColumnNotice(null);
    try {
      await call('/source/column/create', { sourceId, handle: selected.handle, columnName: newColumnName.trim(), columnType: newColumnType });
      setColumnNotice(`Column "${newColumnName.trim()}" created. Refreshing fields…`);
      setNewColumnName('');
      void auditGatewayEvent('gateway.column.created');
      const f = (await call('/source/fields', { sourceId, handle: selected.handle })) as { fields: FieldDescriptor[] };
      setFields(f.fields);
    } catch (err) {
      setColumnError(
        err instanceof Error
          ? `Could not create the column (${err.message}). For CSV/XLSX, add it externally then refresh.`
          : 'Could not create the column.',
      );
    } finally {
      setColumnBusy(false);
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

      {fields.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Customer records (Gateway-side verification)</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Verifies the Gateway&apos;s resolve/write/create capability directly — this is <strong>not</strong> the
            public consent-form flow. Values you enter here go only to the Gateway, over this same connection;
            nothing is stored centrally except the metadata-only fact that an operation happened.
          </p>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 200px' }}>
              <label htmlFor="cust-identity-col">Identity column</label>
              <input id="cust-identity-col" value={identityColumnInput} onChange={(e) => setIdentityColumnInput(e.target.value)} placeholder="e.g. email" disabled={customerBusy} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <label htmlFor="cust-identity-val">Identity value</label>
              <input id="cust-identity-val" value={identityValue} onChange={(e) => setIdentityValue(e.target.value)} placeholder="e.g. rahul@example.com" disabled={customerBusy} />
            </div>
            <button className="primary" type="button" onClick={() => void onFindCustomer()} disabled={customerBusy || !identityValue.trim()}>
              {customerBusy ? 'Working…' : 'Find customer'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.78rem' }}>
            The Gateway uses its own configured identity column (shown above only for reference) — the browser
            cannot choose a different one.
          </p>

          {findStatus === 'found' && <div className="notice" style={{ marginTop: 10 }}>Customer found.</div>}
          {findStatus === 'not-found' && <div className="notice" style={{ marginTop: 10 }}>Customer not found.</div>}
          {customerNotice && <div className="notice" style={{ marginTop: 10 }}>{customerNotice}</div>}
          {customerError && <div className="error" style={{ marginTop: 10 }}>{customerError}</div>}

          {findStatus !== 'idle' && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                {findStatus === 'found'
                  ? 'Enter values for the mapped fields you want to update.'
                  : 'Not found. If creation is enabled for this source, enter values and create.'}
              </p>
              {fields.map((f) => (
                <div key={f.name} style={{ marginBottom: 8 }}>
                  <label htmlFor={`cf-val-${f.name}`}>{f.name}</label>
                  <input
                    id={`cf-val-${f.name}`}
                    value={fieldValues[f.name] ?? ''}
                    onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                    disabled={customerBusy}
                  />
                </div>
              ))}
              {findStatus === 'found' ? (
                <button className="primary" type="button" onClick={() => void onSaveCustomerFields()} disabled={customerBusy}>
                  Save
                </button>
              ) : (
                <button className="primary" type="button" onClick={() => void onCreateCustomer()} disabled={customerBusy}>
                  Create customer
                </button>
              )}
            </div>
          )}

          <div style={{ marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Create new column</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 200px' }}>
                <label htmlFor="new-col-name">Column name</label>
                <input id="new-col-name" value={newColumnName} onChange={(e) => setNewColumnName(e.target.value)} placeholder="e.g. pan_number" disabled={columnBusy} />
              </div>
              <div>
                <label htmlFor="new-col-type">Type</label>
                <select id="new-col-type" value={newColumnType} onChange={(e) => setNewColumnType(e.target.value as NewCustomerColumnType)} disabled={columnBusy}>
                  {NEW_CUSTOMER_COLUMN_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <button type="button" onClick={() => void onCreateColumn()} disabled={columnBusy || !newColumnName.trim()}>
                {columnBusy ? 'Working…' : 'Create column'}
              </button>
            </div>
            <p className="muted" style={{ fontSize: '0.78rem' }}>
              Requires a privileged write credential to be configured on the Gateway; asks for confirmation before
              running. For CSV/XLSX sources this is unsupported — add the column externally, then refresh.
            </p>
            {columnNotice && <div className="notice" style={{ marginTop: 10 }}>{columnNotice}</div>}
            {columnError && <div className="error" style={{ marginTop: 10 }}>{columnError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
