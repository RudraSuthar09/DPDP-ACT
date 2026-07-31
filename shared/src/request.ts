/**
 * The SHARED REQUEST SUBSTRATE contracts (FR-GRV-01/03/04/05, Seam S3).
 *
 * One vocabulary, two callers. The Grievance Register (complaints, §13) and the
 * Data Principal Request Tracker (rights requests, §§11-14) are the same
 * machine — public intake, contact-channel proof, an identity-verification
 * handoff, a ticket with an append-only trail, and an SLA clock — differing only
 * in what the request is ABOUT. Nothing in this file knows what a grievance is.
 *
 * If you are tempted to add `complaintCategory` or `rightsType` here, that is
 * the signal you are in the wrong file: those belong to the module that owns
 * them, keyed by ticket id.
 */

/**
 * Which module a ticket belongs to. Deliberately the same two strings as the S3
 * `WorkflowKind` values for grievance and dprequest, so a ticket's deadlines are
 * scheduled under its own kind with no translation table in between.
 */
export const REQUEST_TYPES = ['grievance', 'dprequest'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/**
 * Which module a versioned deadline record belongs to (`deadline_policy_versions`).
 *
 * A superset of RequestType, and deliberately a SEPARATE type: a breach
 * incident has deadlines but is not a request, and collapsing the two would put
 * 'breach' into every signature that means "a portal-filed ticket". The two
 * overlap today; they are not the same idea.
 */
export const POLICY_DOMAINS = ['grievance', 'dprequest', 'breach'] as const;
export type PolicyDomain = (typeof POLICY_DOMAINS)[number];

/**
 * The ticket lifecycle.
 *
 * `pending_identity_verification` is the load-bearing one and the reason this
 * list is not the generic `WorkflowStatus`. It is the state where the platform
 * has proved everything it is ALLOWED to prove (the contact channel answered)
 * and is now waiting on a human at the Data Fiduciary to answer the question
 * only they may answer: is this person one of ours? Making that a state rather
 * than an implicit gap is FR-GRV-04's entire content — see
 * request_identity_verifications in the migration.
 */
export const REQUEST_STATUSES = [
  'created',
  'contact_verified',
  'pending_identity_verification',
  'assigned',
  'in_progress',
  'resolved',
  'closed',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Terminal states: the SLA clock is cancelled on entry to either. */
export const CLOSED_REQUEST_STATUSES: readonly RequestStatus[] = ['resolved', 'closed'];

/** How the requester is reached — and therefore which channel the OTP proves. */
export const CONTACT_CHANNELS = ['email', 'sms'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * The staff verdict on the identity handoff. `inconclusive` is deliberately
 * first-class: a two-valued answer would quietly turn "we could not tell" into
 * "not our customer", which is the outcome most likely to wrongly deny someone
 * their statutory rights.
 */
export const IDENTITY_VERIFICATION_OUTCOMES = ['matched', 'not_matched', 'inconclusive'] as const;
export type IdentityVerificationOutcome = (typeof IDENTITY_VERIFICATION_OUTCOMES)[number];

/**
 * The escalation ladder, in order. Grievance Officer -> DPO -> escalation
 * contact. Each rung resolves through `org_designations` (FR-IDN-04), so who
 * holds a rung is the tenant's own configuration, never a hardcoded email.
 */
export const ESCALATION_RUNGS = ['grievance_officer', 'dpo', 'escalation_contact'] as const;
export type EscalationRung = (typeof ESCALATION_RUNGS)[number];

/** Why a rung was reached. `sla_proximity` fires before the deadline;
 *  `sla_breach` at or after it; `manual` is a human deciding not to wait. */
export const ESCALATION_TRIGGERS = ['sla_proximity', 'sla_breach', 'manual'] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/** Who wrote a correspondence entry / caused a transition. */
export const REQUEST_ACTOR_TYPES = ['public_submitter', 'staff', 'system'] as const;
export type RequestActorType = (typeof REQUEST_ACTOR_TYPES)[number];

export const CORRESPONDENCE_DIRECTIONS = ['inbound', 'outbound', 'internal_note'] as const;
export type CorrespondenceDirection = (typeof CORRESPONDENCE_DIRECTIONS)[number];

/**
 * One rung of an SLA escalation ladder, as DATA (the FR-BRC-02 rule — "deadlines
 * are data, not code" — applied to requests). `atPercent` is a fraction of the
 * SLA duration, so one ladder definition works for a 72-hour SLA and a 30-day
 * one without anybody editing code.
 */
export interface EscalationLadderStep {
  level: number;
  /** 1-100. 100 means "at the deadline"; >100 is not expressible on purpose. */
  atPercent: number;
  rung: EscalationRung;
}

export interface RequestSlaPolicy {
  requestType: RequestType;
  slaSeconds: number;
  ladder: EscalationLadderStep[];
  /** True when no tenant row exists and the platform default is in force. */
  isDefault: boolean;
  updatedAt: string | null;
}

/** A ticket as staff see it. */
export interface RequestTicket {
  id: string;
  requestType: RequestType;
  referenceCode: string;
  status: RequestStatus;
  subject: string;
  contactChannel: ContactChannel;
  /** Masked for list views; the full value is only on the detail read. */
  contactValue: string;
  contactVerifiedAt: string | null;
  escalationLevel: number;
  assignedTo: string | null;
  slaDueAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/**
 * A ticket as the REQUESTER sees it through the portal. Strictly narrower than
 * the staff view: no internal notes, no assignee, no IP, no escalation detail.
 */
export interface PortalRequestView {
  referenceCode: string;
  requestType: RequestType;
  status: RequestStatus;
  subject: string;
  contactChannel: ContactChannel;
  contactVerified: boolean;
  slaDueAt: string | null;
  createdAt: string;
  correspondence: PortalCorrespondenceEntry[];
}

export interface PortalCorrespondenceEntry {
  direction: Exclude<CorrespondenceDirection, 'internal_note'>;
  authorType: RequestActorType;
  body: string;
  createdAt: string;
}

export interface RequestCorrespondenceEntry {
  id: string;
  direction: CorrespondenceDirection;
  authorType: RequestActorType;
  authorUserId: string | null;
  authorLabel: string | null;
  body: string;
  createdAt: string;
}

export interface RequestStatusEvent {
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus;
  actorType: RequestActorType;
  actorUserId: string | null;
  reason: string;
  occurredAt: string;
}

/** The FR-GRV-04 handoff task, as it appears in a staff queue. */
export interface IdentityVerificationTask {
  id: string;
  ticketId: string;
  referenceCode: string;
  status: 'pending' | 'completed';
  outcome: IdentityVerificationOutcome | null;
  reason: string | null;
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  /** The ONLY thing the platform can tell the verifier: which channel it proved,
   *  and its value. Matching it to a customer is their job, in their systems. */
  verifiedChannel: ContactChannel;
  verifiedContact: string;
  contactVerifiedAt: string | null;
}

export interface RequestEscalation {
  level: number;
  rung: EscalationRung;
  trigger: EscalationTrigger;
  notifiedUserId: string | null;
  notifiedContact: string | null;
  notifiedOk: boolean | null;
  reason: string | null;
  occurredAt: string;
}

export interface RequestSlaTimer {
  level: number;
  rung: EscalationRung;
  trigger: EscalationTrigger;
  dueAt: string;
  status: 'scheduled' | 'fired' | 'cancelled';
  firedAt: string | null;
}

/**
 * The actor label written into the audit log for a request that arrived through
 * the public portal with no login at all.
 *
 * The audit log's `actor_id` is NULL for these — there is no user row to point
 * at, exactly as for a failed login — so this label is the only thing that
 * distinguishes "a member of the public filed this" from "a staff member did".
 * Same job, and deliberately the same shape, as `consent_sdk:<keyId>` for the
 * Consent SDK (FR-CON-09).
 */
export const ANONYMOUS_PORTAL_ACTOR_LABEL = 'public_portal:anonymous';
