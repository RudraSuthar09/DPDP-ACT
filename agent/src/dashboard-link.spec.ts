import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { GATEWAY_LOOPBACK_HOST } from '@dpdp/shared';
import { loadAgentConfig } from './config';
import { localListenerEndpoint, MAX_DASHBOARD_ORIGINS, sanitizeDashboardOrigins } from './dashboard-link';
import { createAgentServer } from './server';

describe('localListenerEndpoint — what the heartbeat reports', () => {
  it('reports the loopback listener (the installed Gateway default)', () => {
    expect(localListenerEndpoint({ bindHost: GATEWAY_LOOPBACK_HOST, bindPort: 7071 })).toBe(`http://${GATEWAY_LOOPBACK_HOST}:7071`);
    expect(localListenerEndpoint({ bindHost: GATEWAY_LOOPBACK_HOST, bindPort: 7072 })).toBe(`http://${GATEWAY_LOOPBACK_HOST}:7072`);
  });

  it('reports nothing for a network bind (those stay staff-configured)', () => {
    expect(localListenerEndpoint({ bindHost: '0.0.0.0', bindPort: 7071 })).toBeNull();
    expect(localListenerEndpoint({ bindHost: '192.0.2.10', bindPort: 7071 })).toBeNull();
  });
});

describe('sanitizeDashboardOrigins — what the heartbeat reply may add', () => {
  it('keeps exact origins only', () => {
    expect(sanitizeDashboardOrigins(['https://app.dpdp.example', 'http://localhost:3000'])).toEqual(['https://app.dpdp.example', 'http://localhost:3000']);
  });

  it('drops wildcards, paths, non-strings, duplicates and garbage', () => {
    expect(sanitizeDashboardOrigins(['*', 'https://*.example', 'https://app.example/path', 7, null, 'https://a.example', 'https://a.example'])).toEqual([
      'https://a.example',
    ]);
    expect(sanitizeDashboardOrigins('https://a.example')).toEqual([]);
    expect(sanitizeDashboardOrigins(undefined)).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) => `https://app${i}.example`);
    expect(sanitizeDashboardOrigins(many)).toHaveLength(MAX_DASHBOARD_ORIGINS);
  });
});

describe('local listener with heartbeat-provided dashboard origins', () => {
  const DASHBOARD = 'https://app.dpdp.example';
  let origins: string[] = [];
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const config = loadAgentConfig({});
    server = createAgentServer(config, { getDashboardOrigins: () => origins });
    await new Promise<void>((r) => server.listen(0, GATEWAY_LOOPBACK_HOST, r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function call(method: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: GATEWAY_LOOPBACK_HOST, port, path: '/health', method, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('before the first heartbeat reply the dashboard origin is refused (nothing is allowed by default)', async () => {
    origins = [];
    expect((await call('GET', { origin: DASHBOARD })).status).toBe(403);
  });

  it('after it, the dashboard origin is allowed with an EXACT CORS reflection', async () => {
    origins = [DASHBOARD];
    const r = await call('GET', { origin: DASHBOARD });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(DASHBOARD);
  });

  it('other origins are still refused, including look-alikes', async () => {
    origins = [DASHBOARD];
    expect((await call('GET', { origin: 'https://app.dpdp.example.evil.test' })).status).toBe(403);
    expect((await call('GET', { origin: 'https://evil.test' })).status).toBe(403);
  });

  it('answers the Private Network Access preflight only for an allowed origin', async () => {
    origins = [DASHBOARD];
    const ok = await call('OPTIONS', { origin: DASHBOARD, 'access-control-request-private-network': 'true', 'access-control-request-method': 'POST' });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-private-network']).toBe('true');
    const plain = await call('OPTIONS', { origin: DASHBOARD });
    expect(plain.headers['access-control-allow-private-network']).toBeUndefined();
    const evil = await call('OPTIONS', { origin: 'https://evil.test', 'access-control-request-private-network': 'true' });
    expect(evil.status).toBe(403);
    expect(evil.headers['access-control-allow-private-network']).toBeUndefined();
  });

  it('a revoked credential clears the list again (index.ts sets it to [])', async () => {
    origins = [];
    expect((await call('GET', { origin: DASHBOARD })).status).toBe(403);
  });
});
