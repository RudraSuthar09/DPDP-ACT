import { DPR_RIGHT_TYPES, dprPolicyKey, type EscalationLadderStep } from '@dpdp/shared';

/**
 * The statutory deadline SEEDS — v1 of each rights type's policy record.
 *
 * Read the second sentence before reading the numbers: these are not the
 * deadlines. The deadlines are rows in `deadline_policy_versions`. This file
 * is what those rows are seeded FROM for a tenant the migration could not reach
 * (one registered after it ran), and nothing else consults it. No code path
 * anywhere computes a DPR deadline from these constants — `RequestSlaService`
 * reads the record, always, and if the record says v4 gave erasure 15 days then
 * erasure gets 15 days and this file is a historical curiosity.
 *
 * That distinction is the whole of "deadlines are data, not code" (FR-BRC-02).
 * A constant used as a seed is data with a starting value; a constant used as a
 * fallback in the arithmetic is a hardcoded timeline wearing a hat.
 *
 * ON THE NUMBERS, honestly: the DPDP Rules set the operative periods and were
 * not final when this was written. 30 days is the working figure for the
 * §11/§12/§14 rights. Withdrawal gets 7 — §6(4) requires withdrawal to be as
 * easy as giving consent and the consequences to follow within a reasonable
 * time, and a month of continued processing after someone has told you to stop
 * is not a reasonable time. Every one of these is a v1 counsel can supersede.
 */
const DAY = 24 * 60 * 60;

/** Mirrors `request-sla-policy.ts`'s STANDARD_LADDER, in PERCENTAGES — which is
 *  why the same three rungs work for a 7-day withdrawal and a 30-day access
 *  request without a second ladder definition existing anywhere. */
const STANDARD_LADDER: EscalationLadderStep[] = [
  { level: 1, atPercent: 50, rung: 'grievance_officer' },
  { level: 2, atPercent: 80, rung: 'dpo' },
  { level: 3, atPercent: 100, rung: 'escalation_contact' },
];

const SEED_DAYS: Record<(typeof DPR_RIGHT_TYPES)[number], { days: number; note: string }> = {
  access: { days: 30, note: 'DPDP §11 — response to a request for a summary of personal data.' },
  correction: { days: 30, note: 'DPDP §12 — correction, completion or updating of personal data.' },
  erasure: { days: 30, note: 'DPDP §12(3) — erasure, unless retention is required by law.' },
  nomination: { days: 30, note: 'DPDP §14 — giving effect to a nomination.' },
  portability: {
    days: 30,
    note: 'DPDP §11 — machine-readable copy of the personal data summary.',
  },
  withdraw_consent: {
    days: 7,
    note:
      'DPDP §6(4)-(6) — cessation of processing after withdrawal must follow within a ' +
      'reasonable time; 7 days, not 30.',
  },
};

/** The seed set, in the shape `RequestService.ensurePolicyVersions` takes. */
export function dprPolicySeeds(): {
  policyKey: string;
  slaSeconds: number;
  ladder: EscalationLadderStep[];
  note: string;
}[] {
  return DPR_RIGHT_TYPES.map((rightType) => ({
    policyKey: dprPolicyKey(rightType),
    slaSeconds: SEED_DAYS[rightType].days * DAY,
    ladder: STANDARD_LADDER.map((s) => ({ ...s })),
    note: SEED_DAYS[rightType].note,
  }));
}
