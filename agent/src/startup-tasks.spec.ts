import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DpapiError } from './dpapi';
import {
  ControlPlaneHttpError,
  EnrollmentRequiredError,
  UnexpectedServerResponseError,
  createFileCredentialStore,
  type GatewayControlPlaneClient,
  type PersistedCredential,
} from './enrollment';
import { hasDeenrollRequest, readPendingEnrollment, writeDeenrollRequest, writePendingEnrollment } from './pending-enrollment';
import { appendPendingSource, readSourcesFile, writeSourcesFile, type SecretProtector } from './sources-file';
import { classifyEnrollmentFailure, isRetryableEnrollmentError, prepareSources, processDeenrollRequest } from './startup-tasks';
import type { GatewaySourceConfig } from './connectors/registry';
import { TransportError } from './transport';

const CRED: PersistedCredential = { tenantId: 't', deviceId: 'd', deviceToken: 'device-TOKEN-xyz', enrolledAt: '2026-01-01T00:00:00Z' };

/** MOCKED protector with an identity, like DPAPI CurrentUser scope. */
function fakeProtector(identity = 'svc'): SecretProtector {
  return {
    scheme: 'dpapi-user',
    protect: (p) => Buffer.from(`${identity}|${p}`).toString('hex'),
    unprotect: (c) => {
      const [who, ...rest] = Buffer.from(c, 'hex').toString().split('|');
      if (who !== identity) throw new DpapiError('wrong identity');
      return rest.join('|');
    },
  };
}

function fakeClient(deenroll: jest.Mock): GatewayControlPlaneClient {
  return { deenroll } as unknown as GatewayControlPlaneClient;
}

describe('enrollment failure classification', () => {
  it.each([
    [new ControlPlaneHttpError(401, null), 'CODE_REJECTED', false],
    [new ControlPlaneHttpError(403, null), 'CODE_REJECTED', false],
    [new ControlPlaneHttpError(410, null), 'CODE_REJECTED', false],
    [new ControlPlaneHttpError(503, null), 'BACKEND_UNREACHABLE', true],
    [new ControlPlaneHttpError(429, null), 'BACKEND_UNREACHABLE', true],
    [new TypeError('fetch failed'), 'BACKEND_UNREACHABLE', true],
    [new DpapiError('x'), 'CREDENTIAL_UNREADABLE', false],
    [new Error('Corrupt Gateway credential file at C:\\x'), 'CREDENTIAL_UNREADABLE', false],
    // Phase 4: transport failures (see transport.ts)
    [new TransportError('PROXY_AUTH_FAILED', 'm', true, false, 'HTTP 407'), 'PROXY_AUTH_FAILED', false],
    [new TransportError('PROXY_UNREACHABLE', 'm', true, true, 'ECONNREFUSED'), 'PROXY_UNREACHABLE', true],
    [new TransportError('PROXY_REFUSED', 'm', true, false, 'HTTP 403'), 'PROXY_UNREACHABLE', false],
    [new TransportError('TLS_UNTRUSTED', 'm', false, false, 'SELF_SIGNED_CERT_IN_CHAIN'), 'TLS_CERTIFICATE_REJECTED', false],
    [new TransportError('TLS_HOSTNAME_MISMATCH', 'm', true, false, null), 'TLS_CERTIFICATE_REJECTED', false],
    [new TransportError('DNS_FAILED', 'm', false, true, 'ENOTFOUND'), 'BACKEND_UNREACHABLE', true],
    [new TransportError('TIMEOUT', 'm', false, true, 'ETIMEDOUT'), 'BACKEND_UNREACHABLE', true],
    // Phase 6: the wrong address (e.g. the dashboard's) is not a bad code and not worth retrying
    [new UnexpectedServerResponseError(404), 'WRONG_SERVER', false],
    [new UnexpectedServerResponseError(200), 'WRONG_SERVER', false],
    [new ControlPlaneHttpError(404, null), 'WRONG_SERVER', false],
    [new ControlPlaneHttpError(405, null), 'WRONG_SERVER', false],
  ])('%p -> %s (retryable: %s)', (err, code, retryable) => {
    expect(classifyEnrollmentFailure(err)).toBe(code);
    expect(isRetryableEnrollmentError(err)).toBe(retryable);
  });

  it('"not paired yet" is not an error and is not retried', () => {
    expect(classifyEnrollmentFailure(new EnrollmentRequiredError())).toBeNull();
    expect(isRetryableEnrollmentError(new EnrollmentRequiredError())).toBe(false);
  });
});

describe('processDeenrollRequest — "Remove Gateway" performed by the service under its own identity', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'dpdp-deenroll-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does nothing without a request', async () => {
    const store = createFileCredentialStore(dir);
    store.save(CRED);
    const call = jest.fn();
    expect(await processDeenrollRequest({ stateDir: dir, credentialStore: store, client: fakeClient(call), log: () => {} })).toEqual({
      requested: false,
      backendNotified: false,
    });
    expect(call).not.toHaveBeenCalled();
    expect(store.load()).toEqual(CRED);
  });

  it('calls the backend with the device token, then clears credential, pending code and the request', async () => {
    const store = createFileCredentialStore(dir);
    store.save(CRED);
    writePendingEnrollment(dir, { enrollmentCode: 'abcdefgh123' });
    writeDeenrollRequest(dir);
    const call = jest.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const out = await processDeenrollRequest({ stateDir: dir, credentialStore: store, client: fakeClient(call), log: (l) => lines.push(l) });
    expect(out).toEqual({ requested: true, backendNotified: true });
    expect(call).toHaveBeenCalledWith(CRED.deviceToken);
    expect(store.load()).toBeNull();
    expect(readPendingEnrollment(dir)).toBeNull();
    expect(hasDeenrollRequest(dir)).toBe(false);
    expect(lines.join('\n')).not.toContain(CRED.deviceToken);
  });

  it('backend unreachable: still clears locally and tells the user to revoke from the dashboard', async () => {
    const store = createFileCredentialStore(dir);
    store.save(CRED);
    writeDeenrollRequest(dir);
    const lines: string[] = [];
    const out = await processDeenrollRequest({
      stateDir: dir,
      credentialStore: store,
      client: fakeClient(jest.fn().mockRejectedValue(new Error('offline'))),
      log: (l) => lines.push(l),
    });
    expect(out.backendNotified).toBe(false);
    expect(store.load()).toBeNull();
    expect(lines.join('\n')).toMatch(/Revoke this device/);
  });

  it('an undecryptable credential is still cleared locally (no crash, no backend call)', async () => {
    writeFileSync(path.join(dir, 'device-credential.json'), 'not json');
    writeDeenrollRequest(dir);
    const call = jest.fn();
    const store = createFileCredentialStore(dir);
    await processDeenrollRequest({ stateDir: dir, credentialStore: store, client: fakeClient(call), log: () => {} });
    expect(call).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, 'device-credential.json'))).toBe(false);
  });
});

describe('prepareSources — service-side apply, migrate, load (MOCKED protector)', () => {
  let dir: string;
  let file: string;
  const PG: GatewaySourceConfig = {
    sourceId: 'crm',
    kind: 'postgresql',
    connection: { host: 'h', port: 5432, user: 'u', password: 'PW-SECRET', database: 'd' },
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dpdp-prep-'));
    file = path.join(dir, 'sources.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('applies queued sources and migrates a legacy file in one start', () => {
    writeFileSync(file, JSON.stringify([{ sourceId: 'csv1', kind: 'csv', roots: ['D:\\x'] }]));
    appendPendingSource(dir, PG);
    const lines: string[] = [];
    const out = prepareSources({ stateDir: dir, sourcesFilePath: file, env: {}, protector: fakeProtector(), log: (l) => lines.push(l) });
    expect(out.error).toBeNull();
    expect(out.sources.map((s) => s.sourceId).sort()).toEqual(['crm', 'csv1']);
    expect(readFileSync(file, 'utf8')).not.toContain('PW-SECRET');
    expect(readSourcesFile(file, fakeProtector()).storage).toBe('protected');
    expect(lines.join('\n')).not.toContain('PW-SECRET');
  });

  it('undecryptable sources: starts with NO sources, reports UNDECRYPTABLE, leaves the file and the queue intact', () => {
    writeSourcesFile(file, [PG], fakeProtector('old'));
    const before = readFileSync(file, 'utf8');
    appendPendingSource(dir, { ...PG, sourceId: 'second' });
    const out = prepareSources({ stateDir: dir, sourcesFilePath: file, env: {}, protector: fakeProtector('new'), log: () => {} });
    expect(out).toEqual({ sources: [], error: 'UNDECRYPTABLE' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(path.join(dir, 'pending-sources.json'))).toBe(true);
  });

  it('GATEWAY_SOURCES set: the file and the queue are ignored entirely', () => {
    appendPendingSource(dir, PG);
    const env = { GATEWAY_SOURCES: JSON.stringify([{ sourceId: 'envsrc', kind: 'csv', roots: ['/x'] }]) };
    const out = prepareSources({ stateDir: dir, sourcesFilePath: file, env, protector: fakeProtector(), log: () => {} });
    expect(out.sources.map((s) => s.sourceId)).toEqual(['envsrc']);
    expect(existsSync(path.join(dir, 'pending-sources.json'))).toBe(true);
  });

  it('an invalid GATEWAY_SOURCES env var is still fatal (operator configuration error)', () => {
    expect(() => prepareSources({ stateDir: dir, sourcesFilePath: file, env: { GATEWAY_SOURCES: '{nope' }, protector: null, log: () => {} })).toThrow(
      /GATEWAY_SOURCES/,
    );
  });
});
