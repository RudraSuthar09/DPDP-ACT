/**
 * The left-nav model. The five product modules plus the cross-cutting Audit Log.
 *
 * `active: false` items are shown but not linked — marked "Coming in your pilot".
 * They are NOT faked with dummy data (that would misrepresent what exists); they
 * are honestly labelled as not-yet-built. Data Inventory, Consent Register
 * (purpose + notice setup, and the per-subject consent timeline), Team,
 * Dashboard, and the Audit Log are live in this shell.
 */
export interface NavItem {
  href: string;
  label: string;
  active: boolean;
  /** Note shown next to inactive items. */
  note?: string;
}

export const OVERVIEW_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', active: true },
];

export const MODULE_NAV: NavItem[] = [
  { href: '/inventory', label: 'Data Inventory', active: true },
  { href: '/consent', label: 'Consent Register', active: true },
  { href: '/grievance', label: 'Grievance Register', active: false, note: 'Coming in your pilot' },
  { href: '/dprequest', label: 'Data Principal Requests', active: false, note: 'Coming in your pilot' },
  { href: '/breach', label: 'Breach Register', active: false, note: 'Coming in your pilot' },
];

export const PLATFORM_NAV: NavItem[] = [
  { href: '/team', label: 'Team', active: true },
  { href: '/audit', label: 'Audit Log', active: true },
];
