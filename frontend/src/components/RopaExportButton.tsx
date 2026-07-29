'use client';

import { useState } from 'react';
import { ApiError, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';

type RopaFormat = 'pdf' | 'xlsx';

const EXPORT_ROLES = new Set(['owner', 'dpo', 'compliance_officer', 'auditor']);

/**
 * FR-INV-09 — the Record of Processing Activities export. One button, a
 * format choice, a real download from POST /inventory/ropa/export (fresh
 * from current data every time — nothing is cached). Shown wherever the
 * Data Inventory sub-nav renders, so it's reachable from any inventory page.
 */
export function RopaExportButton() {
  const { user } = useAuth();
  const [format, setFormat] = useState<RopaFormat>('pdf');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || !EXPORT_ROLES.has(user.role)) {
    return null;
  }

  async function onExport() {
    setBusy(true);
    setError(null);
    try {
      const orgSlug = (user!.organisationName || 'organisation').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
      const datePart = new Date().toISOString().slice(0, 10);
      await downloadFile(
        '/inventory/ropa/export',
        `RoPA-${orgSlug}-${datePart}.${format}`,
        { method: 'POST', body: { format } },
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate the RoPA export.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <select
        value={format}
        onChange={(e) => setFormat(e.target.value as RopaFormat)}
        style={{ width: 'auto' }}
        aria-label="RoPA export format"
      >
        <option value="pdf">PDF</option>
        <option value="xlsx">XLSX</option>
      </select>
      <button className="primary" type="button" disabled={busy} onClick={() => void onExport()}>
        {busy ? 'Generating…' : 'Export RoPA'}
      </button>
      {error && (
        <span className="error" style={{ padding: '4px 10px', fontSize: '0.85rem' }}>
          {error}
        </span>
      )}
    </div>
  );
}
