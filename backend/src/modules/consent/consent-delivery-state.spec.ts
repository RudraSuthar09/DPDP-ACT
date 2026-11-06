import { deriveDeliveryState, type DeliveryRecord } from './consent-delivery-state';

const SYNCED = new Date('2026-10-01T00:00:00Z');
const central = (status: DeliveryRecord['status'], attemptCount = 1): DeliveryRecord => ({ target: null, status, attemptCount });
const copy = (root: string, status: DeliveryRecord['status'], attemptCount = 1): DeliveryRecord => ({ target: root, status, attemptCount });

describe('deriveDeliveryState — Central only (unchanged behaviour, no Enterprise copies)', () => {
  it.each([
    // [localSyncedAt, relay status, expected]
    [null, null, 'pending'], //            nothing staged, nothing confirmed yet
    [SYNCED, null, 'delivered'], //        a synchronous/browser write confirmed it
    [null, 'pending', 'pending'], //       staged, waiting for the agent
    [null, 'delivering', 'pending'], //    claimed, write in progress / retrying
    [SYNCED, 'pending', 'pending'], //     still delivering field values
    [null, 'delivered', 'delivered'], //   the agent confirmed the write
    [SYNCED, 'delivered', 'delivered'],
    [null, 'failed', 'failed'], //         retries exhausted, nothing confirmed
    [SYNCED, 'failed', 'partially_delivered'], // one path confirmed, the relay did not
  ] as const)('localSyncedAt=%s relay=%s -> %s', (localSyncedAt, relay, expected) => {
    expect(deriveDeliveryState({ localSyncedAt, deliveries: relay ? [central(relay)] : [] }).state).toBe(expected);
  });
});

describe('deriveDeliveryState — with Enterprise copies, each destination judged on its own', () => {
  it('Central stored + Enterprise copy stored -> delivered', () => {
    const d = deriveDeliveryState({ localSyncedAt: SYNCED, deliveries: [copy('r1', 'delivered')] });
    expect(d.state).toBe('delivered');
    expect(d.enterpriseCopies).toEqual({ total: 1, stored: 1, failed: 0 });
  });

  it('Central stored + Enterprise copy FAILED -> partially_delivered (consent unaffected)', () => {
    const d = deriveDeliveryState({ localSyncedAt: SYNCED, deliveries: [copy('r1', 'failed')] });
    expect(d.state).toBe('partially_delivered');
    expect(d.enterpriseCopies).toEqual({ total: 1, stored: 0, failed: 1 });
  });

  it('Enterprise copy stored + Central relay FAILED -> partially_delivered, never "delivered"', () => {
    expect(deriveDeliveryState({ localSyncedAt: null, deliveries: [central('failed'), copy('r1', 'delivered')] }).state).toBe('partially_delivered');
  });

  it('Enterprise copy stored, Central configured but not yet written -> pending (Central really is still owed)', () => {
    const d = deriveDeliveryState({ localSyncedAt: null, deliveries: [copy('r1', 'delivered')], centralConfigured: true });
    expect([d.state, d.central]).toEqual(['pending', 'pending']);
  });

  it('Enterprise copy stored and NO Central storage configured -> delivered, not stuck at pending forever', () => {
    const d = deriveDeliveryState({ localSyncedAt: null, deliveries: [copy('r1', 'delivered')], centralConfigured: false });
    expect([d.state, d.central]).toEqual(['delivered', 'not_configured']);
  });

  it('no Central storage configured: a Central relay queued with nowhere to go is not waited on (it is only claimable once Central exists)', () => {
    const d = deriveDeliveryState({ localSyncedAt: null, deliveries: [central('pending'), copy('r1', 'delivered')], centralConfigured: false });
    expect([d.state, d.central]).toEqual(['delivered', 'not_configured']);
    // ...but once Central IS configured, that same queued relay is owed again.
    expect(deriveDeliveryState({ localSyncedAt: null, deliveries: [central('pending'), copy('r1', 'delivered')], centralConfigured: true }).state).toBe('pending');
    const d2 = deriveDeliveryState({ localSyncedAt: null, deliveries: [copy('r1', 'failed')], centralConfigured: false });
    expect([d2.state, d2.central]).toEqual(['failed', 'not_configured']);
  });

  it('no Central storage and no Enterprise copy: still "pending" (waiting for connected storage), as before', () => {
    expect(deriveDeliveryState({ localSyncedAt: null, deliveries: [], centralConfigured: false }).state).toBe('pending');
  });

  it('Central that WAS written stays "stored" even if Central storage is later removed', () => {
    expect(deriveDeliveryState({ localSyncedAt: SYNCED, deliveries: [copy('r1', 'delivered')], centralConfigured: false }).central).toBe('stored');
  });

  it('Gateway offline: the Enterprise copy is still queued -> pending, with the retry count', () => {
    const d = deriveDeliveryState({ localSyncedAt: SYNCED, deliveries: [copy('r1', 'pending', 3)] });
    expect(d).toMatchObject({ state: 'pending', retryAttempts: 3 });
  });

  it('two destinations: one stored, one failed -> partially_delivered; both failed and Central failed -> failed', () => {
    expect(deriveDeliveryState({ localSyncedAt: SYNCED, deliveries: [copy('r1', 'delivered'), copy('r2', 'failed')] }).state).toBe('partially_delivered');
    expect(deriveDeliveryState({ localSyncedAt: null, deliveries: [central('failed'), copy('r1', 'failed'), copy('r2', 'failed')] }).state).toBe('failed');
  });

  it('anything still in progress keeps the whole submission pending', () => {
    expect(deriveDeliveryState({ localSyncedAt: SYNCED, deliveries: [copy('r1', 'failed'), copy('r2', 'delivering')] }).state).toBe('pending');
  });
});
