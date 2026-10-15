import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { GATEWAY_AUTH_HEADER } from '@dpdp/shared';
import { loadAgentConfig } from './config';
import { createAgentServer } from './server';
import { DEFAULT_NETWORK_SUMMARY } from './health';

const ALLOWED = 'https://app.test.example';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: Record<string, unknown> | null;
  text: string;
}

function httpReq(
  port: number,
  opts: { path?: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    // Set an explicit content-length when there is a body, so the oversized guard
    // (which reads the content-length header) sees the real size instead of the
    // chunked transfer-encoding Node would otherwise use.
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const req = request(
      { host: '127.0.0.1', port, path: opts.path ?? '/health', method: opts.method ?? 'GET', headers },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('Phase 3B — the Local Agent HTTP boundary', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const config = loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: ALLOWED });
    server = createAgentServer(config); // silent logger by default
    await new Promise<void>((resolve) => server.listen(0, config.bindHost, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('1/2. binds only to 127.0.0.1 (loopback), never 0.0.0.0', () => {
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.address).not.toBe('0.0.0.0');
  });

  it('3. GET /health responds 200 with metadata only', async () => {
    const r = await httpReq(port, { path: '/health' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'ok', networkMode: 'loopback' });
    expect(typeof r.json?.agentVersion).toBe('string');
    expect(typeof r.json?.protocolVersion).toBe('string');
  });

  it('(Phase 2) GET /health reports a disabled gateway status when no status provider is wired', async () => {
    const r = await httpReq(port, { path: '/health' });
    expect(r.json?.gateway).toEqual({
      enrolled: false,
      deviceId: null,
      heartbeat: null,
      lastHeartbeatAt: null,
      sourcesConfigured: 0,
      storageRootsConfigured: 0,
      sourceKinds: {},
      enrollmentError: null,
      sourcesError: null,
      credentialProtection: 'none',
      network: DEFAULT_NETWORK_SUMMARY,
    });
  });

  it('7/8. health response contains no secrets and no customer data', async () => {
    const r = await httpReq(port, { path: '/health' });
    // exactly the five safe metadata keys — nothing else leaks
    expect(Object.keys(r.json ?? {}).sort()).toEqual([
      'agentVersion',
      'gateway',
      'networkMode',
      'protocolVersion',
      'status',
    ]);
    // the gateway sub-object is non-secret metadata too, same discipline
    expect(Object.keys((r.json?.gateway ?? {}) as Record<string, unknown>).sort()).toEqual([
      'credentialProtection',
      'deviceId',
      'enrolled',
      'enrollmentError',
      'heartbeat',
      'lastHeartbeatAt',
      'network',
      'sourceKinds',
      'sourcesConfigured',
      'sourcesError',
      'storageRootsConfigured',
    ].sort());
    // and no forbidden token appears anywhere in the raw body
    for (const forbidden of ['token', 'secret', 'password', 'allowedOrigins', 'controlPlane', 'privateKey', 'env', 'aadhaar']) {
      expect(r.text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('4. an allowed Origin succeeds and is reflected EXACTLY (never "*")', async () => {
    const r = await httpReq(port, { path: '/health', headers: { origin: ALLOWED } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(r.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('5. a disallowed Origin fails (403), with no CORS reflection', async () => {
    const r = await httpReq(port, { path: '/health', headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'INVALID_ORIGIN' });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a similar-but-not-identical hostname is denied', async () => {
    const r = await httpReq(port, { path: '/health', headers: { origin: `${ALLOWED}.evil.com` } });
    expect(r.status).toBe(403);
  });

  it('Origin omitted is handled safely (liveness 200, no reflection)', async () => {
    const r = await httpReq(port, { path: '/health' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a malformed auth header (allowed Origin) fails 401', async () => {
    const r = await httpReq(port, {
      path: '/health',
      headers: { origin: ALLOWED, [GATEWAY_AUTH_HEADER]: 'x' },
    });
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ error: 'INVALID_TOKEN' });
  });

  it('a well-formed auth header (allowed Origin) passes the boundary', async () => {
    const r = await httpReq(port, {
      path: '/health',
      headers: { origin: ALLOWED, [GATEWAY_AUTH_HEADER]: 'abcDEF012345_token-value' },
    });
    expect(r.status).toBe(200);
  });

  it('9. no customer-data / future raw-data route exists (all 404)', async () => {
    for (const path of ['/source/read', '/source/discover', '/source/search', '/session/establish', '/pair/redeem', '/gateway/enroll']) {
      const r = await httpReq(port, { path, headers: { origin: ALLOWED } });
      expect(r.status).toBe(404);
    }
  });

  it('an oversized request is rejected (413) before handling', async () => {
    const r = await httpReq(port, { path: '/health', method: 'POST', body: 'x'.repeat(5000) });
    expect(r.status).toBe(413);
  });

  it('CORS preflight: allowed Origin → 204 exact reflection; evil Origin → 403', async () => {
    const ok = await httpReq(port, { path: '/health', method: 'OPTIONS', headers: { origin: ALLOWED } });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED);

    const bad = await httpReq(port, { path: '/health', method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
  });

  it('errors are sanitized to a code + generic message (no input echoed)', async () => {
    const r = await httpReq(port, { path: '/health', headers: { origin: 'https://evil.example/secret-path' } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('evil.example');
    expect(r.text).not.toContain('secret-path');
  });
});

describe('(Phase 2) GET /health — live gateway status provider wiring', () => {
  it('reflects whatever getGatewayStatus() returns, called fresh on every request (never cached)', async () => {
    const config = loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: ALLOWED });
    let calls = 0;
    const server = createAgentServer(config, {
      getGatewayStatus: () => {
        calls += 1;
        return {
          enrolled: true,
          deviceId: 'device-123',
          heartbeat: calls === 1 ? 'connecting' : 'connected',
          lastHeartbeatAt: calls === 1 ? null : '2026-01-01T00:00:00.000Z',
          sourcesConfigured: 2,
          storageRootsConfigured: 1,
          sourceKinds: { postgresql: 1, csv: 1 },
          enrollmentError: null,
          sourcesError: null,
          credentialProtection: 'dpapi' as const,
          network: DEFAULT_NETWORK_SUMMARY,
        };
      },
    });
    await new Promise<void>((resolve) => server.listen(0, config.bindHost, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const first = await httpReq(port, { path: '/health' });
      expect(first.json?.gateway).toMatchObject({ enrolled: true, deviceId: 'device-123', heartbeat: 'connecting', lastHeartbeatAt: null });

      const second = await httpReq(port, { path: '/health' });
      expect(second.json?.gateway).toMatchObject({ heartbeat: 'connected', lastHeartbeatAt: '2026-01-01T00:00:00.000Z' });
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('(Phase 3) adversarial requests against the local listener', () => {
  let server: Server;
  let port: number;
  const status = jest.fn(() => ({
    enrolled: true,
    deviceId: 'device-SENSITIVE-1',
    heartbeat: 'connected' as const,
    lastHeartbeatAt: null,
    sourcesConfigured: 1,
    storageRootsConfigured: 0,
    sourceKinds: { postgresql: 1 },
    enrollmentError: null,
    sourcesError: null,
    credentialProtection: 'dpapi' as const,
    network: DEFAULT_NETWORK_SUMMARY,
  }));

  beforeAll(async () => {
    const config = loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: ALLOWED });
    server = createAgentServer(config, { getGatewayStatus: status });
    await new Promise<void>((resolve) => server.listen(0, config.bindHost, resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('DNS rebinding: a request whose Host is an attacker hostname is refused (403) on /health', async () => {
    const r = await httpReq(port, { path: '/health', headers: { host: `rebind.attacker.example:${port}` } });
    expect(r.status).toBe(403);
    expect(r.json?.error).toBe('INVALID_HOST');
    expect(r.text).not.toContain('device-SENSITIVE-1');
  });

  it('DNS rebinding: the Host check also guards data-plane routes, before any routing', async () => {
    const r = await httpReq(port, { path: '/session/establish', method: 'POST', headers: { host: 'rebind.attacker.example' }, body: '{}' });
    expect(r.status).toBe(403);
    expect(r.json?.error).toBe('INVALID_HOST');
  });

  it('a request with NO Host header at all is refused (raw HTTP/1.0)', async () => {
    const { connect } = await import('node:net');
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /health HTTP/1.0\r\n\r\n'));
      let data = '';
      sock.on('data', (c) => (data += c.toString()));
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 403/);
    expect(raw).not.toContain('device-SENSITIVE-1');
  });

  it('a browser caller (Origin present, even an allowlisted one) gets liveness only — no device status', async () => {
    const r = await httpReq(port, { path: '/health', headers: { origin: ALLOWED } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'ok' });
    expect(r.json?.gateway).toBeUndefined();
    expect(r.text).not.toContain('device-SENSITIVE-1');
  });

  it('a hostile cross-origin caller is refused outright', async () => {
    const r = await httpReq(port, { path: '/health', headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('device-SENSITIVE-1');
  });

  it('the local non-browser caller (no Origin, loopback Host) does get status', async () => {
    const r = await httpReq(port, { path: '/health' });
    expect((r.json?.gateway as Record<string, unknown>)?.deviceId).toBe('device-SENSITIVE-1');
  });

  it.each(['PUT', 'DELETE', 'PATCH', 'TRACE', 'POST'])('%s /health is not allowed (405)', async (method) => {
    const r = await httpReq(port, { path: '/health', method, ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(r.status).toBe(405);
  });

  it.each(['/pair', '/enroll', '/gateway/enroll', '/deenroll', '/config', '/sources', '/source/add', '/admin', '/restart', '/shutdown'])(
    'no privileged/control route exists over HTTP: %s -> 404 (GET and POST)',
    async (p) => {
      expect((await httpReq(port, { path: p })).status).toBe(404);
      expect((await httpReq(port, { path: p, method: 'POST', body: '{}' })).status).toBe(404);
    },
  );

  it('an oversized body is refused before routing (413), even on an unknown route', async () => {
    const r = await httpReq(port, { path: '/anything', method: 'POST', body: 'x'.repeat(10_000) });
    expect(r.status).toBe(413);
  });

  it('query strings and path tricks do not reach a different handler', async () => {
    expect((await httpReq(port, { path: '/health/../pair' })).status).toBe(404);
    expect((await httpReq(port, { path: '/HEALTH' })).status).toBe(404);
    expect((await httpReq(port, { path: '/health?gateway=1' })).status).toBe(200);
  });
});
