/**
 * The fixed-window, in-memory rate limiter — extracted from
 * PublicApiKeyMiddleware (FR-CON-09) when the public request portal (FR-GRV-01)
 * became the platform's second genuinely unauthenticated surface. Two public
 * surfaces with two subtly different limiters is how you end up with one of them
 * being wrong and nobody noticing, so there is one implementation and both use
 * it.
 *
 * WHAT THIS IS NOT. It is a Stage-1 stand-in, not a real limiter, and the
 * limitation is the same one the API-key middleware already documents: the
 * counters live in ONE process's memory. They reset on restart, and the moment
 * there is a second app instance each holds its own counters and the effective
 * limit silently multiplies by the instance count. There is no Redis in this
 * backend (the job queue is pg-boss, Postgres-native), and standing one up for
 * this alone would be disproportionate for Stage 1 (R1). When a trigger metric
 * says otherwise, this class is the single place that changes — which is most of
 * why it is a class rather than a Map in a middleware.
 *
 * Fixed window rather than sliding/token bucket, deliberately: a fixed window
 * lets up to 2x the limit across a window boundary, which for "stop someone
 * hammering a public form" is an entirely acceptable error and costs one Map
 * entry per key instead of a per-key timestamp list.
 */
export interface RateLimitRule {
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window resets — the Retry-After a caller gets. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  /** Cheap guard against unbounded growth from a flood of distinct keys. */
  private lastSweep = Date.now();

  /**
   * Count one hit against `key` and say whether it is allowed.
   *
   * The bucket is namespaced by rule so the same subject (an IP, say) can be
   * limited on several axes at once — "10 submissions per 10 minutes" and "60
   * requests per minute" — without the two counters colliding.
   */
  hit(bucket: string, key: string, rule: RateLimitRule): RateLimitVerdict {
    const now = Date.now();
    this.sweepIfDue(now);

    const mapKey = `${bucket}:${key}`;
    const existing = this.windows.get(mapKey);

    if (!existing || existing.resetAt <= now) {
      this.windows.set(mapKey, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > rule.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop expired windows. O(n) but amortised: at most once a minute. */
  private sweepIfDue(now: number): void {
    if (now - this.lastSweep < 60_000) {
      return;
    }
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}
