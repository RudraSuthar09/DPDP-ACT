'use client';

import Link from 'next/link';
import { TakeTheTourButton } from '../../../components/ProductTour';
import { useAuth } from '../../../lib/auth';

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

export default function SettingsPage() {
  const { user } = useAuth();

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
                <span className="badge info">{PLAN_LABEL[user.plan] ?? user.plan}</span>
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Deployment</div>
              <div>
                <span className="badge neutral">{DEPLOYMENT_LABEL[user.deploymentType] ?? user.deploymentType}</span>
              </div>
            </div>
          </div>
        </div>
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
    </div>
  );
}
