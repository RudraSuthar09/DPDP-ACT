/**
 * Shared constants for the outbound webhook pipeline (FR-CON-07), same
 * reasoning as workflow.constants.ts: the API's sender and the worker's
 * consumer must agree on one queue name without a copy-paste drift.
 */

/** The pg-boss queue every webhook delivery attempt is sent to. Reuses the
 *  SAME pg-boss engine as the WorkflowRunner (S3) — PgBossService is exported
 *  @Global from WorkflowModule precisely so a second durable-job use case
 *  does not need a second engine/connection pool. A different queue, not a
 *  different boss. */
export const WEBHOOK_QUEUE = 'dpdp.notify.webhook';

/** pg-boss's own built-in retry, not a hand-rolled backoff loop: a failed
 *  delivery (the client's endpoint down, a timeout, a 5xx) is retried this
 *  many times with pg-boss's exponential backoff before the row is left
 *  'failed' for a human to see in the Prompt 23 settings UI. */
export const WEBHOOK_RETRY_LIMIT = 5;

/** How long to wait for the client's endpoint before giving up on one attempt. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
