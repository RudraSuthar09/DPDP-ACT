'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The primary Consent workflow — everything a client normally touches.
const PRIMARY = [
  { href: '/consent/forms', label: 'Forms' },
  { href: '/consent/subjects', label: 'History' },
  { href: '/consent/integration', label: 'Integration' },
];

// Advanced / occasional: the versioned purpose+notice data model still lives
// here (it underpins every consent event's proof), the consent↔inventory
// mapping review, and webhooks — but none of it is part of the everyday flow,
// so it is de-emphasised rather than removed.
const ADVANCED = [
  { href: '/consent', label: 'Purposes & notices', match: (p: string) => p === '/consent' || p.startsWith('/consent/purposes') },
  { href: '/consent/purpose-links', label: 'Inventory mapping' },
  { href: '/consent/settings', label: 'Webhooks (optional)' },
];

/**
 * Sub-nav for the Consent Register. The new UX model (single-screen form
 * builder + one tenant-wide embed) makes Forms / History / Integration the
 * whole everyday surface; the purpose/notice management, inventory mapping and
 * webhook screens move into a clearly-secondary "Advanced" row. Nothing was
 * deleted — the underlying versioned purpose+notice model is untouched, just
 * no longer something a user has to visit to build a form.
 */
export default function ConsentLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isCurrent = (href: string, match?: (p: string) => boolean) =>
    match ? match(pathname) : pathname === href || pathname.startsWith(href + '/') || pathname.startsWith(href);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {PRIMARY.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`nav-item${isCurrent(tab.href) ? ' current' : ''}`}
            style={{ display: 'inline-flex' }}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
          marginBottom: 20,
          paddingTop: 6,
          borderTop: '1px solid var(--border)',
        }}
      >
        <span className="muted" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 4 }}>
          Advanced
        </span>
        {ADVANCED.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`nav-item${isCurrent(tab.href, tab.match) ? ' current' : ''}`}
            style={{ display: 'inline-flex', fontSize: '0.85rem' }}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}
