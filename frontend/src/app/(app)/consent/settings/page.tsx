'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

/**
 * Settings surface for the FR-CON-07 webhook pipeline, against the real
 * Prompt 22/23 endpoints:
 *
 *   GET  /notify/webhooks/config          → current URL + enabled flag
 *   PUT  /notify/webhooks/config           → update them
 *   POST /notify/webhooks/secret/reveal    → the signing secret, in the clear
 *   GET  /notify/webhooks/deliveries       → recent delivery attempts
 *
 * There is no rotate endpoint: `tenant_webhook_secrets` has no UPDATE grant
 * for `dpdp_app` (same reasoning as every other per-tenant secret on this
 * platform), so the secret is created once, lazily, and only ever revealed —
 * this screen does not invent a rotate control the backend cannot honour.
 */
interface WebhookConfig {
  url: string | null;
  enabled: boolean;
  updatedAt: string | null;
}
interface WebhookDelivery {
  id: string;
  eventType: string;
  subjectRef: string;
  purposeId: string;
  url: string;
  status: 'pending' | 'success' | 'failed';
  attemptCount: number;
  lastResponseCode: number | null;
  lastError: string | null;
  createdAt: string;
  lastAttemptedAt: string | null;
  deliveredAt: string | null;
}

const WRITE_ROLES = new Set(['owner', 'dpo']);
const READ_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);
const DELIVERY_ROLES = new Set(['owner', 'dpo', 'compliance_officer', 'auditor']);

export default function WebhookSettingsPage() {
  const { user } = useAuth();
  const canWrite = !!user && WRITE_ROLES.has(user.role);
  const canReadConfig = !!user && READ_ROLES.has(user.role);
  const canReadDeliveries = !!user && DELIVERY_ROLES.has(user.role);

  const [config, setConfig] = useState<WebhookConfig | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [enabledInput, setEnabledInput] = useState(true);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (canReadConfig) {
        const cfg = await apiFetch<WebhookConfig>('/notify/webhooks/config');
        setConfig(cfg);
        setUrlInput(cfg.url ?? '');
        setEnabledInput(cfg.enabled);
      }
      if (canReadDeliveries) {
        const res = await apiFetch<{ deliveries: WebhookDelivery[] }>('/notify/webhooks/deliveries');
        setDeliveries(res.deliveries);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load webhook settings.');
    } finally {
      setLoading(false);
    }
  }, [canReadConfig, canReadDeliveries]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const cfg = await apiFetch<WebhookConfig>('/notify/webhooks/config', {
        method: 'PUT',
        body: { url: urlInput.trim() || null, enabled: enabledInput },
      });
      setConfig(cfg);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save the webhook config.');
    } finally {
      setSaving(false);
    }
  }

  async function onReveal() {
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await apiFetch<{ secret: string }>('/notify/webhooks/secret/reveal', {
        method: 'POST',
      });
      setSecret(res.secret);
    } catch (err) {
      setRevealError(err instanceof ApiError ? err.message : 'Could not reveal the signing secret.');
    } finally {
      setRevealing(false);
    }
  }

  if (!canReadConfig && !canReadDeliveries) {
    return (
      <div>
        <h1>Webhook settings</h1>
        <p className="muted">You do not have access to this page.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Webhook settings</h1>
      <p className="muted">
        Every consent grant or withdrawal sends a signed notification to your system. You can
        verify each one came from us using the secret below — a cryptographic signature computed
        over the message content.
      </p>

      {error && <div className="error">{error}</div>}

      {canReadConfig && (
        <form className="panel" onSubmit={onSave} style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Delivery endpoint</h2>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 320px' }}>
              <label htmlFor="webhook-url">Webhook URL</label>
              <input
                id="webhook-url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/webhooks/consent"
                disabled={!canWrite || loading}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={enabledInput}
                onChange={(e) => setEnabledInput(e.target.checked)}
                disabled={!canWrite || loading}
              />
              Enabled
            </label>
            {canWrite && (
              <button className="primary" type="submit" disabled={saving || loading}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 10 }}>
            Clearing the URL disables delivery — it becomes a silent no-op, same as never having
            configured one.
          </p>
          {config?.updatedAt && (
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Last updated {new Date(config.updatedAt).toLocaleString()}
            </p>
          )}
          {saveError && <div className="error">{saveError}</div>}
          {saved && !saveError && <div className="notice">Saved.</div>}

          {canWrite && (
            <div style={{ marginTop: 16 }}>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                Signing secret — shown once you reveal it, never stored in this page&apos;s state
                before that.
              </div>
              {secret ? (
                <div className="mono panel" style={{ marginTop: 8, wordBreak: 'break-all' }}>
                  {secret}
                </div>
              ) : (
                <button type="button" style={{ marginTop: 8 }} disabled={revealing} onClick={() => void onReveal()}>
                  {revealing ? 'Revealing…' : 'Reveal signing secret'}
                </button>
              )}
              {revealError && <div className="error">{revealError}</div>}
            </div>
          )}
        </form>
      )}

      {canReadDeliveries && (
        <>
          <h2 style={{ marginTop: 28 }}>Recent delivery attempts</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Response</th>
                  <th>Created</th>
                  <th>Last attempt</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.eventType}</td>
                    <td className="mono" title={d.subjectRef}>
                      {d.subjectRef.slice(0, 10)}…
                    </td>
                    <td>
                      <span className={`badge ${deliveryBadge(d.status)}`}>{d.status}</span>
                    </td>
                    <td>{d.attemptCount}</td>
                    <td>
                      {d.lastResponseCode ?? <span className="muted">—</span>}
                      {d.lastError && (
                        <div className="muted" style={{ fontSize: '0.78rem' }}>
                          {d.lastError}
                        </div>
                      )}
                    </td>
                    <td className="muted">{new Date(d.createdAt).toLocaleString()}</td>
                    <td className="muted">
                      {d.lastAttemptedAt ? new Date(d.lastAttemptedAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
                {deliveries.length === 0 && !loading && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      No webhook deliveries yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function deliveryBadge(status: WebhookDelivery['status']): string {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'denied';
  return 'neutral';
}
