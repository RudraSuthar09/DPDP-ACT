/**
 * Bounded exponential backoff with jitter (Phase 1 of the production
 * build-out) — for ONE-SHOT recoverable operations only (today: the
 * startup enrollment attempt in index.ts). The heartbeat and delivery
 * poller are deliberately NOT retried this way: they already retry forever
 * on their own fixed interval (enrollment.ts's startHeartbeat, delivery/
 * poller.ts's startDeliveryPoller) — layering a second, finite retry loop
 * UNDER an already-infinite one would just make a transient blip look like
 * a terminal failure sooner than it needs to, which is the opposite of
 * what this module exists for.
 *
 * `isRetryable` is mandatory and no default silently retries everything —
 * a caller must say which failures are worth retrying (network/timeout)
 * versus which are terminal (invalid enrollment code, revoked device) and
 * should fail fast instead of burning through the attempt budget.
 */

export interface RetryOptions {
  /** Including the first attempt. */
  maxAttempts: number;
  /** Delay before the SECOND attempt; doubles each attempt after that. */
  baseDelayMs: number;
  /** Hard ceiling on any single delay, before jitter is applied. */
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Injectable for tests — real callers never pass this. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter (AWS's own recommended strategy): a uniformly random delay
 *  between 0 and the computed exponential value, not just +/- a percentage
 *  — this is what actually prevents a fleet of agents that all lost
 *  connectivity at the same moment from all retrying in lockstep. */
function delayForAttempt(attempt: number, opts: RetryOptions): number {
  const exponential = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exponential);
}

/**
 * Runs `fn`, retrying up to `maxAttempts` total attempts while `isRetryable`
 * accepts the thrown error. Re-throws the LAST error once attempts are
 * exhausted, or immediately the first time `isRetryable` returns false —
 * never silently swallowed, matching "do not silently swallow errors".
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!opts.isRetryable(err) || attempt === opts.maxAttempts) {
        throw err;
      }
      const delayMs = delayForAttempt(attempt, opts);
      opts.onRetry?.(attempt, err, delayMs);
      await sleep(delayMs);
    }
  }
  // Unreachable (the loop always returns or throws), but keeps the return
  // type honest for TypeScript without a non-null assertion.
  throw lastErr;
}
