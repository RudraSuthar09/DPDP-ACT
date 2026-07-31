/**
 * Data Principal Request contracts (FR-DPR-01/02/03/06) — the sibling
 * `request.ts`'s header predicted: "DPRequest's own equivalent (rights type,
 * when it lands) belongs in a `dprequest.ts` sibling, never here."
 *
 * Everything below is meaningful only for a `request_type = 'dprequest'`
 * ticket. Nothing in `request.ts` learns that rights types exist.
 */

/**
 * The rights a Data Principal may exercise, as the intake form offers them.
 *
 * Five come straight from the Act — access (§11), correction and erasure
 * (§12), nomination (§14) — plus withdrawal of consent (§6(4)), which is a
 * right exercised THROUGH this tracker even though the withdrawal itself is
 * executed by the Consent module. Portability is offered as a form of the §11
 * right to a summary: the Act grants the summary, and a machine-readable copy
 * of it is how most fiduciaries will satisfy it, so it is a distinct intake
 * type with its own deadline rather than a footnote on `access`.
 */
export const DPR_RIGHT_TYPES = [
  'access',
  'correction',
  'erasure',
  'nomination',
  'portability',
  'withdraw_consent',
] as const;
export type DprRightType = (typeof DPR_RIGHT_TYPES)[number];

export const DPR_RIGHT_TYPE_LABELS: Record<DprRightType, string> = {
  access: 'Access — a summary of my personal data (§11)',
  correction: 'Correction — fix data that is wrong or incomplete (§12)',
  erasure: 'Erasure — delete my personal data (§12)',
  nomination: 'Nomination — name someone to act for me (§14)',
  portability: 'Portability — a machine-readable copy of my data (§11)',
  withdraw_consent: 'Withdraw consent — stop processing I previously agreed to (§6(4))',
};

/**
 * The key a rights type resolves to in `request_sla_policy_versions`.
 *
 * A single string, not a (type, subtype) pair, because the substrate's policy
 * lookup takes one opaque key and does not know what is encoded in it — which
 * is exactly what lets Breach add `breach:high_severity` later without the
 * substrate learning a third vocabulary.
 */
export function dprPolicyKey(rightType: DprRightType): string {
  return `dprequest:${rightType}`;
}

/** One versioned statutory-deadline record, as the API returns it. */
export interface DprDeadlinePolicy {
  rightType: DprRightType;
  policyKey: string;
  version: number;
  slaSeconds: number;
  slaDays: number;
  effectiveFrom: string;
  note: string | null;
  /** True when no versioned record exists and the substrate default applies. */
  isFallback: boolean;
}

/** The DPR-specific facts hung off a ticket, keyed by ticket id. */
export interface DprRequestDetails {
  rightType: DprRightType;
  /**
   * The HMAC'd subject reference, once a verifier has resolved one. The raw
   * customer id that produced it is never stored, never returned, and cannot
   * be recovered from this value (I2) — see SubjectRefHasher.
   */
  subjectRef: string | null;
  subjectRefResolvedAt: string | null;
  subjectRefMatchCount: number | null;
}
