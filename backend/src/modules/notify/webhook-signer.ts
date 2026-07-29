import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The outbound webhook signature scheme (FR-CON-07) — deliberately the same
 * shape Stripe/GitHub use, because it is a well-understood, easy-to-document
 * convention rather than a bespoke one the client has to puzzle out from our
 * source alone.
 *
 * Header sent with every delivery:
 *
 *   X-DPDP-Webhook-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
 *   X-DPDP-Webhook-Id:        <delivery id (uuid)>
 *
 * Signed content is `${t}.${rawJsonBody}` — the TIMESTAMP is part of what is
 * signed, not a separate unauthenticated field, so an attacker who captures
 * one valid (body, signature) pair cannot replay it under a different
 * timestamp. `v1` is HMAC-SHA256(tenant_webhook_secret, signed_content), hex.
 *
 * TO VERIFY (what a client integration should do):
 *   1. Parse `t` and `v1` out of X-DPDP-Webhook-Signature.
 *   2. Recompute HMAC-SHA256(your_secret, `${t}.${raw_request_body}`), hex.
 *   3. Compare to `v1` in constant time (never `===`).
 *   4. Reject if `t` is more than ~5 minutes from your own clock — this is the
 *      replay window, and is the client's responsibility to enforce, exactly
 *      as consent ingest's own 5-minute clock-skew allowance is documented in
 *      dto.ts.
 *
 * The secret itself is per-tenant (never a shared platform pepper — see
 * tenant_webhook_secrets), so a leaked signature scheme costs nothing without
 * the tenant's own secret, and rotating one tenant's secret never affects
 * another's.
 */
export interface WebhookSignature {
  header: string;
  timestamp: number;
}

export function signWebhookPayload(secret: Buffer, rawBody: string, now: Date = new Date()): WebhookSignature {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signedContent = `${timestamp}.${rawBody}`;
  const v1 = createHmac('sha256', secret).update(signedContent).digest('hex');
  return { header: `t=${timestamp},v1=${v1}`, timestamp };
}

/** Exported for the verification test/proof only — a real client implements
 *  this independently in their own stack from the documentation above. */
export function verifyWebhookSignature(secret: Buffer, rawBody: string, header: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) {
    return false;
  }
  const [, t, v1] = match;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(v1!, 'hex');
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}
