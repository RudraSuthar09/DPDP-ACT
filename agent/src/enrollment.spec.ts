import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPersistedCredential,
  savePersistedCredential,
  clearPersistedCredential,
  ensureEnrolled,
  startHeartbeat,
  deenroll,
  EnrollmentRequiredError,
  ControlPlaneHttpError,
  type GatewayControlPlaneClient,
  type PersistedCredential,
} from './enrollment';

function freshStateDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-gateway-test-'));
}

const CRED: PersistedCredential = {
  tenantId: 'tenant-1',
  deviceId: 'device-1',
  deviceToken: 'header.payload.signature',
  enrolledAt: '2026-01-01T00:00:00.000Z',
};

function fakeClient(overrides: Partial<GatewayControlPlaneClient> = {}): GatewayControlPlaneClient {
  return {
    enroll: jest.fn().mockResolvedValue({ deviceId: CRED.deviceId, tenantId: CRED.tenantId, deviceToken: CRED.deviceToken }),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    refreshSession: jest.fn().mockResolvedValue({ sessionToken: 'x', expiresAt: '2026-01-01T00:00:00.000Z' }),
    deenroll: jest.fn().mockResolvedValue(undefined),
    redeemPairing: jest.fn().mockResolvedValue({ sessionToken: 'x', expiresAt: '2026-01-01T00:00:00.000Z' }),
    redeemStoragePairing: jest.fn().mockResolvedValue({ sessionToken: 'x', expiresAt: '2026-01-01T00:00:00.000Z' }),
    ...overrides,
  };
}

describe('Phase 3C — local credential persistence (agent-side enrollment)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = freshStateDir();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('1. no persisted credential yet -> loadPersistedCredential returns null, not an error', () => {
    expect(loadPersistedCredential(stateDir)).toBeNull();
  });

  it('2. save -> load round-trips exactly, and the file is written under stateDir', () => {
    savePersistedCredential(stateDir, CRED);
    expect(existsSync(path.join(stateDir, 'device-credential.json'))).toBe(true);
    expect(loadPersistedCredential(stateDir)).toEqual(CRED);
  });

  it('3. clearPersistedCredential removes the file; a subsequent load is null again', () => {
    savePersistedCredential(stateDir, CRED);
    clearPersistedCredential(stateDir);
    expect(loadPersistedCredential(stateDir)).toBeNull();
  });

  it('clearPersistedCredential on an already-clear dir does not throw', () => {
    expect(() => clearPersistedCredential(stateDir)).not.toThrow();
  });

  it('a corrupt/incomplete credential file throws (never silently treated as "not enrolled")', () => {
    writeFileSync(path.join(stateDir, 'device-credential.json'), JSON.stringify({ tenantId: 'only-this' }));
    expect(() => loadPersistedCredential(stateDir)).toThrow(/Corrupt Gateway credential file/);
  });
});

describe('Phase 3C — ensureEnrolled (the missing enrollment handshake)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = freshStateDir();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('5/9. a persisted credential is reused — the enrollment code is never asked for again', async () => {
    savePersistedCredential(stateDir, CRED);
    const client = fakeClient();
    const result = await ensureEnrolled({
      stateDir,
      client,
      enrollmentCode: null, // no code supplied — must not be needed
      platform: 'linux',
      agentVersion: '1.0.0',
      displayName: 'test-device',
      log: () => {},
    });
    expect(result).toEqual(CRED);
    expect(client.enroll).not.toHaveBeenCalled();
  });

  it('1/2/3/4. with no persisted credential, a supplied one-time code redeems via POST /gateway/enroll (through the client) and the result is persisted', async () => {
    const client = fakeClient();
    const result = await ensureEnrolled({
      stateDir,
      client,
      enrollmentCode: 'ONE-TIME-CODE',
      platform: 'windows',
      agentVersion: '1.0.0',
      displayName: 'test-device',
      log: () => {},
    });
    expect(client.enroll).toHaveBeenCalledTimes(1);
    const call = (client.enroll as jest.Mock).mock.calls[0][0];
    expect(call.enrollmentCode).toBe('ONE-TIME-CODE');
    expect(call.platform).toBe('windows');
    expect(call.displayName).toBe('test-device');
    // A real, well-formed PEM public key was generated and submitted — never a
    // private key, never empty.
    expect(call.publicKey).toContain('PUBLIC KEY');
    expect(call.publicKey).not.toContain('PRIVATE KEY');

    expect(result.deviceId).toBe(CRED.deviceId);
    expect(loadPersistedCredential(stateDir)).toEqual(result);
  });

  it('no persisted credential and no code -> EnrollmentRequiredError, and enroll() is never called', async () => {
    const client = fakeClient();
    await expect(
      ensureEnrolled({
        stateDir,
        client,
        enrollmentCode: null,
        platform: 'linux',
        agentVersion: '1.0.0',
        displayName: 'test-device',
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(EnrollmentRequiredError);
    expect(client.enroll).not.toHaveBeenCalled();
  });

  it('9. a used-up/rejected enrollment code surfaces as a clear failure, and nothing is persisted', async () => {
    const client = fakeClient({ enroll: jest.fn().mockRejectedValue(new ControlPlaneHttpError(401, { error: 'INVALID' })) });
    await expect(
      ensureEnrolled({
        stateDir,
        client,
        enrollmentCode: 'ALREADY-USED',
        platform: 'linux',
        agentVersion: '1.0.0',
        displayName: 'test-device',
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(ControlPlaneHttpError);
    expect(loadPersistedCredential(stateDir)).toBeNull();
  });
});

describe('Phase 3C — heartbeat lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('6. heartbeat fires on the configured interval using the persisted credential', () => {
    const client = fakeClient();
    const stop = startHeartbeat(client, CRED, '1.0.0', 30, () => {}, () => {});
    expect(client.heartbeat).not.toHaveBeenCalled();
    jest.advanceTimersByTime(30_000);
    expect(client.heartbeat).toHaveBeenCalledWith(CRED.deviceToken, '1.0.0');
    jest.advanceTimersByTime(30_000);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    stop();
    jest.advanceTimersByTime(60_000);
    expect(client.heartbeat).toHaveBeenCalledTimes(2); // no more ticks after stop()
  });

  it('a revoked/expired credential (401/403) triggers onAuthFailure; a transient failure does not', async () => {
    const authFailure = jest.fn();
    const rejecting = fakeClient({ heartbeat: jest.fn().mockRejectedValue(new ControlPlaneHttpError(403, { error: 'AGENT_REVOKED' })) });
    startHeartbeat(rejecting, CRED, '1.0.0', 10, () => {}, authFailure);
    jest.advanceTimersByTime(10_000);
    await Promise.resolve(); // let the rejected promise's .catch() run
    await Promise.resolve();
    expect(authFailure).toHaveBeenCalledTimes(1);

    const authFailure2 = jest.fn();
    const flaky = fakeClient({ heartbeat: jest.fn().mockRejectedValue(new Error('network blip')) });
    startHeartbeat(flaky, CRED, '1.0.0', 10, () => {}, authFailure2);
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(authFailure2).not.toHaveBeenCalled();
  });
});

describe('Phase 3C — de-enrollment (item 8: clean, and item 9: forces a fresh code next time)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = freshStateDir();
    savePersistedCredential(stateDir, CRED);
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('calls the backend de-enroll and clears the local credential', async () => {
    const client = fakeClient();
    const result = await deenroll(client, CRED, stateDir);
    expect(client.deenroll).toHaveBeenCalledWith(CRED.deviceToken);
    expect(result.backendNotified).toBe(true);
    expect(loadPersistedCredential(stateDir)).toBeNull();
  });

  it('still clears the local credential even if the backend call fails (best-effort local cleanup)', async () => {
    const client = fakeClient({ deenroll: jest.fn().mockRejectedValue(new Error('offline')) });
    const result = await deenroll(client, CRED, stateDir);
    expect(result.backendNotified).toBe(false);
    expect(loadPersistedCredential(stateDir)).toBeNull();
  });

  it('9. after de-enrollment, ensureEnrolled requires a NEW code — the old one is spent and nothing is cached', async () => {
    const client = fakeClient();
    await deenroll(client, CRED, stateDir);
    await expect(
      ensureEnrolled({
        stateDir,
        client,
        enrollmentCode: null,
        platform: 'linux',
        agentVersion: '1.0.0',
        displayName: 'test-device',
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(EnrollmentRequiredError);
  });
});
