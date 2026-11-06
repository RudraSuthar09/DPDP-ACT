'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TakeTheTourButton } from '../../../components/ProductTour';
import { ActivationPanel } from '../../../components/ActivationGate';
import { useAuth } from '../../../lib/auth';
import { useCapabilities } from '../../../lib/capabilities';
import { apiFetch } from '../../../lib/api';

/**
 * Settings index. Exists because the guided tour needed a permanent, findable
 * home for its re-launch control — "where do I turn that thing back on?" is the
 * question every dismissable walkthrough eventually gets asked. The Notifications
 * screen already lived under /settings/* without an index above it, so this also
 * stops that path from being a dead end.
 */
const TOUR_STATUS_TEXT: Record<string, string> = {
  pending: "You haven't been through the tour yet — it will open by itself next time you sign in.",
  completed: "You've been through the tour. Take it again whenever you like.",
  skipped: "You skipped the tour, so it won't open on its own again. It's still here if you want it.",
};

const PLAN_LABEL: Record<string, string> = { saas: 'SaaS', enterprise: 'Enterprise' };
const DEPLOYMENT_LABEL: Record<string, string> = { hosted: 'Hosted (by us)', client_server: 'Client server' };

interface ActiveInstallation {
  id: string;
  version: string;
  registeredAt: string;
  lastHeartbeatAt: string | null;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

export default function SettingsPage() {
  const { user } = useAuth();
  const { capabilities, refresh: refreshCapabilities } = useCapabilities();

  // undefined = not checked yet, null = checked and none active. Only the
  // roles that could ever activate one are worth checking for — same gate
  // InstallationController itself enforces, so this never fires a request
  // that would just 403.
  const [installation, setInstallation] = useState<ActiveInstallation | null | undefined>(undefined);
  const canManageInstallation = !!user && MANAGE_ROLES.has(user.role);

  useEffect(() => {
    if (!canManageInstallation) return;
    let cancelled = false;
    apiFetch<{ installation: ActiveInstallation | null }>('/installations/active')
      .then((data) => {
        if (!cancelled) setInstallation(data.installation);
      })
      .catch(() => {
        // Fail open to the activation form rather than get stuck showing
        // neither state on a transient error.
        if (!cancelled) setInstallation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canManageInstallation]);

  // Live once /capabilities resolves; falls back to the user profile's own
  // plan/deploymentType (same values, org-level default) while loading so
  // this panel never flashes empty — see lib/capabilities.ts.
  const plan = capabilities?.plan ?? user?.plan;
  const deploymentType = capabilities?.deploymentType ?? user?.deploymentType;

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted">Your workspace preferences.</p>

      {user && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Workspace</h2>
          <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
            Read-only details about this organisation on the platform.
          </p>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <div className="muted" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Organisation</div>
              <div>{user.organisationName}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Plan</div>
              <div>
                <span className="badge info">{plan ? (PLAN_LABEL[plan] ?? plan) : '—'}</span>
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Deployment</div>
              <div>
                <span className="badge neutral">{deploymentType ? (DEPLOYMENT_LABEL[deploymentType] ?? deploymentType) : '—'}</span>
              </div>
            </div>
          </div>
          {capabilities && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Capabilities</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {Object.entries(capabilities.features)
                  .filter(([, enabled]) => enabled)
                  .map(([key]) => (
                    <span key={key} className="badge neutral" style={{ fontSize: '0.75rem' }}>
                      {key}
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {canManageInstallation && installation && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>
            Installation &amp; licensing <span className="badge success" style={{ marginLeft: 8, verticalAlign: 'middle' }}>● Active</span>
          </h2>
          <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
            This deployment is activated — version {installation.version}, registered{' '}
            {new Date(installation.registeredAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.
            No license key is needed again unless you&apos;re switching to a different one.
          </p>
          <button type="button" onClick={() => setInstallation(null)}>
            Activate a different license key
          </button>
        </div>
      )}

      {canManageInstallation && installation === null && (
        <ActivationPanel
          onActivated={() => {
            refreshCapabilities();
            apiFetch<{ installation: ActiveInstallation | null }>('/installations/active')
              .then((data) => setInstallation(data.installation))
              .catch(() => {});
          }}
        />
      )}

      <div className="panel" style={{ marginTop: 16 }} data-tour="settings-tour-panel">
        <h2 style={{ marginTop: 0 }}>Guided tour</h2>
        <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
          A short walkthrough of the platform in plain language, using your own data as the example.
          It never changes anything — it just shows you around.
        </p>
        {user && (
          <p className="muted" style={{ fontSize: '0.85rem' }} data-testid="tour-status-text">
            {TOUR_STATUS_TEXT[user.productTourStatus] ?? ''}
          </p>
        )}
        <TakeTheTourButton className="primary" testId="settings-take-the-tour" />
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Notifications</h2>
        <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
          How email and SMS leave the platform, and which providers are configured.
        </p>
        <Link href="/settings/notifications">Notification channels</Link>
      </div>

      {canManageInstallation && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Gateway &amp; storage administration</h2>
          <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
            Connect or revoke the DPDP Gateway, add a data source by hand, and configure where collected data is
            written. Ordinary use needs none of this — connected folders appear under Sources &amp; Storage on their own.
          </p>
          <Link href="/storage">Gateway &amp; storage administration</Link>
        </div>
      )}
    </div>
  );
}
