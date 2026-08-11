/**
 * Inline stroke icons for the left nav, one per destination. currentColor so
 * each inherits .nav-item's own color (normal / .current / .disabled) — no
 * separate icon-color rule needed. Presentational only: aria-hidden, the
 * link's own text label is what a screen reader announces.
 */
const BASE = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'nav-icon',
  'aria-hidden': true,
};

export function DashboardIcon() {
  return (
    <svg {...BASE}>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13" y="3.5" width="7.5" height="4.5" rx="1.5" />
      <rect x="13" y="10.5" width="7.5" height="10" rx="1.5" />
      <rect x="3.5" y="13.5" width="7.5" height="7" rx="1.5" />
    </svg>
  );
}

export function InventoryIcon() {
  return (
    <svg {...BASE}>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" />
      <path d="M4.5 5.5v6.5c0 1.38 3.36 2.5 7.5 2.5s7.5-1.12 7.5-2.5V5.5" />
      <path d="M4.5 12v6.5c0 1.38 3.36 2.5 7.5 2.5s7.5-1.12 7.5-2.5V12" />
    </svg>
  );
}

export function ConsentIcon() {
  return (
    <svg {...BASE}>
      <path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-2.5z" />
      <path d="M9 12l2 2 4-4.5" />
    </svg>
  );
}

export function GrievanceIcon() {
  return (
    <svg {...BASE}>
      <path d="M4 5.5h16v10.5H9.5L5.5 19v-3H4z" />
      <path d="M12 8.5v3.5" />
      <circle cx="12" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DprIcon() {
  return (
    <svg {...BASE}>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M4 19c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16.5 9.5l1.5 1.5 3-3" />
    </svg>
  );
}

export function BreachIcon() {
  return (
    <svg {...BASE}>
      <path d="M12 3.5l9.3 16H2.7L12 3.5z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TeamIcon() {
  return (
    <svg {...BASE}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5" />
      <circle cx="17" cy="8.5" r="2.4" />
      <path d="M15.5 13.3c2.6.3 4.5 2.5 4.5 5.2" />
    </svg>
  );
}

export function AuditIcon() {
  return (
    <svg {...BASE}>
      <path d="M6 3.5h12v17H6z" />
      <path d="M9 8h6M9 12h6M9 16h3.5" />
    </svg>
  );
}

export function NotificationsIcon() {
  return (
    <svg {...BASE}>
      <path d="M12 3.5c-2.5 0-4.5 2-4.5 4.5v3.2c0 .8-.3 1.6-.9 2.2l-1 1c-.5.5-.2 1.4.6 1.4h11.6c.8 0 1.1-.9.6-1.4l-1-1c-.6-.6-.9-1.4-.9-2.2V8c0-2.5-2-4.5-4.5-4.5z" />
      <path d="M10 19a2 2 0 004 0" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg {...BASE}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7L16 16M8 8L6.3 6.3" />
    </svg>
  );
}

/** href → icon, keyed exactly as lib/nav.ts's NavItem.href values. */
export const NAV_ICONS: Record<string, () => React.JSX.Element> = {
  '/dashboard': DashboardIcon,
  '/inventory': InventoryIcon,
  '/consent/forms': ConsentIcon,
  '/grievance': GrievanceIcon,
  '/dprequest': DprIcon,
  '/breach': BreachIcon,
  '/team': TeamIcon,
  '/audit': AuditIcon,
  '/settings/notifications': NotificationsIcon,
  '/settings': SettingsIcon,
};
