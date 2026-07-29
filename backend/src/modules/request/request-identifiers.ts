import { createHash, randomBytes, randomInt, timingSafeEqual, createHmac } from 'node:crypto';
import type { RequestType } from '@dpdp/shared';

/**
 * The small, pure identifier/secret helpers the request substrate needs. Kept
 * out of the services so each one can be reasoned about (and tested) as a
 * function of its inputs, and so the security-relevant choices are all in one
 * short file rather than scattered through request handling.
 */

const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
const REFERENCE_PREFIX: Record<RequestType, string> = {
  grievance: 'GRV',
  dprequest: 'DPR',
};

/**
 * The code a requester quotes: GRV-7K2M-9QX4.
 *
 * Ambiguous glyphs are excluded because this gets read down a phone line and
 * typed off a screenshot. ~50 bits of entropy, which is not there to make it a
 * secret — reading a ticket needs the OTP-issued portal token, not this — but so
 * that codes never collide within a tenant and so the space cannot be walked.
 */
export function mintReferenceCode(requestType: RequestType): string {
  const pick = () =>
    Array.from({ length: 4 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join(
      '',
    );
  return `${REFERENCE_PREFIX[requestType]}-${pick()}-${pick()}`;
}

/** A six-digit one-time code. `randomInt` is CSPRNG-backed; `Math.random` here
 *  would make the code guessable and the whole verification theatre. */
export function mintOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Hash an OTP for storage.
 *
 * HMAC with a server-side secret, not a bare digest. A six-digit code beside a
 * known ticket id is a million candidates — a bare SHA-256 column would be
 * reversible in about a second from a database dump, which would mean a stolen
 * backup silently defeats contact verification. The secret lives in the
 * environment and never in the database, so a dump alone yields nothing.
 *
 * The ticket id is mixed in so a hash lifted from one ticket cannot be replayed
 * against another.
 */
export function hashOtp(secret: string, ticketId: string, code: string): string {
  return createHmac('sha256', secret).update(`${ticketId}:${code}`).digest('hex');
}

/** Constant-time comparison — an OTP check that leaks timing leaks the code. */
export function otpMatches(expectedHash: string, candidateHash: string): boolean {
  const a = Buffer.from(expectedHash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The workflow id for one rung of one ticket's escalation ladder.
 *
 * Derived, not stored-and-looked-up: the S3 deadline register holds at most one
 * live deadline per (tenant, workflow id, kind), so N rungs need N distinct ids,
 * and deriving them from (ticketId, level) means the ticket can always name its
 * own deadlines —
 * above all to CANCEL them when it resolves early — without a mapping that could
 * drift out of step with what was actually scheduled.
 *
 * Shaped as a v4-looking UUID (version and variant bits set) purely so it
 * satisfies the `uuid` column type; the value carries no meaning beyond being a
 * stable function of its inputs.
 */
export function deadlineWorkflowId(ticketId: string, level: number): string {
  const digest = createHash('sha256').update(`${ticketId}:sla:${level}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Opaque, unguessable id for a portal session token's jti. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Mask a contact channel value for anywhere it is shown before the channel has
 * been proved — a portal response, a staff list view, a log line. Enough for the
 * requester to recognise their own address; not enough for a stranger who
 * guessed a reference code to harvest it.
 */
export function maskContact(channel: 'email' | 'sms', value: string): string {
  if (channel === 'email') {
    const [local = '', domain = ''] = value.split('@');
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`;
  }
  const tail = value.slice(-3);
  return `${'*'.repeat(Math.max(1, value.length - 3))}${tail}`;
}
