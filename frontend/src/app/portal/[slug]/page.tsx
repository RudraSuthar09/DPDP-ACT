import { notFound } from 'next/navigation';
import { portalFetchServer } from '../../../lib/portal-api';
import { PortalIntake } from './PortalIntake';

/**
 * The public request portal (FR-GRV-01/03) — no login, reachable by anyone
 * with the link. A SERVER component on purpose: the branding and the first
 * paint of the form come back in the initial HTML, with no round trip to the
 * API from the browser first. That matters most exactly here, because this is
 * the one screen in the platform used by people on the worst networks — a
 * complainant on a low-end phone, not a logged-in admin on an office
 * connection.
 *
 * The org lookup doubles as the tenant-existence check: a slug that resolves
 * to nothing (`portalFetchServer` returns null on a 404 from
 * `app.resolve_portal_slug`) calls Next's `notFound()` here, server-side —
 * the visitor gets a real 404 response and the app's own not-found.tsx, never
 * a client-side error screen flashing after the JS loads.
 */
interface OrganisationInfo {
  slug: string;
  organisationName: string;
}

export default async function PortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await portalFetchServer<OrganisationInfo>(`/portal/${encodeURIComponent(slug)}`);
  if (!org) notFound();

  return (
    <div className="portal-wrap">
      <div className="portal-card">
        <div className="portal-kicker">Submit a request to</div>
        <h1>{org.organisationName}</h1>
        <p className="muted">
          No account needed. We&apos;ll send a one-time code to confirm you own the contact
          details you give us, then the organisation will confirm your identity against their own
          records before responding.
        </p>
        <PortalIntake slug={org.slug} />
      </div>
    </div>
  );
}
