import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { GATEWAY_AUTH_HEADER } from '@dpdp/shared';
import { loadAgentConfig } from './config';
import { createAgentServer } from './server';

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

  it('7/8. health response contains no secrets and no customer data', async () => {
    const r = await httpReq(port, { path: '/health' });
    // exactly the four safe metadata keys — nothing else leaks
    expect(Object.keys(r.json ?? {}).sort()).toEqual([
      'agentVersion',
      'networkMode',
      'protocolVersion',
      'status',
    ]);
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
