'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { parseLocalFile, LocalFileError, type ParsedFile } from '../../../../../lib/local-file';
import { maskForHeader } from '../../../../../lib/pii-mask';
import type { DataSource } from '@dpdp/shared';

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * Phase-2 raw-data viewer (Mode-B proof).
 *
 * The customer's data is read and displayed ENTIRELY in this browser. The file
 * the user picks, its bytes, and the parsed rows never leave the page — the only
 * backend interaction is a metadata-only "raw-access" call (row count), which
 * (a) re-verifies server-side that this is an active, gateway_connected source
 * the user is authorized for, and (b) records the audited fact of access. The
 * table is revealed ONLY after that call succeeds; if it fails, the parsed data
 * is discarded and NEVER uploaded. Leaving/closing this view clears the rows.
 */
export default function RawDataViewerPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canView = !!user && MANAGE_ROLES.has(user.role);

  const [source, setSource] = useState<DataSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  // Raw data lives ONLY in this component's local state. No context, no store,
  // no browser persistence. It is dropped on unmount and on close.
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Server-authoritative check (RLS-scoped): mode + tenant + existence.
        const s = await apiFetch<DataSource>(`/data-sources/${id}`);
        if (!cancelled) setSource(s);
      } catch (err) {
        if (!cancelled) setSourceError(err instanceof ApiError ? err.message : 'Failed to load this data source.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Defence in depth: if this component ever unmounts with data in state, drop it.
  useEffect(() => {
    return () => {
      setParsed(null);
    };
  }, []);

  const clearView = useCallback(() => {
    setParsed(null);
    setFileName(null);
    setQuery('');
    setReveal(false);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setParsed(null);
    setQuery('');
    setReveal(false);
    try {
      // 1. Parse ENTIRELY in the browser.
      const result = await parseLocalFile(file);
      // 2. Metadata-only audit + server-authoritative authorization. The rows are
      //    NOT sent — only their count. Reveal is gated on this succeeding.
      await apiFetch(`/data-sources/${id}/raw-access`, {
        method: 'POST',
        body: { rowCount: result.rows.length },
      });
      // 3. Only now reveal.
      setParsed(result);
      setFileName(file.name);
    } catch (err) {
      // Fail closed. On ANY error (parse, auth, audit, network) we discard the
      // parsed data and show a message. We NEVER fall back to uploading it.
      setParsed(null);
      setFileName(null);
      if (err instanceof LocalFileError) setError(err.message);
      else if (err instanceof ApiError)
        setError(
          err.status === 403
            ? 'This source is not Gateway-connected, so its data cannot be viewed.'
            : `Could not authorize this view (${err.message}). Nothing was uploaded.`,
        );
      else setError('Could not open this file. Nothing was uploaded.');
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo(
    () => (parsed ? parsed.headers.map((h) => ({ header: h, ...maskForHeader(h) })) : []),
    [parsed],
  );

  const visibleRows = useMemo(() => {
    if (!parsed) return [];
    const q = query.trim().toLowerCase();
    if (!q) return parsed.rows;
    // Search runs on the RAW values (local only) so it is useful; display stays masked.
    return parsed.rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)));
  }, [parsed, query]);

  if (sourceError) return <div className="error">{sourceError}</div>;
  if (!source) return <p className="muted">Loading…</p>;

  const isGateway = source.dataAccessMode === 'gateway_connected' && source.status === 'active';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Data viewer</h1>
        <span className="badge warning">Gateway-connected</span>
        <Link href="/data-sources" className="nav-item" style={{ marginLeft: 'auto' }}>← Back to sources</Link>
      </div>
      <p className="muted">
        <strong>{source.name}</strong> ({source.sourceKind}). This viewer reads the file you choose
        entirely inside your browser and shows it here. The file and its contents are never uploaded
        to DPDP Shield — only the fact that you viewed it (and how many rows) is recorded.
      </p>

      {!isGateway ? (
        <div className="notice">
          This data source is <strong>Metadata-only</strong>. Raw data viewing is available only for
          sources explicitly set to <strong>Gateway-connected</strong>. Nothing can be read here.
        </div>
      ) : !canView ? (
        <div className="notice">Your role does not permit viewing raw data.</div>
      ) : (
        <>
          <div className="panel">
            <label htmlFor="ds-file">Choose a local Excel (.xlsx) or CSV file</label>
            <input
              id="ds-file"
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => void onFile(e)}
              disabled={busy}
            />
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: 6 }}>
              The file stays on your computer and in this browser tab only. Sensitive-looking columns
              are masked by default.
            </p>
            {busy && <p className="muted">Reading in your browser…</p>}
            {error && <div className="error">{error}</div>}
          </div>

          {parsed && (
            <div className="panel" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <strong style={{ flex: 1, minWidth: 0 }}>{fileName}</strong>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  style={{ width: 'auto', flex: '0 1 240px' }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontSize: '0.85rem' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
                  Show sensitive values
                </label>
                <button type="button" onClick={clearView}>Close &amp; clear</button>
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
                {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} in browser
                {parsed.truncated && ' (showing the first rows only)'} · {visibleRows.length} shown
              </p>
              <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      {columns.map((c, i) => (
                        <th key={i}>
                          {c.header || <span className="muted">(col {i + 1})</span>}
                          {c.sensitive && <span className="badge warning" style={{ marginLeft: 6 }}>{c.label}</span>}
                        </th>
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
              {visibleRows.length > 500 && (
                <p className="muted" style={{ fontSize: '0.8rem' }}>Showing the first 500 matching rows.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
