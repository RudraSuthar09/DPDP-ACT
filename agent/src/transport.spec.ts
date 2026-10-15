/**
 * The shared transport, exercised with REAL undici, REAL TLS (test CA from
 * __fixtures__/tls) and REAL sockets against LOCAL MOCK servers
 * (__fixtures__/mock-network.ts). The mock proxy is a simulation of a
 * standards-compliant CONNECT proxy, not a real corporate proxy product.
 */
import { networkInterfaces } from 'node:os';
import { createControlPlaneClient, ControlPlaneHttpError, type GatewayControlPlaneClient } from './enrollment';
import { resolveProxySettings, type FileProxyConfig, type ProxyCredentials } from './network-config';
import { buildTrustedCaList } from './tls-trust';
import { classifyTransportError, createTransport, TransportError, type Transport } from './transport';
import { closedPort, startMockBackend, startMockProxy, TEST_CA_PEM, TUNNEL_HOST, type MockBackend, type MockProxy } from './__fixtures__/mock-network';

const PROXY_USER = 'svc-gateway';
const PROXY_PW = 'Pr0xy-PW-do-not-log';
const TRUST_TEST_CA = buildTrustedCaList({ extraCaCertificates: [TEST_CA_PEM], useWindowsCertificateStore: false });

const transports: Transport[] = [];
function client(
  baseUrl: string,
  opts: { proxy?: FileProxyConfig; env?: NodeJS.ProcessEnv; creds?: ProxyCredentials | null; ca?: string[] | undefined },
): GatewayControlPlaneClient {
  const transport = createTransport({ proxy: resolveProxySettings(opts.proxy, opts.env ?? {}, opts.creds ?? null), ca: opts.ca });
  transports.push(transport);
  return createControlPlaneClient(baseUrl, transport);
}

async function failure(p: Promise<unknown>): Promise<TransportError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError);
    return e as TransportError;
  }
  throw new Error('expected the call to fail');
}

function expectRedacted(err: Error, ...secrets: string[]): void {
  const text = `${err.message} ${JSON.stringify(err)}`;
  for (const s of secrets) expect(text).not.toContain(s);
}

afterAll(async () => {
  await Promise.all(transports.map((t) => t.close()));
});

describe('direct HTTPS (no proxy)', () => {
  let backend: MockBackend;
  let wrongHost: MockBackend;
  beforeAll(async () => {
    backend = await startMockBackend({ tls: 'localhost' });
    wrongHost = await startMockBackend({ tls: 'wrong-host' });
  });
  afterAll(async () => {
    await backend.close();
    await wrongHost.close();
  });

  it('succeeds when the test CA is added via the trust list (corporate-CA scenario)', async () => {
    await client(`https://localhost:${backend.port}`, { ca: TRUST_TEST_CA }).heartbeat('device-token-x', '0.1.0');
    expect(backend.requests.at(-1)).toMatchObject({ method: 'POST', path: '/gateway/heartbeat' });
  });

  it('an untrusted certificate is FATAL: TLS_UNTRUSTED, not retryable, no request delivered', async () => {
    const before = backend.requests.length;
    const err = await failure(client(`https://localhost:${backend.port}`, { ca: undefined }).heartbeat('t', '0.1.0'));
    expect(err.code).toBe('TLS_UNTRUSTED');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/tls\.extraCaCertsFile/);
    expect(err.message).toMatch(/never disabled/);
    expect(backend.requests.length).toBe(before);
  });

  it('a hostname mismatch is FATAL even when the issuing CA is trusted', async () => {
    const err = await failure(client(`https://localhost:${wrongHost.port}`, { ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0'));
    expect(err.code).toBe('TLS_HOSTNAME_MISMATCH');
    expect(err.retryable).toBe(false);
    expect(wrongHost.requests.length).toBe(0);
  });

  it('an HTTP error response is still a ControlPlaneHttpError with its status (behaviour unchanged)', async () => {
    const http = await startMockBackend({ tls: null, statusFor: { '/gateway/heartbeat': 401 } });
    try {
      const err = await client(`http://127.0.0.1:${http.port}`, {})
        .heartbeat('t', '0.1.0')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ControlPlaneHttpError);
      expect((err as ControlPlaneHttpError).status).toBe(401);
    } finally {
      await http.close();
    }
  });

  it('a refused connection is CONNECT_FAILED and retryable', async () => {
    const port = await closedPort();
    const err = await failure(client(`http://127.0.0.1:${port}`, {}).heartbeat('t', '0.1.0'));
    expect(err.code).toBe('CONNECT_FAILED');
    expect(err.retryable).toBe(true);
    expect(err.viaProxy).toBe(false);
  });
});

describe('through a proxy (HTTP CONNECT tunnel)', () => {
  let backend: MockBackend;
  let open: MockProxy;
  let authed: MockProxy;
  let refusing: MockProxy;
  beforeAll(async () => {
    backend = await startMockBackend({ tls: 'localhost' });
    open = await startMockProxy();
    authed = await startMockProxy({ auth: { username: PROXY_USER, password: PROXY_PW } });
    refusing = await startMockProxy({ forceStatus: 403 });
  });
  afterAll(async () => {
    await Promise.all([backend.close(), open.close(), authed.close(), refusing.close()]);
  });
  const target = (): string => `https://${TUNNEL_HOST}:${backend.port}`;

  it('enrollment, heartbeat and submission-delivery calls all go through the tunnel', async () => {
    const c = client(target(), { proxy: { url: open.url }, ca: TRUST_TEST_CA });
    const enrolled = await c.enroll({
      enrollmentCode: 'enrol-code-123456',
      publicKey: 'pk',
      platform: 'windows',
      agentVersion: '0.1.0',
      displayName: 'n',
      deviceRef: null,
    });
    expect(enrolled).toMatchObject({ deviceId: 'device-test', tenantId: 'tenant-test' });
    await c.heartbeat(enrolled.deviceToken, '0.1.0');
    await c.listPendingSubmissions(enrolled.deviceToken);
    await c.claimSubmission(enrolled.deviceToken);
    await c.ackSubmission(enrolled.deviceToken, 'd1');

    expect(open.connects.length).toBeGreaterThanOrEqual(1);
    expect(open.connects.every((x) => x.target === `${TUNNEL_HOST}:${backend.port}`)).toBe(true);
    expect(backend.requests.map((r) => r.path)).toEqual(
      expect.arrayContaining(['/gateway/enroll', '/gateway/heartbeat', '/gateway/submissions/pending', '/gateway/submissions/claim', '/gateway/submissions/d1/ack']),
    );
  });

  it('TLS is end to end: the proxy never sees the device token or the enrolment code', () => {
    const seen = open.tunnelledBytes().toString('latin1');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(backend.deviceToken);
    expect(seen).not.toContain('enrol-code-123456');
    expect(seen).not.toContain('x-gateway-device-token');
  });

  it('sends Basic credentials to the proxy (only) when configured', async () => {
    await client(target(), { proxy: { url: authed.url }, creds: { username: PROXY_USER, password: PROXY_PW }, ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0');
    expect(authed.connects.at(-1)?.proxyAuthorization).toBe(`Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PW}`).toString('base64')}`);
    const last = backend.requests.at(-1)!;
    expect(last.headers['proxy-authorization']).toBeUndefined();
    expect(JSON.stringify(last.headers)).not.toContain(PROXY_PW);
  });

  it('env HTTPS_PROXY user info works the same way', async () => {
    const url = `http://${PROXY_USER}:${encodeURIComponent(PROXY_PW)}@127.0.0.1:${authed.port}`;
    await client(target(), { env: { HTTPS_PROXY: url }, ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0');
    expect(authed.connects.at(-1)?.proxyAuthorization).toMatch(/^Basic /);
  });

  it('missing/wrong proxy credentials: PROXY_AUTH_FAILED, not retryable, redacted, no bypass', async () => {
    const before = backend.requests.length;
    const err = await failure(
      client(target(), { proxy: { url: authed.url }, creds: { username: PROXY_USER, password: 'wrong-pw' }, ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0'),
    );
    expect(err.code).toBe('PROXY_AUTH_FAILED');
    expect(err.retryable).toBe(false);
    expect(err.viaProxy).toBe(true);
    expectRedacted(err, PROXY_PW, 'wrong-pw', PROXY_USER, String(authed.port), TUNNEL_HOST);
    expect(backend.requests.length).toBe(before);
  });

  it('a proxy that refuses the tunnel: PROXY_REFUSED, no bypass', async () => {
    const before = backend.requests.length;
    const err = await failure(client(target(), { proxy: { url: refusing.url }, ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0'));
    expect(err.code).toBe('PROXY_REFUSED');
    expect(err.detail).toBe('HTTP 403');
    expect(backend.requests.length).toBe(before);
  });

  it('a proxy that is down: PROXY_UNREACHABLE, retryable, and NO direct fallback', async () => {
    const before = backend.requests.length;
    const err = await failure(client(target(), { proxy: { url: `http://127.0.0.1:${await closedPort()}` }, ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0'));
    expect(err.code).toBe('PROXY_UNREACHABLE');
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/does not fall back to a direct connection/);
    expect(backend.requests.length).toBe(before);
  });

  it('a proxy that drops the connection without answering fails ONCE (no retry storm, no bypass)', async () => {
    const dropping = await startMockProxy({ dropConnections: true });
    try {
      const before = backend.requests.length;
      const err = await failure(client(target(), { proxy: { url: dropping.url }, ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0'));
      expect(['PROXY_UNREACHABLE', 'NETWORK_ERROR']).toContain(err.code);
      expect(dropping.connects.length).toBeLessThanOrEqual(2);
      expect(backend.requests.length).toBe(before);
    } finally {
      await dropping.close();
    }
  });

  it('TLS through the tunnel is still verified: an untrusted server certificate is fatal', async () => {
    const err = await failure(client(target(), { proxy: { url: open.url }, ca: undefined }).heartbeat('t', '0.1.0'));
    expect(err.code).toBe('TLS_UNTRUSTED');
    expect(err.viaProxy).toBe(true);
  });

  it('loopback destinations bypass the proxy entirely', async () => {
    const connectsBefore = open.connects.length;
    await client(`https://localhost:${backend.port}`, { proxy: { url: open.url }, ca: TRUST_TEST_CA }).heartbeat('t', '0.1.0');
    expect(open.connects.length).toBe(connectsBefore);
  });
});

// A real non-loopback destination (this machine's LAN address), so "direct"
// genuinely means "around the proxy" and NO_PROXY is meaningful.
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const lanDescribe = lanIp ? describe : describe.skip;

lanDescribe('NO_PROXY and no-fallback against a non-loopback destination', () => {
  let backend: MockBackend;
  let proxy: MockProxy;
  beforeAll(async () => {
    backend = await startMockBackend({ tls: null, host: lanIp });
    proxy = await startMockProxy();
  });
  afterAll(async () => {
    await Promise.all([backend.close(), proxy.close()]);
  });

  it('without NO_PROXY the request goes through the proxy', async () => {
    await client(`http://${lanIp}:${backend.port}`, { proxy: { url: proxy.url } }).heartbeat('t', '0.1.0');
    expect(proxy.connects.at(-1)?.target).toBe(`${lanIp}:${backend.port}`);
  });

  it('an excluded destination (NO_PROXY CIDR) connects directly; the proxy sees nothing', async () => {
    const before = proxy.connects.length;
    await client(`http://${lanIp}:${backend.port}`, { env: { HTTP_PROXY: proxy.url, NO_PROXY: `${lanIp}/32` } }).heartbeat('t', '0.1.0');
    expect(proxy.connects.length).toBe(before);
    expect(backend.requests.at(-1)?.path).toBe('/gateway/heartbeat');
  });

  it('a configured proxy that is down is NEVER bypassed, although the destination is directly reachable', async () => {
    const before = backend.requests.length;
    const err = await failure(client(`http://${lanIp}:${backend.port}`, { proxy: { url: `http://127.0.0.1:${await closedPort()}` } }).heartbeat('t', '0.1.0'));
    expect(err.code).toBe('PROXY_UNREACHABLE');
    expect(backend.requests.length).toBe(before);
  });
});

describe('classifyTransportError (synthetic undici-shaped errors)', () => {
  const wrap = (cause: object): Error => Object.assign(new TypeError('fetch failed'), { cause });

  it.each([
    [{ code: 'ENOTFOUND' }, false, 'DNS_FAILED'],
    [{ code: 'ENOTFOUND' }, true, 'PROXY_UNREACHABLE'],
    [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, false, 'TIMEOUT'],
    [{ code: 'ECONNRESET' }, false, 'CONNECT_FAILED'],
    [{ code: 'CERT_HAS_EXPIRED' }, false, 'TLS_UNTRUSTED'],
    [{ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }, true, 'TLS_FAILED'],
    [{ message: 'Proxy response (407) !== 200 when HTTP Tunneling' }, true, 'PROXY_AUTH_FAILED'],
    [{ message: 'Proxy response (502) !== 200 when HTTP Tunneling' }, true, 'PROXY_REFUSED'],
    [{}, false, 'NETWORK_ERROR'],
  ])('%j (viaProxy=%s) -> %s', (cause, viaProxy, code) => {
    expect(classifyTransportError(wrap(cause), viaProxy).code).toBe(code);
  });

  it('a 502 from the proxy is retryable; a 403 is not', () => {
    expect(classifyTransportError(wrap({ message: 'Proxy response (502) !== 200 when HTTP Tunneling' }), true).retryable).toBe(true);
    expect(classifyTransportError(wrap({ message: 'Proxy response (403) !== 200 when HTTP Tunneling' }), true).retryable).toBe(false);
  });

  it('never copies a low-level message (which could carry a URL) into its own', () => {
    const err = classifyTransportError(wrap({ code: 'ECONNREFUSED', message: `connect to http://u:${PROXY_PW}@p.corp:1 failed` }), true);
    expectRedacted(err, PROXY_PW, 'p.corp');
  });
});

it('transport.summary exposes labels and counts only', () => {
  const t = createTransport({
    proxy: resolveProxySettings({ url: 'http://p.corp:3128', noProxy: ['a.example', 'b.example'] }, {}, { username: 'u', password: PROXY_PW }),
    ca: TRUST_TEST_CA,
  });
  transports.push(t);
  expect(t.summary).toEqual({ proxy: 'config', proxyAuthentication: true, noProxyRules: 2, customTrust: true });
  expect(JSON.stringify(t.summary)).not.toMatch(/p\.corp|3128|Pr0xy/);
});
