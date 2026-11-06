'use client';

/**
 * Storage -> "Gateway storage locations": the DPDP side of an Enterprise
 * write destination. Creating one makes a Gateway-provider storage root bound
 * to the tenant's active Gateway (the existing POST /storage/roots); its ID is
 * then entered on the Gateway computer in Gateway Setup -> Manage sources,
 * with "Write" or "Read and write", next to the real folder. Until the
 * Gateway administrator does that, nothing can be written there — DPDP
 * cannot grant itself write access to a customer folder.
 */
import { useCallback, useEffect, useState } from 'react';
import type { StorageRoot } from '@dpdp/shared';
import { apiFetch, ApiError } from '../lib/api';
import { gatewayStorageRoots } from '../lib/gateway-destinations';

export function GatewayStorageLocations({ canManage }: { canManage: boolean }) {
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [deviceId, setDeviceId] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([
        apiFetch<{ roots: StorageRoot[] }>('/storage/roots'),
        apiFetch<{ device: { id: string; status: string } | null }>('/gateway/devices/active').catch(() => ({ device: null })),
      ]);
      setRoots(gatewayStorageRoots(r.roots));
      setDeviceId(d.device && d.device.status === 'active' ? d.device.id : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load Gateway storage locations.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!deviceId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/storage/roots', { method: 'POST', body: { name: name.trim(), provider: 'gateway', gatewayDeviceId: deviceId } });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the storage location.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(id);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Gateway storage locations</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Folders inside your own network where DPDP may save <strong>copies</strong> of submitted consent-form fields.
        Central DPDP Storage is still always used. For each location, a Gateway administrator opens{' '}
        <strong>DPDP Gateway Setup → Manage sources</strong> on the Gateway computer, chooses the folder, picks{' '}
        <strong>Write</strong> (or Read and write), and pastes the storage location ID below. DPDP can only add new
        files there; it never changes or deletes existing ones.
      </p>
      {error && <div className="error">{error}</div>}
      {roots.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.85rem' }}>No Gateway storage locations yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Storage location ID (for Gateway Setup)</th>
              </tr>
            </thead>
            <tbody>
              {roots.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>
                    <span className="mono">{r.id}</span>{' '}
                    <button type="button" className="link-button" onClick={() => void copy(r.id)}>
                      {copied === r.id ? 'Copied' : 'Copy'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage &&
        (deviceId === null ? (
          <p className="muted" style={{ fontSize: '0.85rem' }}>Pair a DPDP Gateway first (Data Sources) to add a location.</p>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
            <div style={{ flex: '1 1 240px' }}>
              <label htmlFor="gw-loc-name">New location name</label>
              <input id="gw-loc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Head office consent copies" disabled={busy} />
            </div>
            <button className="primary" type="button" disabled={busy || deviceId === undefined || name.trim().length < 2} onClick={() => void create()}>
              {busy ? 'Adding…' : 'Add location'}
            </button>
          </div>
        ))}
    </div>
  );
}
