import type { ConsentDeliveryState } from '@dpdp/shared';

type RelayStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

/** The newest delivery-queue row for one destination of one submission:
 *  target null = Central DPDP Storage, otherwise an Enterprise storage root. */
export interface DeliveryRecord {
  target: string | null;
  status: RelayStatus;
  attemptCount: number;
}

/** Central DPDP Storage's own outcome for one submission. `not_configured`:
 *  the tenant has no Central storage location, so nothing is waiting on it. */
export type CentralOutcome = 'stored' | 'pending' | 'failed' | 'partial' | 'not_configured';

export interface DerivedDelivery {
  state: ConsentDeliveryState;
  /** Highest attempt count among destinations still being retried (0 if none). */
  retryAttempts: number;
  central: CentralOutcome;
  /** Enterprise copies only. */
  enterpriseCopies: { total: number; stored: number; failed: number };
}

type Part = 'stored' | 'partial' | 'failed' | 'pending';

/**
 * Derives a submission's storage-delivery state from the EXISTING records of
 * it — no new table, no new source of truth:
 *
 *   - consent_form_submissions.local_synced_at: set when a write path
 *     confirmed the submission was filed in Central DPDP Storage;
 *   - the newest consent_form_submission_deliveries row per destination: the
 *     Central relay (target null) and each Enterprise copy (one per storage
 *     root). Only a row the Gateway ACKNOWLEDGED counts as stored;
 *   - whether the tenant has a Central DPDP Storage location at all. Without
 *     one, Central is not a destination (nothing will ever be written there
 *     until one is configured), so it neither holds an Enterprise-only
 *     submission at "pending" forever nor counts as stored.
 *
 * Each destination is judged on its own, then combined: anything still in
 * progress -> pending; every destination stored -> delivered; every one
 * failed -> failed; otherwise partially_delivered. No destination at all ->
 * pending ("waiting for connected storage"), exactly as before.
 *
 * Pure. The consent itself (the grant/decline answers) is NOT an input: it is
 * recorded before any write is attempted and is authoritative on its own,
 * whatever this returns.
 */
export function deriveDeliveryState(input: {
  localSyncedAt: Date | null;
  deliveries: readonly DeliveryRecord[];
  /** Defaults to true — the behaviour before this input existed. */
  centralConfigured?: boolean;
}): DerivedDelivery {
  const synced = input.localSyncedAt !== null;
  const relay = input.deliveries.find((d) => d.target === null)?.status ?? null;
  const enterprise = input.deliveries.filter((d) => d.target !== null);

  const central = centralOutcome(synced, relay, input.centralConfigured ?? true);
  const parts: Part[] = [...(central === 'not_configured' ? [] : [central]), ...enterprise.map((d) => relayPart(d.status))];
  const state: ConsentDeliveryState =
    parts.length === 0 || parts.includes('pending')
      ? 'pending'
      : parts.every((p) => p === 'stored')
        ? 'delivered'
        : parts.every((p) => p === 'failed')
          ? 'failed'
          : 'partially_delivered';

  return {
    state,
    retryAttempts: Math.max(0, ...input.deliveries.filter((d) => d.status === 'pending' || d.status === 'delivering').map((d) => d.attemptCount)),
    central,
    enterpriseCopies: {
      total: enterprise.length,
      stored: enterprise.filter((d) => d.status === 'delivered').length,
      failed: enterprise.filter((d) => d.status === 'failed').length,
    },
  };
}

/** Central DPDP Storage: the relay row when there is one, else local_synced_at.
 *  Anything actually written or actually failed is reported as such even if
 *  Central has since been unconfigured — only "never happened, and nowhere to
 *  happen" is not_configured. */
function centralOutcome(synced: boolean, relay: RelayStatus | null, configured: boolean): CentralOutcome {
  if (relay === 'delivered') return 'stored';
  if (relay === 'failed') return synced ? 'partial' : 'failed';
  if (relay === 'delivering') return 'pending'; // a Gateway is writing it right now
  // No Central location: a queued relay cannot be claimed until one is
  // configured (the backend answers NOT_CONFIGURED), so it is not waited on.
  if (!configured) return synced ? 'stored' : 'not_configured';
  if (relay === 'pending') return 'pending'; // queued field values still on their way
  if (synced) return 'stored';
  return 'pending';
}

function relayPart(status: RelayStatus): Part {
  if (status === 'delivered') return 'stored';
  if (status === 'failed') return 'failed';
  return 'pending';
}
