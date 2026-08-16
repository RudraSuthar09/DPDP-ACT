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

// ===========================================================================
// Phase 3G-1 — Consent Form customer-data field CONFIGURATION (metadata only)
// ===========================================================================
//
// A form can now contain, alongside its existing consent-purpose rows, fields
// that are configured to eventually correspond to a column in the client's OWN
// connected data source. These types describe the CONFIGURATION only — a column
// NAME the client explicitly chose, never a submitted value. See the migration
// header (1737003300000) for the full invariant.

/**
 * Where a customer-data field's submitted response is configured to go:
 *   - 'consent_record'  — not a customer-data field at all (e.g. a T&C checkbox);
 *     recorded only in the existing Consent Register, exactly as today.
 *   - 'customer_field'  — mapped to an existing/new column in the connected source.
 *   - 'both'            — recorded in the Consent Register AND mapped to a column.
 */
export const CONSENT_FIELD_DESTINATIONS = ['consent_record', 'customer_field', 'both'] as const;
export type ConsentFieldDestination = (typeof CONSENT_FIELD_DESTINATIONS)[number];

/**
 * Form field types the builder offers. Purely a label/presentation concept —
 * choosing one never infers a database column or a meaning (I1/no-inference).
 *
 * `document_upload` and `signature` are real field types a client can add to a
 * form, but there is currently NO supported destination for their actual
 * VALUE anywhere in this platform — no central file/blob storage exists (by
 * design, I1/R6), and the Gateway's controlled write contract carries only
 * short string values, never binary. See CONSENT_FIELD_TYPES_WITHOUT_STORAGE:
 * the DTO layer enforces that these two types can only ever be configured
 * with `destination: 'consent_record'` (i.e. not persisted to a customer
 * column) until a future, separately-approved storage adapter exists — at
 * which point loosening this is a DTO change, not a migration.
 */
export const CONSENT_FORM_FIELD_TYPES = ['text', 'number', 'date', 'document_upload', 'signature', 'checkbox'] as const;
export type ConsentFormFieldType = (typeof CONSENT_FORM_FIELD_TYPES)[number];

/** Field types with no supported customer-column storage destination (yet). */
export const CONSENT_FIELD_TYPES_WITHOUT_STORAGE = ['document_upload', 'signature'] as const satisfies readonly ConsentFormFieldType[];

/** A form's customer-data field configuration — never a submitted value. */
export interface ConsentFormCustomerField {
  id: string;
  formId: string;
  label: string;
  fieldType: string;
  required: boolean;
  destination: ConsentFieldDestination;
  /** The EXISTING client column name, explicitly chosen. Null until confirmed. */
  mappedColumn: string | null;
  /** "Create new column" configuration — requested only, nothing created (3G-1). */
  newColumnName: string | null;
  newColumnType: string | null;
  displayOrder: number;
}

export interface SaveConsentFormCustomerFieldInput {
  label: string;
  fieldType: string;
  required: boolean;
  destination: ConsentFieldDestination;
  mappedColumn: string | null;
  newColumnName: string | null;
  newColumnType: string | null;
}
