/** Consent status (§6, the consent event envelope). */
export type ConsentStatus = 'GRANTED' | 'WITHDRAWN' | 'EXPIRED';

/** Where a consent event originated. */
export type ConsentSource = 'web_sdk' | 'mobile_sdk' | 'api' | 'portal' | 'import';

/**
 * The consent event envelope — the most important schema in the system (§6).
 * Bitemporal (two timestamps) and append-only: a withdrawal is a NEW event,
 * never an update (FR-CON-05). `subjectRef` is HMAC'd per-tenant and opaque to
 * the platform (I2). Written only through the EventSink seam (S2, R3).
 */
export interface ConsentEventEnvelope {
  tenantId: string;
  /** Per-tenant HMAC of the client's internal customer ID. Irreversible here (I2). */
  subjectRef: string;
  purposeId: string;
  status: ConsentStatus;
  /** Which exact notice text the person saw — critical for evidence (FR-CON-02). */
  noticeVersionId: string;
  /** Valid-time: when it actually happened. */
  occurredAt: string;
  /** Transaction-time: when the platform learned about it. */
  recordedAt: string;
  source: ConsentSource;
  evidenceHash: string;
  idempotencyKey: string;
}
