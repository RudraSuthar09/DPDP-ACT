'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError, API_URL } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

/**
 * FR-CON-09: the Integration page. Lets a tenant mint/revoke the public API
 * keys the Consent SDK's real endpoints (POST /consent/public/events, POST
 * /consent/public/withdraw) accept, and gives them a ready-to-paste embed
 * snippet against the actually-built SDK — the integrity hash and version
 * come from a live fetch of the SDK's own manifest.json, not a hand-copied
 * constant, so this page can never show a stale hash.
 *
 * "CDN-delivered" per FR-CON-09 is not literally true yet: the file below is
 * served by this API container's static-assets path (see backend/src/main.ts),
 * a Stage-1 stand-in until a real CDN is put in front of it in deployment.
 */
interface ApiKeySummary {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}
interface SdkManifest {
  version: string;
  file: string;
  integrity: string;
  sizeBytes: number;
}

const WRITE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

export default function IntegrationPage() {
  const { user } = useAuth();
  const canWrite = !!user && WRITE_ROLES.has(user.role);

  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [manifest, setManifest] = useState<SdkManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [labelInput, setLabelInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [keysRes, manifestRes] = await Promise.all([
        apiFetch<{ keys: ApiKeySummary[] }>('/consent/api-keys'),
        // Plain fetch, not apiFetch: this is an unauthenticated static asset
        // served alongside the SDK file itself, not a JSON API route.
        fetch(`${API_URL}/consent-sdk/v1/manifest.json`).then((res) =>
          res.ok ? (res.json() as Promise<SdkManifest>) : null,
        ),
      ]);
      setKeys(keysRes.keys);
      setManifest(manifestRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load integration settings.');
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
    setCreateError(null);
    setCopied(false);
    try {
      const res = await apiFetch<ApiKeySummary & { key: string }>('/consent/api-keys', {
        method: 'POST',
        body: { label: labelInput.trim() || 'Website integration' },
      });
      setNewKey(res.key);
      setLabelInput('');
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Could not create the API key.');
    } finally {
      setCreating(false);
    }
  }

  async function onCopy(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      // Clipboard permission denied/unavailable — the value is still selectable
      // text in the box below, so this is a convenience failure, not a blocker.
    }
  }

  async function onRevoke(id: string) {
    if (!window.confirm('Revoke this API key? Any site still using it will stop working immediately.')) {
      return;
    }
    setRevokingId(id);
    setRevokeError(null);
    try {
      await apiFetch(`/consent/api-keys/${id}/revoke`, { method: 'POST' });
      await load();
    } catch (err) {
      setRevokeError(err instanceof ApiError ? err.message : 'Could not revoke the API key.');
    } finally {
      setRevokingId(null);
    }
  }

  const snippet = manifest
    ? `<script src="${API_URL}/consent-sdk/v1/${manifest.file}"\n` +
      `        integrity="${manifest.integrity}"\n` +
      `        crossorigin="anonymous"></script>\n` +
      `<script>\n` +
      `  const consent = new DPDPConsent({ apiKey: "${newKey ?? 'YOUR_API_KEY'}" });\n` +
      `  // consent.grant({ customerId, purposeId, noticeVersionId });\n` +
      `  // consent.withdraw({ customerId, purposeId });\n` +
      `</script>`
    : null;

  return (
    <div>
      <h1>Integration</h1>
      <p className="muted">
        Embed the Consent SDK on your own website so visitors&apos; grants and withdrawals are
        recorded here directly, without your own backend touching this platform&apos;s API.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Tenant identifier</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          For your own reference — the SDK itself only needs the API key below, not this id.
        </p>
        <div className="mono panel" style={{ wordBreak: 'break-all' }}>{user?.tenantId ?? '—'}</div>
      </div>

      {canWrite && (
        <form className="panel" onSubmit={onCreate} style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>API keys</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            A key can only record and withdraw consent events — nothing else on this platform. It
            is shown once, right here, and never again: store it in your site&apos;s deploy config,
            not just this page.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <label htmlFor="key-label">Label</label>
              <input
                id="key-label"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="e.g. Marketing site checkout"
                disabled={creating}
              />
            </div>
            <button className="primary" type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create key'}
            </button>
          </div>
          {createError && <div className="error">{createError}</div>}

          {newKey && (
            <div style={{ marginTop: 16 }}>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                This is the only time this key is shown.
              </div>
              <div
                className="mono panel"
                style={{ marginTop: 8, wordBreak: 'break-all', display: 'flex', gap: 10, alignItems: 'center' }}
              >
                <span style={{ flex: 1 }}>{newKey}</span>
                <button type="button" onClick={() => void onCopy(newKey)}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Existing keys</h2>
        {revokeError && <div className="error">{revokeError}</div>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Prefix</th>
                <th>Created</th>
                <th>Status</th>
                {canWrite && <th></th>}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td className="mono">{k.keyPrefix}…</td>
                  <td className="muted">{new Date(k.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`badge ${k.revokedAt ? 'denied' : 'success'}`}>
                      {k.revokedAt ? 'Revoked' : 'Active'}
                    </span>
                  </td>
                  {canWrite && (
                    <td>
                      {!k.revokedAt && (
                        <button
                          type="button"
                          disabled={revokingId === k.id}
                          onClick={() => void onRevoke(k.id)}
                        >
                          {revokingId === k.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {keys.length === 0 && !loading && (
                <tr>
                  <td colSpan={canWrite ? 5 : 4} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    No API keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Embed snippet</h2>
        {!manifest && !loading && (
          <div className="muted">
            The SDK isn&apos;t currently being served by the API — build and deploy it first.
          </div>
        )}
        {manifest && (
          <>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              SDK v{manifest.version}, {manifest.sizeBytes} bytes. The integrity hash below is read
              live from the built file, so it can never drift out of date with what this snippet
              actually loads.
            </p>
            <pre className="mono panel" style={{ overflowX: 'auto', whiteSpace: 'pre' }}>
              {snippet}
            </pre>
            {!newKey && (
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                Replace <code>YOUR_API_KEY</code> with a key from above — create one to have it
                filled in here automatically.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
