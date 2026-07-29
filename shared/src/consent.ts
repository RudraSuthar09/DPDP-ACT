/** Consent status (§6, the consent event envelope). */
export type ConsentStatus = 'GRANTED' | 'WITHDRAWN' | 'EXPIRED';

/**
 * Where a consent event originated. `internal` is the platform's own action —
 * e.g. one-click withdrawal (FR-CON-06), a tenant operator acting on the
 * subject's behalf — never the client's own SDK or portal. Kept distinct so a
 * proof-of-consent certificate can honestly say who initiated the event.
 */
export type ConsentSource = 'web_sdk' | 'mobile_sdk' | 'api' | 'portal' | 'import' | 'internal';

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
  /**
   * Which exact notice text the person saw — critical for evidence (FR-CON-02).
   * A real `consent_notice_versions` id: the store enforces that it exists, is
   * this tenant's, and is a notice OF `purposeId`.
   */
  noticeVersionId: string;
  /** Valid-time: when it actually happened. */
  occurredAt: string;
  /** Transaction-time: when the platform learned about it. */
  recordedAt: string;
  source: ConsentSource;
  evidenceHash: string;
  /**
   * Whether `evidenceHash` is the client's own attestation over evidence they
   * hold, or the platform's canonical digest over the recorded envelope. One
   * field meaning two different things would be a defect in an evidence store.
   */
  evidenceHashOrigin: ConsentEvidenceHashOrigin;
  idempotencyKey: string;
}

export type ConsentEvidenceHashOrigin = 'client' | 'platform';

/** One stored consent event, read back. `subjectRef` is the HMAC'd reference —
 *  the raw customer id is not recoverable from it, or from anything here (I2). */
export interface ConsentEventRecord {
  id: string;
  subjectRef: string;
  purposeId: string;
  purposeName: string | null;
  status: ConsentStatus;
  noticeVersionId: string | null;
  /** Free-text notice reference from before FR-CON-02 notices existed. Frozen. */
  legacyNoticeVersionRef: string | null;
  occurredAt: string;
  recordedAt: string;
  source: ConsentSource;
  evidenceHash: string;
  evidenceHashOrigin: ConsentEvidenceHashOrigin;
}

/**
 * A bitemporal point-in-time answer (FR-CON-05): the subject's consent status
 * for one purpose, as it stood at a given valid-time, using only what the
 * platform knew by a given transaction-time.
 */
export interface ConsentStatusAsOf {
  purposeId: string;
  purposeName: string | null;
  status: ConsentStatus;
  noticeVersionId: string | null;
  occurredAt: string;
  recordedAt: string;
}
