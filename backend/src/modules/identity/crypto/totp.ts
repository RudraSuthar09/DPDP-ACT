import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32';

/**
 * TOTP — RFC 6238 (which is HOTP/RFC 4226 with a time-derived counter).
 *
 * Implemented directly against the RFC because it is small, frozen, and comes
 * with published test vectors — `totp.spec.ts` runs this against the exact
 * vectors in RFC 6238 Appendix B, which is a stronger correctness argument than
 * "a popular package presumably does this right".
 *
 * SHA-1 is the algorithm here, and that is deliberate: RFC 6238 permits SHA-256,
 * but Google Authenticator, Microsoft Authenticator, and most hardware tokens
 * only implement SHA-1. HMAC-SHA1 is not affected by SHA-1's collision
 * weaknesses (HMAC does not rely on collision resistance), so the interoperable
 * choice is also the safe one.
 */

/** The TOTP time step, in seconds. 30 is the universal default; apps assume it. */
export const TOTP_STEP_SECONDS = 30;

/** Digits in a generated code. 6 is what every authenticator app renders. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of "now" are accepted. 1 → a ±30s window (~90s of
 * total tolerance), the standard allowance for clock drift between the phone and
 * the server. Each extra step widens the guessing surface, so it stays at 1.
 */
export const TOTP_WINDOW_STEPS = 1;

/** The time step a given moment falls in. This is the HOTP counter. */
export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Generate the code for one counter value (RFC 4226 §5.3 dynamic truncation).
 * Exported for the spec, which drives it with the RFC's counters directly.
 */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  // The counter is a 64-bit big-endian integer. Node's writeBigUInt64BE keeps
  // this exact past 2^53, where a Number-based shift would quietly lose bits.
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(counterBuffer).digest();

  // Dynamic truncation: the low nibble of the last byte picks the 4-byte window.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** The TOTP code for a moment in time. */
export function totp(secret: Buffer, atMs: number = Date.now()): string {
  return hotp(secret, totpStep(atMs));
}

export interface TotpVerification {
  valid: boolean;
  /**
   * The step the code matched. The caller MUST persist this and refuse any
   * step <= the last one it accepted, or a code stays replayable for its whole
   * window (RFC 6238 §5.2). `users.mfa_last_step` is where it goes.
   */
  step?: number;
}

/**
 * Verify a submitted code against the accepted window.
 *
 * `lastUsedStep` makes codes single-use: a code from a step already consumed is
 * rejected even though it is still arithmetically valid. Comparison is
 * constant-time — a code is a credential, and a fast reject on the first wrong
 * digit leaks it a digit at a time.
 */
export function verifyTotp(
  secret: Buffer,
  submitted: string,
  options: { atMs?: number; lastUsedStep?: number | null } = {},
): TotpVerification {
  const { atMs = Date.now(), lastUsedStep = null } = options;

  const candidate = submitted.replace(/\s+/g, '');
  if (!/^\d+$/.test(candidate) || candidate.length !== TOTP_DIGITS) {
    return { valid: false };
  }

  const current = totpStep(atMs);
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = current + offset;

    // Replay defence: never accept a step at or before the last one consumed.
    if (lastUsedStep !== null && step <= lastUsedStep) {
      continue;
    }

    if (constantTimeEquals(hotp(secret, step), candidate)) {
      return { valid: true, step };
    }
  }

  return { valid: false };
}

/** A fresh 160-bit TOTP secret — the RFC 4226 §4 recommended length for SHA-1. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/**
 * The `otpauth://` URI an authenticator app consumes (usually via QR code).
 * The issuer appears twice by design: once as a label prefix for apps that only
 * read the label, once as a parameter for apps that read parameters.
 */
export function totpAuthUri(params: { secret: Buffer; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal; length is not secret here (codes are fixed-width), so compare it first.
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
