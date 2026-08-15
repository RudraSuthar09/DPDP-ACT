import type { GatewayErrorCode } from '@dpdp/shared';

/**
 * The Gateway control-plane SECURITY DECISIONS, as PURE FUNCTIONS.
 *
 * Every accept/reject in the enrol → pair → session flow lives here, decoupled
 * from the database and HTTP so it can be tested exhaustively and read in one
 * place. The service layer fetches rows (under RLS) and asks these functions
 * whether to proceed; it never re-implements a check inline.
 *
 * A rejection carries a stable GatewayErrorCode (from the Phase-3A contract) plus
 * an internal `reason` for logs/tests. The reason is metadata about the decision
 * — never a token, a secret, or a customer value.
 */

export type PolicyResult = { ok: true } | { ok: false; code: GatewayErrorCode; reason: string };

const fail = (code: GatewayErrorCode, reason: string): PolicyResult => ({ ok: false, code, reason });
const OK: PolicyResult = { ok: true };

// --- enrolment code (one-time, expiring) -----------------------------------

export interface EnrollmentRow {
  expires_at: Date;
  consumed_at: Date | null;
}

/** An enrolment code is valid iff it exists, is unused, and is unexpired. */
export function evaluateEnrollmentCode(row: EnrollmentRow | null, now: Date): PolicyResult {
  if (!row) return fail('INVALID_TOKEN', 'enrolment code not found');
  if (row.consumed_at) return fail('INVALID_TOKEN', 'enrolment code already used');
  if (now.getTime() > row.expires_at.getTime()) return fail('INVALID_TOKEN', 'enrolment code expired');
  return OK;
}

// --- device status ----------------------------------------------------------

export interface DeviceRow {
  status: 'active' | 'revoked' | 'removed';
}

/** A device may act only while active — revoked/removed fail closed. */
export function evaluateDeviceStatus(row: DeviceRow | null): PolicyResult {
  if (!row) return fail('AGENT_NOT_ENROLLED', 'device not found');
  if (row.status === 'revoked') return fail('AGENT_REVOKED', 'device revoked');
  if (row.status === 'removed') return fail('AGENT_REVOKED', 'device removed');
  return OK;
}

// --- pairing nonce (one-time, expiring, {tenant,device,source}-bound) --------

export interface PairingRow {
  tenant_id: string;
  device_id: string;
  source_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * A pairing nonce may be redeemed once, before expiry, by exactly the device and
 * for exactly the source it was issued for, within the same tenant. Tenant is
 * checked first (isolation), then single-use/expiry, then the bindings.
 */
export function evaluatePairingRedemption(
  row: PairingRow | null,
  ctx: { tenantId: string; deviceId: string; sourceId: string; now: Date },
): PolicyResult {
  if (!row) return fail('INVALID_NONCE', 'pairing nonce not found');
  if (row.tenant_id !== ctx.tenantId) return fail('TENANT_MISMATCH', 'pairing belongs to another tenant');
  if (row.consumed_at) return fail('INVALID_NONCE', 'pairing nonce already redeemed');
  if (ctx.now.getTime() > row.expires_at.getTime()) return fail('INVALID_NONCE', 'pairing nonce expired');
  if (row.device_id !== ctx.deviceId) return fail('DEVICE_MISMATCH', 'pairing bound to another device');
  if (row.source_id !== ctx.sourceId) return fail('SOURCE_MISMATCH', 'pairing bound to another source');
  return OK;
}

// --- session (short-lived, revocable, {tenant,device,source}-bound) ----------

export interface SessionRow {
  tenant_id: string;
  device_id: string;
  source_id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * A session is valid iff it exists, belongs to the tenant, is not revoked, is
 * unexpired, and (when the caller asserts them) matches the device/source it was
 * bound to. Used by session/refresh now and by the future data plane.
 */
export function evaluateSession(
  row: SessionRow | null,
  ctx: { tenantId: string; now: Date; deviceId?: string; sourceId?: string },
): PolicyResult {
  if (!row) return fail('INVALID_TOKEN', 'session not found');
  if (row.tenant_id !== ctx.tenantId) return fail('TENANT_MISMATCH', 'session belongs to another tenant');
  if (row.revoked_at) return fail('AGENT_REVOKED', 'session revoked');
  if (ctx.now.getTime() > row.expires_at.getTime()) return fail('SESSION_EXPIRED', 'session expired');
  if (ctx.deviceId && row.device_id !== ctx.deviceId) return fail('DEVICE_MISMATCH', 'session bound to another device');
  if (ctx.sourceId && row.source_id !== ctx.sourceId) return fail('SOURCE_MISMATCH', 'session bound to another source');
  return OK;
}
