import {
  evaluateStoragePairingRedemption,
  evaluateStorageSession,
  type StoragePairingRow,
  type StorageSessionRow,
} from './storage-gateway-policy';

const T = 'tenant-A';
const D = 'device-1';
const R = 'root-1';
const now = new Date('2026-08-14T12:00:00Z');
const future = new Date('2026-08-14T13:00:00Z');
const past = new Date('2026-08-14T11:00:00Z');

function pairing(over: Partial<StoragePairingRow> = {}): StoragePairingRow {
  return { tenant_id: T, device_id: D, storage_root_id: R, expires_at: future, consumed_at: null, ...over };
}
function session(over: Partial<StorageSessionRow> = {}): StorageSessionRow {
  return { tenant_id: T, device_id: D, storage_root_id: R, expires_at: future, revoked_at: null, ...over };
}

describe('storage pairing redemption policy', () => {
  it('a valid pairing is accepted', () => {
    expect(evaluateStoragePairingRedemption(pairing(), { tenantId: T, deviceId: D, storageRootId: R, now })).toEqual({ ok: true });
  });
  it('a missing pairing is rejected', () => {
    expect(evaluateStoragePairingRedemption(null, { tenantId: T, deviceId: D, storageRootId: R, now })).toMatchObject({
      ok: false,
      code: 'INVALID_NONCE',
    });
  });
  it('a different tenant is rejected', () => {
    expect(
      evaluateStoragePairingRedemption(pairing({ tenant_id: 'tenant-B' }), { tenantId: T, deviceId: D, storageRootId: R, now }),
    ).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
  });
  it('an already-consumed pairing is rejected (single-use)', () => {
    expect(
      evaluateStoragePairingRedemption(pairing({ consumed_at: past }), { tenantId: T, deviceId: D, storageRootId: R, now }),
    ).toMatchObject({ ok: false, code: 'INVALID_NONCE' });
  });
  it('an expired pairing is rejected', () => {
    expect(
      evaluateStoragePairingRedemption(pairing({ expires_at: past }), { tenantId: T, deviceId: D, storageRootId: R, now }),
    ).toMatchObject({ ok: false, code: 'INVALID_NONCE' });
  });
  it('a device mismatch is rejected', () => {
    expect(
      evaluateStoragePairingRedemption(pairing(), { tenantId: T, deviceId: 'device-2', storageRootId: R, now }),
    ).toMatchObject({ ok: false, code: 'DEVICE_MISMATCH' });
  });
  it('a storage-root mismatch is rejected', () => {
    expect(
      evaluateStoragePairingRedemption(pairing(), { tenantId: T, deviceId: D, storageRootId: 'root-2', now }),
    ).toMatchObject({ ok: false, code: 'STORAGE_ROOT_MISMATCH' });
  });
});

describe('storage session policy', () => {
  it('a valid session is accepted', () => {
    expect(evaluateStorageSession(session(), { tenantId: T, now })).toEqual({ ok: true });
  });
  it('a missing session is rejected', () => {
    expect(evaluateStorageSession(null, { tenantId: T, now })).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });
  it('a different tenant is rejected', () => {
    expect(evaluateStorageSession(session({ tenant_id: 'tenant-B' }), { tenantId: T, now })).toMatchObject({
      ok: false,
      code: 'TENANT_MISMATCH',
    });
  });
  it('a revoked session is rejected', () => {
    expect(evaluateStorageSession(session({ revoked_at: past }), { tenantId: T, now })).toMatchObject({
      ok: false,
      code: 'AGENT_REVOKED',
    });
  });
  it('an expired session is rejected', () => {
    expect(evaluateStorageSession(session({ expires_at: past }), { tenantId: T, now })).toMatchObject({
      ok: false,
      code: 'SESSION_EXPIRED',
    });
  });
  it('an asserted device mismatch is rejected', () => {
    expect(evaluateStorageSession(session(), { tenantId: T, now, deviceId: 'device-2' })).toMatchObject({
      ok: false,
      code: 'DEVICE_MISMATCH',
    });
  });
  it('an asserted storage-root mismatch is rejected', () => {
    expect(evaluateStorageSession(session(), { tenantId: T, now, storageRootId: 'root-2' })).toMatchObject({
      ok: false,
      code: 'STORAGE_ROOT_MISMATCH',
    });
  });
});
