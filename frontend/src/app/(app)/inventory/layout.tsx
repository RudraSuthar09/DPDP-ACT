'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RopaExportButton } from '../../../components/RopaExportButton';

const TABS = [
  { href: '/inventory', label: 'Register' },
  { href: '/inventory/systems', label: 'Systems & assets' },
  { href: '/inventory/vendors', label: 'Vendors & processors' },
  { href: '/inventory/data-flows', label: 'Data flow' },
  { href: '/inventory/templates', label: 'Sector templates' },
];

/**
 * Sub-nav for the Data Inventory module's several sub-areas (Prompt 14/15:
 * FR-INV-05/06/07/10/11). These are pages within the Data Inventory PRODUCT
 * module, not new top-level modules, so they live here rather than in
 * lib/nav.ts's MODULE_NAV.
 */
export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TABS.map((tab) => {
            const current =
              tab.href === '/inventory' ? pathname === '/inventory' : pathname.startsWith(tab.href);
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
        <RopaExportButton />
      </div>
      {children}
    </div>
  );
}
