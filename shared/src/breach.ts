/**
 * Breach Register contracts (FR-BRC-01…07).
 *
 * An incident is NOT a request ticket — no portal, no OTP, no contact channel.
 * It is opened from inside by the Data Fiduciary's own staff, and it runs
 * several statutory clocks at once rather than one SLA with a warning ladder.
 * That is why it has its own vocabulary here rather than reusing `request.ts`.
 *
 * What it DOES share is the deadline mechanism: the same versioned
 * `deadline_policy_versions` records, the same percentage-based escalation
 * ladder, the same WorkflowRunner (S3). Deadlines are data, not code
 * (FR-BRC-02) — nothing in this file is a statutory number.
 */

/**
 * The gated workflow, in order (FR-BRC-03). Order is meaningful: a gate may
 * only be passed once every gate before it has been, so the array index IS the
 * precedence rule and there is no second copy of it to drift.
 *
 * `notify_data_principals` before `notify_board` is deliberate but not a legal
 * ordering — §8(6) requires both and does not rank them. It reflects the
 * practical sequence (you tell the people affected, then file the report that
 * says you told them) and both carry the same 72-hour deadline from discovery,
 * running concurrently. Passing them in the other order is a UI question, not
 * a compliance one.
 */
export const BREACH_GATES = [
  'acknowledge',
  'assess',
  'notify_data_principals',
  'notify_board',
  'remediate',
  'rca',
  'closure',
] as const;
export type BreachGate = (typeof BREACH_GATES)[number];

export const BREACH_GATE_LABELS: Record<BreachGate, string> = {
  acknowledge: 'Acknowledge',
  assess: 'Assess scope and severity',
  notify_data_principals: 'Notify Data Principals',
  notify_board: 'Notify the Data Protection Board',
  remediate: 'Remediate',
  rca: 'Root-cause analysis',
  closure: 'Closure and sign-off',
};

export const BREACH_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type BreachSeverity = (typeof BREACH_SEVERITIES)[number];

/** The key a gate's deadline resolves to in `deadline_policy_versions`. Same
 *  opaque-string convention DPR uses (`dprequest:<rightType>`) — the resolver
 *  never interprets what is inside it. */
export function breachPolicyKey(gate: BreachGate): string {
  return `breach:${gate}`;
}

/** One versioned deadline record, as the API returns it. */
export interface BreachDeadlinePolicy {
  gate: BreachGate;
  policyKey: string;
  version: number;
  slaSeconds: number;
  slaHours: number;
  effectiveFrom: string;
  note: string | null;
  isFallback: boolean;
}

/** A data category an incident touched — a REFERENCE into the Data Inventory,
 *  carrying the entry's own current facts rather than a copy of them. */
export interface BreachDataCategory {
  entryId: string;
  category: string;
  storageLocation: string;
  purposes: { purposeName: string; legalBasis: string; retentionPeriod: string }[];
}

export interface BreachGateEvent {
  gate: BreachGate;
  notes: string;
  completedBy: string | null;
  completedAt: string;
}

/** A gate's live clock: when it is due, and whether it has been passed. */
export interface BreachGateStatus {
  gate: BreachGate;
  dueAt: string | null;
  policyKey: string;
  policyVersion: number | null;
  completedAt: string | null;
  /** Null while the gate is still open and its deadline has not passed. */
  completedOnTime: boolean | null;
  overdue: boolean;
  escalationLevel: number;
}

export interface BreachEvidence {
  id: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  /** SHA-256 of the submitted bytes. The bytes themselves are never stored (I1). */
  sha256: string;
  description: string | null;
  uploadedAt: string;
}

export interface BreachIncident {
  id: string;
  referenceCode: string;
  title: string;
  whatHappened: string;
  discoveredAt: string;
  occurredAt: string | null;
  systemsAffected: string[];
  estimatedAffectedCount: number | null;
  severity: BreachSeverity;
  currentGate: BreachGate;
  status: 'open' | 'closed';
  closedAt: string | null;
  closureNote: string | null;
  createdAt: string;
}

export interface BreachIncidentDetail {
  incident: BreachIncident;
  dataCategories: BreachDataCategory[];
  gateEvents: BreachGateEvent[];
  gateStatuses: BreachGateStatus[];
  evidence: BreachEvidence[];
  escalations: {
    gate: string;
    level: number;
    rung: string;
    trigger: string;
    notifiedContact: string | null;
    notifiedOk: boolean | null;
    reason: string;
    occurredAt: string;
  }[];
}

/** The two notification templates (FR-BRC-06), generated from the incident's
 *  real data. Text only — the platform holds no recipient list to send them to;
 *  addressing them is the client's job, from the client's own records (I1). */
export type BreachTemplateKind = 'data_principal_notice' | 'regulator_report';

export interface BreachTemplate {
  kind: BreachTemplateKind;
  title: string;
  body: string;
  /** What the tenant still has to fill in — stated rather than silently blank. */
  gaps: string[];
}
