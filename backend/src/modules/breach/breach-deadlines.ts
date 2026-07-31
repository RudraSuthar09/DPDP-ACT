import { createHash } from 'node:crypto';
import { BREACH_GATES, breachPolicyKey, type BreachGate, type EscalationLadderStep } from '@dpdp/shared';

/**
 * The workflow id for one rung of one gate's ladder.
 *
 * Derived, not stored-and-looked-up, for the same reason
 * `deadlineWorkflowId` in the request substrate is: the S3 deadline register
 * holds at most one live deadline per (tenant, workflow id, kind), so N rungs
 * across M gates need N×M distinct ids — and deriving them from
 * (incidentId, gate, level) means the incident can always name its own
 * deadlines, above all to CANCEL them when a gate is passed on time, with no
 * mapping table that could drift out of step with what was actually scheduled.
 *
 * Shaped as a v4-looking UUID (version and variant bits set) because the
 * register's `workflow_id` column is a uuid. The value carries no meaning
 * beyond being a stable function of its inputs.
 */
export function breachDeadlineWorkflowId(
  incidentId: string,
  gate: BreachGate,
  level: number,
): string {
  const digest = createHash('sha256').update(`${incidentId}:breach:${gate}:${level}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The statutory deadline SEEDS — v1 of each gate's policy record.
 *
 * Read the second sentence before the numbers: these are NOT the deadlines. The
 * deadlines are rows in `deadline_policy_versions`. This file is what those rows
 * are seeded FROM for a tenant the migration could not reach (one registered
 * after it ran), and nothing else consults it. No code path anywhere computes a
 * breach deadline from these constants — `BreachDeadlineService` reads the
 * record, always. If a tenant's v3 gives Board notification 24 hours, they get
 * 24 hours and this file is a historical curiosity.
 *
 * That distinction is the whole of FR-BRC-02, and it is easy to lose: a
 * constant used as a SEED is data with a starting value; a constant used as a
 * fallback inside the arithmetic is a hardcoded statutory timeline wearing a
 * hat. The only fallback here is `FALLBACK_LADDER`'s SHAPE, which carries no
 * duration at all — the durations below are never used except to create a row.
 *
 * ON THE NUMBERS, honestly: DPDP §8(6) requires the Data Fiduciary to inform
 * both the Board and each affected Data Principal of a personal data breach,
 * and the Rules set the operative form and period. 72 hours is the working
 * figure for both. Everything else is the organisation's own discipline, not a
 * statute — acknowledge and assess exist to make the 72-hour clock survivable,
 * and remediate/RCA/closure are internal service levels. All are v1, all
 * overridable by counsel, none of them hardcoded in any decision.
 */
const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The ladder SHAPE, in percentages — warn the Grievance Officer at the halfway
 * mark, the DPO at 80%, the escalation contact at the deadline itself. Because
 * it is proportional, the same three rungs work unchanged for a 6-hour
 * acknowledgement and a 45-day closure, which is what lets one ladder
 * definition serve every gate.
 */
export const FALLBACK_LADDER: EscalationLadderStep[] = [
  { level: 1, atPercent: 50, rung: 'grievance_officer' },
  { level: 2, atPercent: 80, rung: 'dpo' },
  { level: 3, atPercent: 100, rung: 'escalation_contact' },
];

const SEED_SECONDS: Record<(typeof BREACH_GATES)[number], { secs: number; note: string }> = {
  acknowledge: {
    secs: 6 * HOUR,
    note: 'Internal: an incident must be owned within 6 hours of discovery. Not statutory — this is what makes the 72-hour clock survivable.',
  },
  assess: {
    secs: 24 * HOUR,
    note: 'Internal: scope, categories and severity assessed within 24 hours, so the notification decision rests on findings rather than guesswork.',
  },
  notify_data_principals: {
    secs: 72 * HOUR,
    note: 'DPDP §8(6) — each affected Data Principal must be informed of a personal data breach. 72 hours from discovery.',
  },
  notify_board: {
    secs: 72 * HOUR,
    note: 'DPDP §8(6) — the Data Protection Board must be notified of a personal data breach. 72 hours from discovery.',
  },
  remediate: {
    secs: 30 * DAY,
    note: 'Internal: containment and remediation completed within 30 days of discovery.',
  },
  rca: {
    secs: 30 * DAY,
    note: 'Internal: root-cause analysis documented within 30 days of discovery.',
  },
  closure: {
    secs: 45 * DAY,
    note: 'Internal: incident signed off and closed within 45 days of discovery.',
  },
};

export const BREACH_POLICY_SEEDS = BREACH_GATES.map((gate) => ({
  policyKey: breachPolicyKey(gate),
  slaSeconds: SEED_SECONDS[gate].secs,
  ladder: FALLBACK_LADDER.map((s) => ({ ...s })),
  note: SEED_SECONDS[gate].note,
}));
