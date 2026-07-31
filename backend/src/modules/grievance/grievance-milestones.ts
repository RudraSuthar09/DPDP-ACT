import type { RequestService } from '../request/request.service';

/**
 * FR-GRV-06 — "proof that a complaint was received, verified, actioned, and
 * closed within the required time." Four timestamps and one comparison, all
 * derived from data the substrate already recorded — nothing here invents a
 * new fact or writes anywhere; it only reads `RequestService.detail()`'s
 * output and picks out the four moments that answer the requirement.
 *
 * `RequestDetail` is `Awaited<ReturnType<RequestService['detail']>>` rather
 * than a hand-copied interface, so this file cannot silently drift out of
 * step with what `detail()` actually returns.
 */
export type RequestDetail = Awaited<ReturnType<RequestService['detail']>>;

export interface IdentityVerificationSummary {
  outcome: 'matched' | 'not_matched' | null;
  reason: string | null;
  occurredAt: string | null;
}

const NOT_MATCHED_REASON_PREFIX = 'Identity could not be matched to a customer record: ';

/**
 * `detail.identityVerification` (from `RequestService.detail()`) only ever
 * reflects a task that is STILL PENDING — its query is `findPendingIdentityTask`
 * (see `request-verification.repository.ts`), and a completed task simply
 * stops matching it. Since a resolution export only exists for a
 * resolved/closed ticket, and every such ticket passed through
 * `pending_identity_verification` on the way there, `detail.identityVerification`
 * is `null` for EVERY ticket this function is ever called on — reading only
 * that field would make a resolution certificate's identity-verification
 * section permanently blank on the one document where it matters most.
 *
 * The verdict is still on the record: it is the append-only status trail's
 * transition OUT of `pending_identity_verification`.
 *   - `-> assigned` is structurally unambiguous: `RequestService.assign()`
 *     only ever moves a ticket that is ALREADY `assigned`/`in_progress`
 *     (see its `expectedFrom`), so this transition can only be
 *     `completeIdentityVerification`'s matched branch.
 *   - `-> closed` is NOT unambiguous by itself — `STAFF_TRANSITIONS` also
 *     allows a manual close directly from `pending_identity_verification`
 *     (e.g. staff closing a duplicate ticket). The fixed reason prefix
 *     `completeIdentityVerification`'s not-matched branch writes is what
 *     tells the two apart; if that literal string in `request.service.ts`
 *     ever changes, this must change with it.
 */
export function deriveIdentityVerification(detail: RequestDetail): IdentityVerificationSummary {
  if (detail.identityVerification?.status === 'completed') {
    return {
      outcome: (detail.identityVerification.outcome as 'matched' | 'not_matched' | null) ?? null,
      reason: detail.identityVerification.reason,
      occurredAt: detail.identityVerification.completedAt,
    };
  }
  const handoff = detail.statusHistory.find((e) => e.fromStatus === 'pending_identity_verification');
  if (!handoff) {
    return { outcome: null, reason: null, occurredAt: null };
  }
  if (handoff.toStatus === 'assigned') {
    return { outcome: 'matched', reason: handoff.reason, occurredAt: handoff.occurredAt };
  }
  if (handoff.toStatus === 'closed' && handoff.reason.startsWith(NOT_MATCHED_REASON_PREFIX)) {
    return {
      outcome: 'not_matched',
      reason: handoff.reason.slice(NOT_MATCHED_REASON_PREFIX.length),
      occurredAt: handoff.occurredAt,
    };
  }
  return { outcome: null, reason: null, occurredAt: null };
}

export interface GrievanceMilestones {
  /** The ticket was created — the moment the portal accepted the submission. */
  receivedAt: string;
  /** The requester's contact channel was proved by OTP. Null only if the
   *  ticket somehow never got this far (shouldn't happen once resolved/closed —
   *  every staff-settable status requires having passed through this). */
  verifiedAt: string | null;
  /** The earliest moment the Data Fiduciary's own staff did anything about
   *  this ticket: the identity-verification verdict, the first staff-caused
   *  status transition, or the first staff correspondence entry — whichever
   *  came first. Null if none of those exist yet. */
  actionedAt: string | null;
  /** When the ticket left `resolved`/`closed`'s open predecessors. */
  closedAt: string | null;
  /** The deadline snapshotted when the SLA clock started. */
  slaDueAt: string | null;
  /** `closedAt <= slaDueAt`. Null when either side of that comparison is
   *  unavailable — an export should say "not applicable", never guess. */
  withinSla: boolean | null;
}

export function computeMilestones(detail: RequestDetail): GrievanceMilestones {
  const receivedAt = detail.ticket.createdAt;
  const verifiedAt = detail.ticket.contactVerifiedAt;
  const closedAt = detail.ticket.closedAt;
  const slaDueAt = detail.ticket.slaDueAt;

  const actionCandidates: string[] = [];
  const identityVerification = deriveIdentityVerification(detail);
  if (identityVerification.occurredAt) {
    actionCandidates.push(identityVerification.occurredAt);
  }
  // Both trails are already ordered ascending by their repository queries
  // (ORDER BY occurred_at / created_at) — the first match IS the earliest.
  const firstStaffStatusEvent = detail.statusHistory.find((e) => e.actorType === 'staff');
  if (firstStaffStatusEvent) {
    actionCandidates.push(firstStaffStatusEvent.occurredAt);
  }
  const firstStaffCorrespondence = detail.correspondence.find((c) => c.authorType === 'staff');
  if (firstStaffCorrespondence) {
    actionCandidates.push(firstStaffCorrespondence.createdAt);
  }
  const actionedAt =
    actionCandidates.length === 0
      ? null
      : actionCandidates.reduce((earliest, candidate) =>
          new Date(candidate).getTime() < new Date(earliest).getTime() ? candidate : earliest,
        );

  const withinSla =
    closedAt && slaDueAt ? new Date(closedAt).getTime() <= new Date(slaDueAt).getTime() : null;

  return { receivedAt, verifiedAt, actionedAt, closedAt, slaDueAt, withinSla };
}
