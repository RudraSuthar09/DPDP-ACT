'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

/**
 * The compliance dashboard (FR-DSH-01): the landing page every role sees
 * after sign-in. Counters read GET /dashboard/summary — a real count for
 * Data Inventory, and honestly-zero counts for Consent/Breach/Grievance/DPR
 * until a tenant has real activity there (they are not faked, matching how
 * those modules are marked "Coming in your pilot" in the nav). The activity
 * feed reads GET /dashboard/activity, a humanised slice of the same S5 audit
 * log the Audit Log page reads in full.
 */
interface DashboardSummary {
  inventory: { elements: number; categories: number };
  consent: { activeConsents: number };
  breach: { openIncidents: number };
  grievance: { openTickets: number };
  dprequest: { openRequests: number };
}

interface ActivityEntry {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  description: string;
  outcome: 'success' | 'denied' | 'error';
}

// Matches DashboardController.activity's @Roles — kept in sync manually since
// this only decides whether the UI bothers to ask, not whether it is allowed to.
const ACTIVITY_ROLES = new Set(['owner', 'dpo', 'auditor']);

export default function DashboardPage() {
  const { user } = useAuth();

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loadingActivity, setLoadingActivity] = useState(true);

  const loadSummary = useCallback(async () => {
    setLoadingSummary(true);
    setSummaryError(null);
    try {
      setSummary(await apiFetch<DashboardSummary>('/dashboard/summary'));
    } catch (err) {
      setSummaryError(err instanceof ApiError ? err.message : 'Failed to load the dashboard.');
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const loadActivity = useCallback(async () => {
    if (!user || !ACTIVITY_ROLES.has(user.role)) {
      setLoadingActivity(false);
      return;
    }
    setLoadingActivity(true);
    setActivityError(null);
    try {
      const res = await apiFetch<{ entries: ActivityEntry[] }>('/dashboard/activity?limit=10');
      setActivity(res.entries);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActivityError('Your role cannot view recent activity (Owner, DPO, or Auditor only).');
      } else {
        setActivityError(err instanceof ApiError ? err.message : 'Failed to load recent activity.');
      }
    } finally {
      setLoadingActivity(false);
    }
  }, [user]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  return (
    <div>
      <h1>Dashboard</h1>
      <p className="muted">Where things stand across every module, at a glance.</p>

      {summaryError && <div className="error">{summaryError}</div>}

      <div className="stat-grid">
        <StatTile
          label="Categories mapped"
          value={summary?.inventory.categories}
          sub={summary ? `${summary.inventory.elements} data element${summary.inventory.elements === 1 ? '' : 's'}` : undefined}
          loading={loadingSummary}
          href="/inventory"
        />
        <StatTile
          label="Active consents"
          value={summary?.consent.activeConsents}
          loading={loadingSummary}
        />
        <StatTile
          label="Open breach incidents"
          value={summary?.breach.openIncidents}
          loading={loadingSummary}
        />
        <StatTile
          label="Open grievance tickets"
          value={summary?.grievance.openTickets}
          loading={loadingSummary}
        />
        <StatTile
          label="Open data-principal requests"
          value={summary?.dprequest.openRequests}
          loading={loadingSummary}
        />
      </div>

      <div className="panel">
        <h2>Recent activity</h2>
        {activityError && <div className="error">{activityError}</div>}
        {!activityError && loadingActivity && <p className="muted">Loading…</p>}
        {!activityError && !loadingActivity && (
          <ul className="activity-list">
            {(activity ?? []).map((e) => (
              <li key={e.id}>
                <span className="activity-main">
                  {e.description}
                  {e.outcome !== 'success' && (
                    <span className={`badge ${e.outcome}`} style={{ marginLeft: 8 }}>
                      {e.outcome}
                    </span>
                  )}
                  {e.actorLabel && <span className="muted"> — {e.actorLabel}</span>}
                </span>
                <span className="activity-when">{new Date(e.occurredAt).toLocaleString()}</span>
              </li>
            ))}
            {(activity ?? []).length === 0 && (
              <li className="muted" style={{ justifyContent: 'center' }}>
                No activity yet.
              </li>
            )}
          </ul>
        )}
      </div>

      <p className="muted" style={{ fontSize: '0.85rem', marginTop: 16 }}>
        Full history: <Link href="/audit">Audit Log</Link>
      </p>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  loading,
  href,
}: {
  label: string;
  value: number | undefined;
  sub?: string;
  loading: boolean;
  href?: string;
}) {
  const body = (
    <div className="stat-tile">
      <div className="stat-value">{loading ? '—' : (value ?? 0)}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} style={{ color: 'inherit' }}>{body}</Link> : body;
}
