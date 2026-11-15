'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AdminLoginForm } from '../../components/admin/AdminLoginForm';
import {
  clearPlatformAdminToken,
  getPlatformAdminToken,
  PLATFORM_ADMIN_SIGNED_OUT_EVENT,
} from '../../lib/platform-admin-api';

/**
 * The internal DPDP Admin portal shell (/admin/*). Deliberately OUTSIDE the
 * customer (app) shell: its own sign-in (a platform_admin credential that
 * belongs to no tenant), its own token (never mixed with a customer session),
 * its own navigation. Every page below it renders only once signed in, and
 * every API call it makes goes through PlatformAdminGuard on the backend —
 * this gate is UX, the guard is the security boundary.
 */
const NAV: { href: string; label: string }[] = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/licenses', label: 'Licence management' },
  { href: '/admin/audit', label: 'Audit' },
  { href: '/admin/admins', label: 'Admin users' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    setSignedIn(getPlatformAdminToken() !== null);
    const onSignedOut = () => setSignedIn(false);
    window.addEventListener(PLATFORM_ADMIN_SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(PLATFORM_ADMIN_SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  useEffect(() => {
    document.title = 'DPDP Admin';
  }, [pathname]);

  if (signedIn === null) return null;
  if (!signedIn) return <AdminLoginForm onSignedIn={() => setSignedIn(true)} />;

  function signOut() {
    clearPlatformAdminToken();
    setSignedIn(false);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">DPDP Admin</div>
        <div className="nav-section">Internal</div>
        {NAV.map((item) => {
          const current = item.href === '/admin' ? pathname === '/admin' : pathname?.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`nav-item${current ? ' current' : ''}`}>
              <span className="nav-item-label">{item.label}</span>
            </Link>
          );
        })}
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <strong>DPDP platform administration</strong>{' '}
            <span className="badge neutral" style={{ marginLeft: 8 }}>
              Internal
            </span>
          </div>
          <div className="who">
            <button className="link-button" onClick={signOut} data-testid="admin-sign-out">
              Sign out
            </button>
          </div>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
