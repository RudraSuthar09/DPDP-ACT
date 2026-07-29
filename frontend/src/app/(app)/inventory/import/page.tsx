'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { PiiConfidenceBadge } from '../../../../components/PiiConfidenceBadge';
import { LEGAL_BASIS_OPTIONS, type LegalBasis } from '../../../../components/PurposesPanel';

/**
 * CSV/Excel import (FR-INV-02) against the real /inventory/register/import
 * endpoints from Prompt 10. Three steps in one page — upload, map columns,
 * see the result — the same "one state machine, one step at a time" pattern
 * as the login flow and the guided-entry wizard.
 *
 * Each detected CSV COLUMN becomes one register entry (its "category"); the
 * purpose/storage location/retention period are entered ONCE and shared by
 * every entry the import creates, because they describe the file's table as
 * a whole, not each column individually — that is what the actual
 * /import/commit endpoint expects (confirmed against register-import.dto.ts
 * before writing this), not a per-column mapping to those three fields.
 */

const CSV_MAX_BYTES = 5 * 1024 * 1024; // matches the backend's CSV_MAX

interface PreviewColumn {
  name: string;
  suggestedCategory: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
}
interface MappingRow extends PreviewColumn {
  included: boolean;
  category: string;
  description: string;
}
interface CommitEntry {
  id: string;
  category: string;
  versionNumber: number;
}
interface CommitResult {
  evidence: { fileSha256: string; headerColumns: string[]; rowCountDeclared: number };
  entries: CommitEntry[];
}

type Step = 'upload' | 'mapping' | 'success';

function deriveTableName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim() || fileName;
}

export default function ImportInventoryPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Carried between steps.
  const [fileName, setFileName] = useState('');
  const [tableName, setTableName] = useState('');
  const [csvText, setCsvText] = useState('');

  // Mapping step state.
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [purpose, setPurpose] = useState('');
  const [legalBasis, setLegalBasis] = useState<LegalBasis>('consent');
  const [storageLocation, setStorageLocation] = useState('');
  const [retentionPeriod, setRetentionPeriod] = useState('');

  const [result, setResult] = useState<CommitResult | null>(null);

  function fail(err: unknown) {
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }

  async function loadFile(file: File) {
    setError(null);
    if (file.size > CSV_MAX_BYTES) {
      setError('That file is larger than 5 MB — split it or trim unused columns and try again.');
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setTableName(deriveTableName(file.name));
    setCsvText(text);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  }

  async function onParse(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ columns: PreviewColumn[] }>('/inventory/register/import/preview', {
        method: 'POST',
        body: { fileName, tableName, csvText },
      });
      setRows(
        res.columns.map((c) => ({
          ...c,
          included: true,
          category: c.suggestedCategory ?? '',
          description: '',
        })),
      );
      setStep('mapping');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function updateRow(name: string, patch: Partial<MappingRow>) {
    setRows((rs) => rs.map((r) => (r.name === name ? { ...r, ...patch } : r)));
  }

  const includedRows = rows.filter((r) => r.included);
  const unmapped = includedRows.filter((r) => r.category.trim().length === 0);
  const sharedFieldsMissing =
    purpose.trim().length === 0 || storageLocation.trim().length === 0 || retentionPeriod.trim().length === 0;
  const canCommit = includedRows.length > 0 && unmapped.length === 0 && !sharedFieldsMissing;

  async function onCommit() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<CommitResult>('/inventory/register/import/commit', {
        method: 'POST',
        body: {
          fileName,
          tableName,
          csvText,
          purpose: purpose.trim(),
          legalBasis,
          storageLocation: storageLocation.trim(),
          retentionPeriod: retentionPeriod.trim(),
          columns: includedRows.map((r) => ({
            name: r.name,
            category: r.category.trim(),
            ...(r.description.trim() ? { description: r.description.trim() } : {}),
          })),
        },
      });
      setResult(res);
      setStep('success');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep('upload');
    setFileName('');
    setTableName('');
    setCsvText('');
    setRows([]);
    setPurpose('');
    setLegalBasis('consent');
    setStorageLocation('');
    setRetentionPeriod('');
    setResult(null);
    setError(null);
  }

  return (
    <div>
      <h1>Import from CSV/Excel</h1>
      <p className="muted">
        Guided import for the Data Inventory register (FR-INV-02). Only column NAMES and the
        categories you confirm are ever stored — the file&apos;s row data is never read beyond its
        header (I1).
      </p>

      {error && <div className="error">{error}</div>}

      {step === 'upload' && (
        <form onSubmit={onParse} className="panel" style={{ maxWidth: 560, marginTop: 16 }}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8,
              padding: 28,
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? '#eaf0fb' : 'var(--bg)',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
            {fileName ? (
              <p style={{ margin: 0 }}>
                Selected: <strong>{fileName}</strong>
                <br />
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  Click or drop another file to replace it.
                </span>
              </p>
            ) : (
              <p style={{ margin: 0 }} className="muted">
                Drag a CSV file here, or click to choose one.
              </p>
            )}
          </div>

          <label>What is this data called? (e.g. a table or system name)</label>
          <input
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder="e.g. patients, customers"
            required
          />

          <div style={{ marginTop: 16 }}>
            <button className="primary" type="submit" disabled={busy || !csvText || !tableName.trim()}>
              {busy ? 'Reading header…' : 'Detect columns'}
            </button>
          </div>
        </form>
      )}

      {step === 'mapping' && (
        <div style={{ marginTop: 16 }}>
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Shared details</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Applied to every data element created from <strong>{fileName}</strong>.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
              <div>
                <label>Purpose (why it&apos;s collected)</label>
                <input value={purpose} onChange={(e) => setPurpose(e.target.value)} required />
              </div>
              <div>
                <label>Legal basis</label>
                <select value={legalBasis} onChange={(e) => setLegalBasis(e.target.value as LegalBasis)}>
                  {LEGAL_BASIS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Storage location (where it&apos;s stored)</label>
                <input
                  value={storageLocation}
                  onChange={(e) => setStorageLocation(e.target.value)}
                  required
                />
              </div>
              <div>
                <label>Retention period (how long it&apos;s retained)</label>
                <input
                  value={retentionPeriod}
                  onChange={(e) => setRetentionPeriod(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          <h2 style={{ marginTop: 24 }}>Map detected columns</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            One register entry is created per included column. A suggested category is a hint, not a
            verdict — confirm or change it. Uncheck a column to leave it out.
          </p>
          {unmapped.length > 0 && (
            <div className="error">
              {unmapped.length} included column{unmapped.length > 1 ? 's need' : ' needs'} a category
              before you can continue: {unmapped.map((r) => r.name).join(', ')}.
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Include</th>
                  <th>Detected column</th>
                  <th>Category</th>
                  <th>Description (optional)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const rowUnmapped = r.included && r.category.trim().length === 0;
                  return (
                    <tr key={r.name}>
                      <td>
                        <input
                          type="checkbox"
                          style={{ width: 'auto' }}
                          checked={r.included}
                          onChange={(e) => updateRow(r.name, { included: e.target.checked })}
                        />
                      </td>
                      <td className="mono">{r.name}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            value={r.category}
                            disabled={!r.included}
                            onChange={(e) => updateRow(r.name, { category: e.target.value })}
                            placeholder={r.suggestedCategory ?? 'e.g. aadhaar, phone, email'}
                          />
                          {r.included && r.confidence && <PiiConfidenceBadge confidence={r.confidence} />}
                        </div>
                        {rowUnmapped && (
                          <div className="error" style={{ marginTop: 4 }}>
                            Needs a category
                          </div>
                        )}
                      </td>
                      <td>
                        <input
                          value={r.description}
                          disabled={!r.included}
                          onChange={(e) => updateRow(r.name, { description: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, maxWidth: 560 }}>
            <button type="button" disabled={busy} onClick={() => setStep('upload')}>
              Back
            </button>
            <button className="primary" type="button" disabled={busy || !canCommit} onClick={() => void onCommit()}>
              {busy ? 'Creating…' : `Create ${includedRows.length || ''} data element${includedRows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {step === 'success' && result && (
        <div className="panel" style={{ maxWidth: 640, marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>
            {result.entries.length} data element{result.entries.length === 1 ? '' : 's'} created
          </h2>
          <ul style={{ paddingLeft: 20 }}>
            {result.entries.map((e) => (
              <li key={e.id}>
                <Link href={`/inventory/${e.id}`}>{e.category}</Link>{' '}
                <span className="muted">(version {e.versionNumber})</span>
              </li>
            ))}
          </ul>

          <div className="notice">
            A declaration record was retained as evidence of this import: {result.evidence.headerColumns.length}{' '}
            column name{result.evidence.headerColumns.length === 1 ? '' : 's'} and a row count (
            {result.evidence.rowCountDeclared}), fingerprinted for integrity —{' '}
            <span className="mono">{result.evidence.fileSha256.slice(0, 16)}…</span>. The file&apos;s row data
            itself is never stored, only this declaration.
          </div>

          <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
            <button className="primary" type="button" onClick={reset}>
              Import another file
            </button>
            <button type="button" onClick={() => router.push('/inventory')}>
              View the Data Inventory register
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
