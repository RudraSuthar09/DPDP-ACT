/**
 * The compliance dashboard (FR-DSH-01): counters read from each module's own
 * service (never a cross-module table read, R2) plus a recent-activity feed
 * read straight off the S5 audit log. Consent/Breach/Grievance/DPRequest are
 * genuinely at zero until a tenant records real activity there — Stage 1 does
 * not fake them (see CLAUDE.md's "never fabricate" stance on the other four
 * modules being "Coming in your pilot").
 */
export interface DashboardSummary {
  inventory: {
    /** Active data elements currently in the register. */
    elements: number;
    /** Distinct categories those elements fall into. */
    categories: number;
  };
  consent: {
    /** (subject, purpose) pairs whose latest event is GRANTED, across all subjects. */
    activeConsents: number;
  };
  breach: {
    /** workflow_jobs rows of kind='breach' still status='scheduled' (S3). */
    openIncidents: number;
  };
  grievance: {
    openTickets: number;
  };
  dprequest: {
    openRequests: number;
  };
}

/** One row of the dashboard's recent-activity feed — a trimmed, humanised
 *  view of an audit entry (see AuditEntry). Restricted the same way as the
 *  full audit log (owner/dpo/auditor): it still names an actor and an IP-
 *  adjacent outcome, just fewer fields of it. */
export interface DashboardActivityEntry {
  id: string;
  seq: number;
  occurredAt: string;
  actorLabel: string | null;
  action: string;
  /** A human-readable rendering of `action`, e.g. "Data element added to the register". */
  description: string;
  outcome: 'success' | 'denied' | 'error';
  targetType: string | null;
}
