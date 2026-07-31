/**
 * The two-tier Personal Data Summary (FR-DPR-04/05) and fulfilment (FR-DPR-07).
 *
 * THE TIER SPLIT IS THE PRODUCT'S CENTRAL CLAIM, EXPRESSED AS TWO TYPES.
 *
 * `PersonalDataSummary` (Tier 1) is everything the platform can answer BY
 * ITSELF: which categories of data the fiduciary holds, why, on what legal
 * basis, where, for how long, and what this person has consented to and asked
 * for. Every field is derived from metadata the platform already holds. Not one
 * of them is a customer value, and nothing in this interface is stored per
 * subject — it is assembled on read and thrown away.
 *
 * `FulfilmentOutcome` (Tier 2) is the platform admitting the limit of that:
 * actual values live in the client's systems, and the platform's entire role is
 * to ask for them over a signed channel and hand back what comes. Note what
 * that type does NOT contain in its persisted form — see `dpr_fulfilments`.
 */

/** How confident the platform is that a consent purpose and an inventory
 *  purpose describe the same processing. A SUGGESTION only — nothing reads a
 *  suggestion into a summary until a human has accepted it. */
export interface PurposeLinkSuggestion {
  consentPurposeId: string;
  consentPurposeName: string;
  inventoryPurposeId: string;
  inventoryPurposeName: string;
  entryCategory: string;
  /** 0..1. Name similarity only — the platform has no deeper signal, and
   *  pretending otherwise is what makes a fuzzy join dangerous. */
  confidence: number;
  reason: string;
}

export interface PurposeLink {
  id: string;
  consentPurposeId: string;
  consentPurposeName: string | null;
  inventoryPurposeId: string;
  inventoryPurposeName: string | null;
  entryCategory: string | null;
  origin: 'manual' | 'accepted_suggestion';
  suggestionConfidence: number | null;
  linkedAt: string;
}

/** One data category the fiduciary holds, attributed to this person through a
 *  purpose they consented to. */
export interface SummaryDataCategory {
  entryId: string;
  category: string;
  description: string | null;
  storageLocation: string;
  piiCategory: string | null;
  /** The inventory purposes on this entry that this subject's consent reaches —
   *  never every purpose on the entry, only the attributed ones. */
  purposes: {
    purposeName: string;
    legalBasis: string;
    legalBasisNote: string | null;
    retentionPeriod: string;
    /** Which consent purpose(s) attributed this entry to the subject. The
     *  audit trail of the claim, inline in the document that makes it. */
    viaConsentPurposes: string[];
  }[];
  systems: { name: string; systemType: string; hostingLocation: string | null }[];
  vendors: { name: string; country: string | null; transferNotes: string | null }[];
}

export interface SummaryConsentRecord {
  purposeId: string;
  purposeName: string | null;
  status: string;
  occurredAt: string;
  recordedAt: string;
  source: string;
  noticeVersionId: string | null;
  evidenceHash: string;
}

export interface SummaryRequestRecord {
  referenceCode: string;
  rightType: string | null;
  status: string;
  createdAt: string;
  closedAt: string | null;
  slaDueAt: string | null;
  /** Whether it was closed inside its statutory deadline. Null while open. */
  closedOnTime: boolean | null;
}

/**
 * Tier 1, in full. Assembled per request, stored nowhere.
 *
 * `unattributedConsentPurposes` is load-bearing and must never be quietly
 * dropped from a renderer: it lists purposes this person consented to for which
 * the tenant has not mapped any inventory. Hiding it would turn a gap in the
 * tenant's configuration into an implied "we hold nothing for that purpose",
 * which is a claim the platform has no basis to make.
 */
export interface PersonalDataSummary {
  subjectRef: string;
  referenceCode: string;
  rightType: string | null;
  generatedAt: string;
  organisationName: string;
  dataCategories: SummaryDataCategory[];
  consentHistory: SummaryConsentRecord[];
  currentConsentStatus: SummaryConsentRecord[];
  requestHistory: SummaryRequestRecord[];
  unattributedConsentPurposes: { purposeId: string; purposeName: string | null; status: string }[];
  /** Inventory the tenant holds that no consent of this subject reaches. A
   *  count, not a listing: the data principal is owed what relates to them, and
   *  the rest is the organisation's business, not a disclosure. */
  unrelatedEntryCount: number;
}

/** What a Tier 2 round trip produced, as the API returns it to the requester.
 *  `url` and `data` exist on the WIRE and in memory only — neither has a column. */
export interface FulfilmentOutcome {
  fulfilmentId: string;
  kind: 'data_values' | 'correction' | 'erasure' | 'portability';
  status: 'pending' | 'confirmed' | 'declined' | 'failed';
  responseKind: 'link' | 'relay' | 'confirmation' | null;
  confirmedAt: string | null;
  /** Link mode: the client-hosted address, passed straight through. Never stored. */
  url?: string;
  linkExpiresAt?: string | null;
  /** Relay mode: the client's bytes, passed straight through. Never stored. */
  data?: unknown;
  failureReason?: string | null;
}

/** The persisted half — what `GET .../fulfilments` can ever show. Compare it to
 *  `FulfilmentOutcome` above: no url, no data. That difference is the invariant. */
export interface FulfilmentRecord {
  id: string;
  kind: FulfilmentOutcome['kind'];
  status: FulfilmentOutcome['status'];
  responseKind: FulfilmentOutcome['responseKind'];
  requestSignature: string;
  requestPayloadSha256: string;
  deliveryUrlSha256: string | null;
  relayedBytes: number | null;
  requestedAt: string;
  confirmedAt: string | null;
  failureReason: string | null;
}
