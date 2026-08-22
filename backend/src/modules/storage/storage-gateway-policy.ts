import type { GatewayErrorCode } from '@dpdp/shared';

/**
 * Storage-plane pairing/session decisions, as PURE FUNCTIONS — the sibling of
 * gateway-policy.ts's evaluatePairingRedemption/evaluateSession, scoped to a
 * storage_root_id instead of a source_id. Deliberately duplicated rather than
 * generalizing the originals: this keeps the well-tested Gateway control
 * plane (Phase 3C) untouched, and the two are conceptually the same rule
 * applied to a different bound resource (R2 — not worth the coupling for
 * ~15 lines).
 */

export type PolicyResult = { ok: true } | { ok: false; code: GatewayErrorCode; reason: string };

const fail = (code: GatewayErrorCode, reason: string): PolicyResult => ({ ok: false, code, reason });
const OK: PolicyResult = { ok: true };

export interface StoragePairingRow {
  tenant_id: string;
  device_id: string;
  storage_root_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * A storage pairing nonce may be redeemed once, before expiry, by exactly the
 * device and for exactly the storage root it was issued for, within the same
 * tenant.
 */
export function evaluateStoragePairingRedemption(
  row: StoragePairingRow | null,
  ctx: { tenantId: string; deviceId: string; storageRootId: string; now: Date },
): PolicyResult {
  if (!row) return fail('INVALID_NONCE', 'storage pairing nonce not found');
  if (row.tenant_id !== ctx.tenantId) return fail('TENANT_MISMATCH', 'storage pairing belongs to another tenant');
  if (row.consumed_at) return fail('INVALID_NONCE', 'storage pairing nonce already redeemed');
  if (ctx.now.getTime() > row.expires_at.getTime()) return fail('INVALID_NONCE', 'storage pairing nonce expired');
  if (row.device_id !== ctx.deviceId) return fail('DEVICE_MISMATCH', 'storage pairing bound to another device');
  if (row.storage_root_id !== ctx.storageRootId) {
    return fail('STORAGE_ROOT_MISMATCH', 'storage pairing bound to another storage root');
  }
  return OK;
}

export interface StorageSessionRow {
  tenant_id: string;
  device_id: string;
  storage_root_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * A storage session is valid iff it exists, belongs to the tenant, is not
 * revoked, is unexpired, and (when asserted) matches the device/root it was
 * bound to.
 */
export function evaluateStorageSession(
  row: StorageSessionRow | null,
  ctx: { tenantId: string; now: Date; deviceId?: string; storageRootId?: string },
): PolicyResult {
  if (!row) return fail('INVALID_TOKEN', 'storage session not found');
  if (row.tenant_id !== ctx.tenantId) return fail('TENANT_MISMATCH', 'storage session belongs to another tenant');
  if (row.revoked_at) return fail('AGENT_REVOKED', 'storage session revoked');
  if (ctx.now.getTime() > row.expires_at.getTime()) return fail('SESSION_EXPIRED', 'storage session expired');
  if (ctx.deviceId && row.device_id !== ctx.deviceId) return fail('DEVICE_MISMATCH', 'storage session bound to another device');
  if (ctx.storageRootId && row.storage_root_id !== ctx.storageRootId) {
    return fail('STORAGE_ROOT_MISMATCH', 'storage session bound to another storage root');
  }
  return OK;
}
