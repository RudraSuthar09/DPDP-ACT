'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '../../lib/auth';
import { MODULE_NAV, OVERVIEW_NAV, PLATFORM_NAV, type NavItem } from '../../lib/nav';
import { TakeTheTourButton, TourProvider } from '../../components/ProductTour';
import { ToastProvider } from '../../components/Toast';
import { NAV_ICONS } from '../../components/NavIcons';

/**
 * The authenticated, tenant-aware shell. Every page under (app) renders inside
 * it. It fails closed: no verified session → bounce to /login. The org name and
 * signed-in user come from the real GET /auth/me, so the header proves which
 * tenant context the token carries (Seam S1).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, connectionError, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // A connectionError means the API could not be REACHED — nothing about the
  // session itself was rejected. That is never a reason to sign someone out;
  // it is retried in the background (see AuthProvider), so only bounce to
  // /login once we're sure there is genuinely no valid session.
  useEffect(() => {
    if (!loading && !user && !connectionError) router.replace('/login');
  }, [loading, user, connectionError, router]);

  if (loading) return <p style={{ padding: 24 }} className="muted">Loading…</p>;
  if (!user && connectionError) {
    return (
      <p style={{ padding: 24 }} className="muted">
        Could not reach the server. Your session is still signed in — retrying automatically…
      </p>
    );
  }
  if (!user) return null; // redirecting

  function onSignOut() {
    signOut();
    router.replace('/login');
  }

  return (
    // The tour lives inside the authenticated shell, so it can only ever run
    // for a real signed-in user against their own real screens.
    <ToastProvider>
    <TourProvider>
      <div className="shell">
      <aside className="sidebar">
        <div className="brand">DPDP Platform</div>

        {OVERVIEW_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}

        <div className="nav-section">Modules</div>
        {MODULE_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}

        <div className="nav-section">Platform</div>
        {PLATFORM_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <strong>{user.organisationName}</strong>
          </div>
          <div className="who">
            {user.fullName} · {user.email} · <span className="mono">{user.role}</span>{' '}
            <TakeTheTourButton className="link-button" />
            <button className="link-button" style={{ marginLeft: 12 }} onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </header>
        {connectionError && (
          <div
            className="notice"
            style={{ margin: '0 24px', marginTop: 12, borderRadius: 6 }}
          >
            Lost the connection to the server — retrying in the background. You&apos;re still
            signed in; this will clear itself once the connection is back.
          </div>
        )}
        <div className="content">{children}</div>
      </div>
      </div>
    </TourProvider>
    </ToastProvider>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = NAV_ICONS[item.href];
  if (!item.active) {
    return (
      <span className="nav-item disabled" title={item.note}>
        <span className="nav-item-label">
          {Icon && <Icon />}
          {item.label}
        </span>
        {item.note && <span className="tag">{item.note}</span>}
      </span>
    );
  }
  const current = pathname === item.href;
  return (
    <Link href={item.href} className={`nav-item${current ? ' current' : ''}`}>
      <span className="nav-item-label">
        {Icon && <Icon />}
        {item.label}
      </span>
    </Link>
  );
}
