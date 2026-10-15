import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaimedSubmission, GatewayControlPlaneClient } from '../enrollment';
import { startDeliveryPoller } from './poller';

function freshRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-delivery-test-'));
}

/** Polls a real condition with real timers — used only by the one test that
 *  exercises real fs/promises I/O, which fake timers cannot advance. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const READY: Extract<ClaimedSubmission, { ready: true }> = {
  ready: true,
  deliveryId: 'delivery-1',
  folderName: 'Acme Customer',
  customerId: 'cust-1',
  subjectRef: 'subject-1',
  displayName: 'Acme Customer',
  templateName: 'Marketing Consent',
  retentionMonths: 12,
  fields: [{ label: 'Email', textValue: 'test@example.com' }],
};

function fakeClient(overrides: Partial<GatewayControlPlaneClient> = {}): GatewayControlPlaneClient {
  return {
    enroll: jest.fn(),
    heartbeat: jest.fn(),
    refreshSession: jest.fn(),
    deenroll: jest.fn(),
    redeemPairing: jest.fn(),
    redeemStoragePairing: jest.fn(),
    listPendingSubmissions: jest.fn(),
    claimSubmission: jest.fn().mockResolvedValue({ ready: false, reason: 'NOTHING_PENDING' }),
    ackSubmission: jest.fn().mockResolvedValue({ ok: true }),
    failSubmission: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as GatewayControlPlaneClient;
}

describe('delivery poller — overlap safety and lifecycle (Phase 1)', () => {
  let root: string;
  beforeEach(() => {
    root = freshRoot();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('claims, writes to the local filesystem, and acks on success — runs once immediately', async () => {
    // Real timers for this one: the write path goes through real fs/promises
    // I/O, which fake timers don't advance (they only control setTimeout/
    // setInterval, not the libuv I/O the real file writes complete on).
    jest.useRealTimers();
    const client = fakeClient({
      claimSubmission: jest
        .fn()
        .mockResolvedValueOnce(READY)
        .mockResolvedValue({ ready: false, reason: 'NOTHING_PENDING' }),
    });
    const profilePath = path.join(root, 'Customers', 'Acme Customer', 'Customer Information', 'profile.json');
    const stop = startDeliveryPoller({
      client,
      deviceToken: 'device-token',
      pollIntervalSeconds: 60,
      localRootConfig: { electronConfigPath: null, fallbackRoot: root },
      log: () => {},
    });

    await waitUntil(() => (client.ackSubmission as jest.Mock).mock.calls.length > 0);

    expect(client.ackSubmission).toHaveBeenCalledWith('device-token', 'delivery-1');
    expect(existsSync(profilePath)).toBe(true);
    const written = readFileSync(profilePath, 'utf8');
    expect(JSON.parse(written)).toMatchObject({ customerId: 'cust-1', subjectRef: 'subject-1' });
    stop();
    jest.useFakeTimers();
  });

  it('never overlaps: a slow claim/write cycle is not joined by a second concurrent tick', async () => {
    let resolveClaim: ((v: ClaimedSubmission) => void) | undefined;
    const claimSubmission = jest.fn(
      () =>
        new Promise<ClaimedSubmission>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const client = fakeClient({ claimSubmission });
    const stop = startDeliveryPoller({
      client,
      deviceToken: 'device-token',
      pollIntervalSeconds: 5,
      localRootConfig: { electronConfigPath: null, fallbackRoot: root },
      log: () => {},
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(claimSubmission).toHaveBeenCalledTimes(1);

    // Multiple poll intervals elapse while the first claim is still
    // unresolved — no second concurrent claim is made.
    await jest.advanceTimersByTimeAsync(20_000);
    expect(claimSubmission).toHaveBeenCalledTimes(1);

    resolveClaim?.({ ready: false, reason: 'NOTHING_PENDING' });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(claimSubmission).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reports a write failure via failSubmission with a sanitized reason, never a field value', async () => {
    const badRoot = path.join(root, 'does-not-exist-and-unwritable-\0');
    const client = fakeClient({
      claimSubmission: jest
        .fn()
        .mockResolvedValueOnce(READY)
        .mockResolvedValue({ ready: false, reason: 'NOTHING_PENDING' }),
    });
    const stop = startDeliveryPoller({
      client,
      deviceToken: 'device-token',
      pollIntervalSeconds: 60,
      localRootConfig: { electronConfigPath: null, fallbackRoot: badRoot },
      log: () => {},
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(client.failSubmission).toHaveBeenCalledTimes(1);
    const [deviceToken, deliveryId, reason] = (client.failSubmission as jest.Mock).mock.calls[0];
    expect(deviceToken).toBe('device-token');
    expect(deliveryId).toBe('delivery-1');
    expect(reason).not.toContain('test@example.com'); // the field value must never leak into the reason
    expect(client.ackSubmission).not.toHaveBeenCalled();
    stop();
  });

  it('stop() prevents any further ticks', async () => {
    const client = fakeClient();
    const stop = startDeliveryPoller({
      client,
      deviceToken: 'device-token',
      pollIntervalSeconds: 5,
      localRootConfig: { electronConfigPath: null, fallbackRoot: root },
      log: () => {},
    });
    await jest.advanceTimersByTimeAsync(0);
    const callsBeforeStop = (client.claimSubmission as jest.Mock).mock.calls.length;
    stop();
    await jest.advanceTimersByTimeAsync(30_000);
    expect((client.claimSubmission as jest.Mock).mock.calls.length).toBe(callsBeforeStop);
  });
});
