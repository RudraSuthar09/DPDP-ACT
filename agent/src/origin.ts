/**
 * Origin authorization — EXACT match against the configured allowlist.
 *
 * There is deliberately NO hard-coded origin in this file. No 'localhost', no
 * '127.0.0.1', no production hostname, no default list. The allowlist is passed
 * in from configuration. And the match is exact set membership — never
 * startsWith, never includes, never a substring or wildcard — so a similar-but-
 * not-identical origin (e.g. 'https://app.example.evil.com' vs 'https://app.example')
 * is denied.
 */

export type OriginDecision = 'no-origin' | 'allowed' | 'denied';

/**
 * Classify a request's Origin.
 *   - 'no-origin' : no Origin header (a non-browser/liveness caller). The caller
 *                   decides what to do with this; for a browser data request the
 *                   Origin is always present, so its absence is not "allowed".
 *   - 'allowed'   : the exact origin string is in the allowlist.
 *   - 'denied'    : an Origin was presented but is not in the allowlist.
 */
export function evaluateOrigin(
  origin: string | undefined,
  allowlist: readonly string[],
): OriginDecision {
  if (origin === undefined) return 'no-origin';
  // EXACT membership only. Array.includes is an exact === comparison.
  return allowlist.includes(origin) ? 'allowed' : 'denied';
}
