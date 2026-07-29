import type { PoolClient } from 'pg';
import type { WorkflowKind } from '@dpdp/shared';

export const DEADLINE_HANDLERS = Symbol('DEADLINE_HANDLERS');

/**
 * What a fired deadline DOES — the consuming edge of Seam S3.
 *
 * Until now WorkflowWorker.onDeadline was an empty method with a comment saying
 * "this is where Breach's alerts and Grievance's SLA breach hook in". This is
 * that hook, and its shape matters: it is an INTERFACE the workflow module
 * declares and does not implement.
 *
 * The alternative — WorkflowWorker importing the request module and calling it —
 * would make the deadline substrate depend on one of the three domains that
 * depend on IT, which is precisely the coupling R2 forbids and the reason the
 * seam could be swapped for Temporal at all. Here, the workflow module knows
 * only that some number of handlers exist; each domain registers its own in
 * WorkerModule, and the workflow module never learns their names.
 *
 * The handler runs INSIDE the worker's firing transaction, on the same client,
 * with the tenant already bound. So the state transition ("this deadline fired")
 * and its consequence ("this ticket escalated to the DPO") commit together or
 * not at all — the same atomicity the audit interceptor gives an HTTP mutation,
 * for the same reason: a deadline that fired with no consequence, or a
 * consequence with no record of what caused it, is worse than either alone.
 *
 * A handler must therefore be narrow and fast, must not open its own
 * transaction, and must not throw for anything it can absorb: an exception rolls
 * back the firing itself, and the reconciliation ticker will then try the whole
 * thing again.
 */
export interface DeadlineHandler {
  /** Which kinds this handler wants. The worker asks; it does not assume. */
  handles(kind: WorkflowKind): boolean;

  /**
   * @param client  the worker's transaction, tenant already bound (Seam S1).
   * @param workflowId  the id the domain passed to WorkflowRunner.schedule().
   */
  onDeadline(
    client: PoolClient,
    context: { tenantId: string; workflowId: string; kind: WorkflowKind },
  ): Promise<void>;
}
