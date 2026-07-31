'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

/**
 * Notification channel status — against the real `/notify/channels/status`
 * endpoint (this prompt). Read-only: which provider each channel WOULD use
 * right now, and the last several real delivery attempts on it.
 *
 * There is deliberately no form here to type in a Postmark/MSG91 key. Those
 * credentials are environment variables (`POSTMARK_API_KEY`,
 * `MSG91_AUTH_KEY`, …) — infrastructure secrets set at deploy time, not
 * per-tenant application settings a browser session should ever hold or
 * transmit. This screen answers "is it configured", never "let me configure
 * it".
 */
interface RecentDelivery {
  id: string;
  kind: string;
  provider: string;
  toMasked: string;
  delivered: boolean;
  error: string | null;
  occurredAt: string;
}

interface ChannelStatus {
  channel: 'email' | 'sms';
  configured: boolean;
  provider: string;
  fallback: string | null;
  recentDeliveries: RecentDelivery[];
}

const READ_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

const PROVIDER_LABELS: Record<string, string> = {
  postmark: 'Postmark',
  msg91: 'MSG91',
  console: 'Console (dev/CI log)',
  http: 'Generic HTTP relay',
};

export default function NotificationChannelsPage() {
  const { user } = useAuth();
  const canRead = !!user && READ_ROLES.has(user.role);

  const [channels, setChannels] = useState<ChannelStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ channels: ChannelStatus[] }>('/notify/channels/status');
      setChannels(res.channels);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load notification channel status.');
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canRead) {
    return (
      <div>
        <h1>Notifications</h1>
        <p className="muted">You do not have access to this page.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Notifications</h1>
      <p className="muted">
        Which real provider each channel is actually using right now, and its most recent delivery
        attempts. A channel with no real provider configured falls back to the console/dev-CI
        transport rather than failing silently — that fallback is itself reported below, never
        hidden.
      </p>

      <div className="toolbar">
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading &&
        channels?.map((c) => (
          <div className="panel" key={c.channel} style={{ marginTop: 16 }} data-testid={`channel-${c.channel}`}>
            <h2 style={{ marginTop: 0, textTransform: 'capitalize' }}>{c.channel}</h2>
            <p>
              {c.configured ? (
                <span className="badge success" data-testid={`channel-${c.channel}-status`}>
                  Configured — {PROVIDER_LABELS[c.provider] ?? c.provider}
                </span>
              ) : (
                <span className="badge warning" data-testid={`channel-${c.channel}-status`}>
                  Not configured — falling back to {PROVIDER_LABELS[c.fallback ?? ''] ?? c.fallback}
                </span>
              )}
            </p>
            {!c.configured && (
              <p className="muted" style={{ fontSize: '0.85rem' }}>
                Set the {c.channel === 'email' ? 'POSTMARK_API_KEY and POSTMARK_FROM_EMAIL' : 'MSG91_AUTH_KEY and MSG91_SENDER_ID'}{' '}
                environment variables to enable real delivery on this channel.
              </p>
            )}

            <h3 style={{ fontSize: '0.95rem' }}>Recent deliveries</h3>
            {c.recentDeliveries.length === 0 ? (
              <p className="muted" data-testid={`channel-${c.channel}-empty`}>
                No delivery attempts recorded yet on this channel.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Kind</th>
                      <th>Provider</th>
                      <th>To</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody data-testid={`channel-${c.channel}-deliveries`}>
                    {c.recentDeliveries.map((d) => (
                      <tr key={d.id}>
                        <td>{new Date(d.occurredAt).toLocaleString()}</td>
                        <td>{d.kind}</td>
                        <td>{PROVIDER_LABELS[d.provider] ?? d.provider}</td>
                        <td>{d.toMasked}</td>
                        <td>
                          <span className={`badge ${d.delivered ? 'success' : 'denied'}`}>
                            {d.delivered ? 'Delivered' : 'Failed'}
                          </span>
                          {d.error && <div className="muted" style={{ fontSize: '0.78rem' }}>{d.error}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
