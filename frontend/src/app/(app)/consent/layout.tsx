'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/consent', label: 'Purposes & notices' },
  { href: '/consent/subjects', label: 'Subject lookup' },
  { href: '/consent/settings', label: 'Webhook settings' },
  { href: '/consent/integration', label: 'Integration' },
];

/**
 * Sub-nav for the Consent Register's two halves: the SETUP side (purposes and
 * the notice versions consent is collected against, FR-CON-01/02) and the
 * EVIDENCE side (one data principal's append-only consent history,
 * FR-CON-05/08). Same convention as the Data Inventory sub-nav — pages within
 * one product module, not new top-level modules, so they stay out of
 * lib/nav.ts's MODULE_NAV.
 */
export default function ConsentLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        {TABS.map((tab) => {
          const current =
            tab.href === '/consent'
              ? pathname === '/consent' || pathname.startsWith('/consent/purposes')
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`nav-item${current ? ' current' : ''}`}
              style={{ display: 'inline-flex' }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
