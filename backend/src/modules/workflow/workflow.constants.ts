/**
 * Shared constants for the WorkflowRunner seam (S3).
 *
 * The queue names live in the `dpdp` namespace so they are unmistakable in the
 * pg-boss tables. Keeping them here (not inline) is what lets the API's runner
 * and the worker's handler agree on the same string without a copy-paste drift.
 */

/** The queue every deadline job is sent to, and the worker consumes. */
export const WORKFLOW_QUEUE = 'dpdp.workflow.deadline';

/** How often the reconciliation ticker sweeps for deadlines the engine missed. */
export const TICKER_INTERVAL_MS = 30_000;
