'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';

interface DataFlowRow {
  entryId: string;
  category: string;
  purposeId: string;
  purposeName: string;
  legalBasis: string;
  retentionPeriod: string;
  vendorId: string | null;
  vendorName: string | null;
}

const LEGAL_BASIS_LABELS: Record<string, string> = {
  consent: 'Consent',
  legitimate_use: 'Legitimate use',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
  other: 'Other',
};

/**
 * FR-INV-10: elements -> purposes -> recipients, as a filterable linked
 * table against the real /inventory/data-flows endpoint. A diagram was
 * judged not worth building for Stage 1 — a filterable table answers the
 * same compliance question ("who gets what, and why") without the fragility
 * of a rendered graph.
 */
export default function DataFlowsPage() {
  const [flows, setFlows] = useState<DataFlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<{ flows: DataFlowRow[] }>('/inventory/data-flows');
        setFlows(res.flows);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load data flows.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return flows;
    return flows.filter(
      (f) =>
        f.category.toLowerCase().includes(q) ||
        f.purposeName.toLowerCase().includes(q) ||
        (f.vendorName ?? '').toLowerCase().includes(q),
    );
  }, [flows, filter]);

  return (
    <div>
      <h1>Data flow</h1>
      <p className="muted">
        Elements → purposes → recipients. Every row is one data element flowing to one
        purpose and (if shared externally) one recipient — an element with several purposes or
        vendors appears in several rows.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by category, purpose, or vendor…"
          style={{ maxWidth: 360 }}
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Data element</th>
              <th>Purpose</th>
              <th>Legal basis</th>
              <th>Retention</th>
              <th>Recipient</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f) => (
              <tr key={`${f.entryId}-${f.purposeId}-${f.vendorId ?? 'none'}`}>
                <td>
                  <Link href={`/inventory/${f.entryId}`}>{f.category}</Link>
                </td>
                <td>{f.purposeName}</td>
                <td>
                  <span className="badge">{LEGAL_BASIS_LABELS[f.legalBasis] ?? f.legalBasis}</span>
                </td>
                <td>{f.retentionPeriod}</td>
                <td>
                  {f.vendorId ? (
                    <Link href={`/inventory/vendors/${f.vendorId}`}>{f.vendorName}</Link>
                  ) : (
                    <span className="muted">Internal use only</span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {flows.length === 0
                    ? 'No data flows yet — add a purpose to a data element to see it here.'
                    : 'No flows match this filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
