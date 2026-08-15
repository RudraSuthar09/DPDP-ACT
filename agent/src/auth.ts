/**
 * The session/authentication BOUNDARY (Phase 3A contract, shape only).
 *
 * Phase 3B does NOT validate a session against Azure — there is no pairing, no
 * enrollment, no session store yet. What exists here is the boundary shape: when
 * a caller presents the custom auth header (GATEWAY_AUTH_HEADER), it must be a
 * well-formed opaque token. This is where real session validation will attach in
 * Phase 3C; today it only checks the token is present-and-plausible, never what
 * it means.
 *
 * The token is treated as an OPAQUE SECRET: it is inspected for shape only and is
 * NEVER logged, echoed, or returned (see server.ts).
 */
import { GATEWAY_AUTH_HEADER } from '@dpdp/shared';

export { GATEWAY_AUTH_HEADER };

/** Opaque-token shape bounds — a random session token, not customer data. */
const MIN_TOKEN_LEN = 16;
const MAX_TOKEN_LEN = 4096;
const TOKEN_CHARSET = /^[A-Za-z0-9._~+/=-]+$/; // base64url/JWT-ish opaque charset

export interface AuthHeaderInspection {
  present: boolean;
  valid: boolean;
}

/**
 * Inspect the auth header value WITHOUT trusting or interpreting it.
 *   - absent            → { present:false, valid:true }  (liveness/non-auth call)
 *   - duplicated header → invalid (an array means the header was sent twice)
 *   - wrong shape       → invalid (empty, too short/long, illegal characters)
 *   - plausible opaque  → { present:true, valid:true }
 *
 * "valid" here means "well-formed", NOT "authenticated". Authentication is a
 * later phase. The raw value is never returned or logged.
 */
export function inspectAuthHeader(raw: string | string[] | undefined): AuthHeaderInspection {
  if (raw === undefined) return { present: false, valid: true };
  if (Array.isArray(raw)) return { present: true, valid: false };
  const token = raw.trim();
  const valid =
    token.length >= MIN_TOKEN_LEN && token.length <= MAX_TOKEN_LEN && TOKEN_CHARSET.test(token);
  return { present: true, valid };
}
