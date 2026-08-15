import {
  evaluateDeviceStatus,
  evaluateEnrollmentCode,
  evaluatePairingRedemption,
  evaluateSession,
  type PairingRow,
  type SessionRow,
} from './gateway-policy';

const T = 'tenant-A';
const D = 'device-1';
const S = 'source-1';
const now = new Date('2026-08-14T12:00:00Z');
const future = new Date('2026-08-14T13:00:00Z');
const past = new Date('2026-08-14T11:00:00Z');

function code(over: Partial<{ expires_at: Date; consumed_at: Date | null }> = {}) {
  return { expires_at: future, consumed_at: null, ...over };
}
function pairing(over: Partial<PairingRow> = {}): PairingRow {
  return { tenant_id: T, device_id: D, source_id: S, expires_at: future, consumed_at: null, ...over };
}
function session(over: Partial<SessionRow> = {}): SessionRow {
  return { tenant_id: T, device_id: D, source_id: S, user_id: 'u1', expires_at: future, revoked_at: null, ...over };
}

describe('Phase 3C — enrolment code policy', () => {
  it('1. a valid code is accepted', () => {
    expect(evaluateEnrollmentCode(code(), now)).toEqual({ ok: true });
  });
  it('2. a missing code is rejected (invalid enrolment)', () => {
    expect(evaluateEnrollmentCode(null, now)).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });
  it('6. an expired code is rejected', () => {
    expect(evaluateEnrollmentCode(code({ expires_at: past }), now)).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });
  it('7. an already-used code is rejected', () => {
    expect(evaluateEnrollmentCode(code({ consumed_at: past }), now)).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });
});

describe('Phase 3C — device status policy', () => {
  it('active device passes', () => expect(evaluateDeviceStatus({ status: 'active' })).toEqual({ ok: true }));
  it('9. revoked device fails closed', () =>
    expect(evaluateDeviceStatus({ status: 'revoked' })).toMatchObject({ ok: false, code: 'AGENT_REVOKED' }));
  it('removed device fails closed', () =>
    expect(evaluateDeviceStatus({ status: 'removed' })).toMatchObject({ ok: false, code: 'AGENT_REVOKED' }));
  it('unknown device is not enrolled', () =>
    expect(evaluateDeviceStatus(null)).toMatchObject({ ok: false, code: 'AGENT_NOT_ENROLLED' }));
});

describe('Phase 3C — pairing redemption policy', () => {
  const ctx = { tenantId: T, deviceId: D, sourceId: S, now };

  it('a valid pairing is accepted', () => {
    expect(evaluatePairingRedemption(pairing(), ctx)).toEqual({ ok: true });
  });
  it('missing pairing → INVALID_NONCE', () => {
    expect(evaluatePairingRedemption(null, ctx)).toMatchObject({ ok: false, code: 'INVALID_NONCE' });
  });
  it('3. tenant mismatch is rejected', () => {
    expect(evaluatePairingRedemption(pairing({ tenant_id: 'tenant-B' }), ctx)).toMatchObject({
      ok: false,
      code: 'TENANT_MISMATCH',
    });
  });
  it('7. reused pairing nonce → INVALID_NONCE', () => {
    expect(evaluatePairingRedemption(pairing({ consumed_at: past }), ctx)).toMatchObject({
      ok: false,
      code: 'INVALID_NONCE',
      reason: expect.stringContaining('already'),
    });
  });
  it('6. expired pairing nonce → INVALID_NONCE', () => {
    expect(evaluatePairingRedemption(pairing({ expires_at: past }), ctx)).toMatchObject({
      ok: false,
      code: 'INVALID_NONCE',
      reason: expect.stringContaining('expired'),
    });
  });
  it('5. device mismatch is rejected', () => {
    expect(evaluatePairingRedemption(pairing({ device_id: 'device-2' }), ctx)).toMatchObject({
      ok: false,
      code: 'DEVICE_MISMATCH',
    });
  });
  it('4. source mismatch is rejected', () => {
    expect(evaluatePairingRedemption(pairing({ source_id: 'source-2' }), ctx)).toMatchObject({
      ok: false,
      code: 'SOURCE_MISMATCH',
    });
  });
});

describe('Phase 3C — session policy', () => {
  const ctx = { tenantId: T, now, deviceId: D, sourceId: S };

  it('a valid session is accepted', () => expect(evaluateSession(session(), ctx)).toEqual({ ok: true }));
  it('10. a missing/invalid session → INVALID_TOKEN', () => {
    expect(evaluateSession(null, ctx)).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });
  it('8. an expired session → SESSION_EXPIRED', () => {
    expect(evaluateSession(session({ expires_at: past }), ctx)).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
  });
  it('a revoked session fails closed', () => {
    expect(evaluateSession(session({ revoked_at: past }), ctx)).toMatchObject({ ok: false, code: 'AGENT_REVOKED' });
  });
  it('3. tenant mismatch is rejected', () => {
    expect(evaluateSession(session({ tenant_id: 'tenant-B' }), ctx)).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
  });
  it('5. device mismatch is rejected', () => {
    expect(evaluateSession(session({ device_id: 'device-2' }), ctx)).toMatchObject({ ok: false, code: 'DEVICE_MISMATCH' });
  });
  it('4. source mismatch is rejected', () => {
    expect(evaluateSession(session({ source_id: 'source-2' }), ctx)).toMatchObject({ ok: false, code: 'SOURCE_MISMATCH' });
  });
});
