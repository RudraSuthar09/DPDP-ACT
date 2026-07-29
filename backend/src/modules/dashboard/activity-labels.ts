/**
 * Human-readable labels for audit action codes, for the dashboard's recent-
 * activity feed (FR-DSH-01). The full Audit Log viewer (FR-AUD-04) shows the
 * raw dotted action — that is deliberately technical, evidentiary text. This
 * feed is a glance, not a register, so it earns a sentence instead.
 *
 * Every `@Audited(...)` name in the codebase at the time of writing has an
 * entry here. A new action added later without an entry does not break
 * anything: describe() falls back to a readable derivation of the code itself
 * (see below), so the feed degrades gracefully rather than showing "undefined".
 */
const ACTION_LABELS: Record<string, string> = {
  'identity.organisation.registered': 'Organisation registered',
  'identity.auth.password_verified': 'Password verified at sign-in',
  'identity.mfa.enrolment_started': 'MFA enrolment started',
  'identity.mfa.enrolled': 'MFA enrolled',
  'identity.auth.session_issued': 'Signed in',
  'identity.invitation.accepted': 'Invitation accepted',
  'identity.user.status_changed': 'Team member status changed',
  'identity.user.role_changed': "Team member's role changed",
  'identity.user.reactivated': 'Team member reactivated',
  'identity.user.invited': 'Team member invited',
  'identity.invitation.revoked': 'Invitation revoked',
  'identity.designation.set': "Team member's designation set",

  'inventory.register.entry_created': 'Data element added to the register',
  'inventory.register.entry_updated': 'Data element edited',
  'inventory.register.entry_tombstoned': 'Data element removed from the register',
  'inventory.register.pii_decision': 'PII classification reviewed',
  'inventory.register.imported': 'Data elements imported from a file',
  'inventory.schema.discovered': 'Schema discovered',
  'inventory.entry_purpose.created': 'Processing purpose added',
  'inventory.entry_purpose.updated': 'Processing purpose edited',
  'inventory.entry_purpose.tombstoned': 'Processing purpose removed',
  'inventory.entry_system_link.created': 'Data element linked to a system',
  'inventory.entry_system_link.removed': 'Data element unlinked from a system',
  'inventory.entry_vendor_link.created': 'Data element linked to a vendor',
  'inventory.entry_vendor_link.removed': 'Data element unlinked from a vendor',
  'inventory.system.created': 'System added',
  'inventory.system.updated': 'System edited',
  'inventory.system.tombstoned': 'System removed',
  'inventory.vendor.created': 'Vendor added',
  'inventory.vendor.updated': 'Vendor edited',
  'inventory.vendor.tombstoned': 'Vendor removed',
  'inventory.sector_template.applied': 'Sector template applied',
  'inventory.ropa.exported': 'RoPA exported',

  'consent.purpose.created': 'Consent purpose defined',
  'consent.event.recorded': 'Consent recorded',
  'consent.event.withdrawn': 'Consent withdrawn',

  'breach.incident.opened': 'Breach incident opened',
  'breach.incident.closed': 'Breach incident closed',
  'grievance.ticket.opened': 'Grievance ticket opened',
  'dprequest.request.opened': 'Data principal request opened',
};

/**
 * A dotted action code → a sentence for the activity feed. Known codes get
 * their authored label; anything else is derived rather than dropped — split
 * on '.', drop the module prefix (the feed doesn't need "inventory." spelled
 * out), and turn the rest into "readable words".
 */
export function describeAction(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) {
    return known;
  }

  const parts = action.split('.').filter(Boolean);
  const words = (parts.length > 1 ? parts.slice(1) : parts).join(' ').replace(/_/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}
