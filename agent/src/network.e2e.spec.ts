/**
 * END-TO-END (Phase 4): the real compiled agent (dist/index.js) as a child
 * process, configured ONLY through config.json + the state directory, the
 * way the Windows Service starts it. It talks to LOCAL MOCK servers
 * (__fixtures__/mock-network.ts) — a simulated CONNECT proxy and a simulated
 * DPDP backend — with a TEST-ONLY CA standing in for a corporate
 * TLS-inspection CA. Not a real corporate proxy, not a real tenant, and not
 * the NT SERVICE\DPDPGatewayAgent identity (DPAPI here runs as the developer).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import type { GatewayStatusSummary } from './health';
import { closedPort, startMockBackend, startMockProxy, TLS_DIR, TUNNEL_HOST, type MockBackend, type MockProxy } from './__fixtures__/mock-network';

const AGENT = path.join(__dirname, '..', 'dist', 'index.js');
const describeBuilt = existsSync(AGENT) ? describe : describe.skip;

const PROXY_USER = 'svc-gateway';
const PROXY_PW = 'E2E-Pr0xy-PW-must-not-leak';
const ENROLL_CODE = 'e2e-enrol-code-0123456789';
// Clear every proxy/CA variable the developer's machine might have set.
const CLEAN_ENV = { HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '', NODE_EXTRA_CA_CERTS: '' };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function health(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface Agent {
  child: ChildProcess;
  port: number;
  root: string;
  stateDir: string;
  logs: () => string;
  status: () => Promise<GatewayStatusSummary>;
  stop: () => Promise<void>;
}

async function startAgent(config: Record<string, unknown>, opts: { caFile?: boolean; proxyCreds?: boolean } = {}): Promise<Agent> {
  const root = mkdtempSync(path.join(tmpdir(), 'dpdp-net-e2e-'));
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  mkdirSync(configDir);
  mkdirSync(stateDir);
  if (opts.caFile) copyFileSync(path.join(TLS_DIR, 'test-ca.pem'), path.join(configDir, 'corp-ca.pem'));
  if (opts.proxyCreds) writeFileSync(path.join(stateDir, 'proxy-credentials.json'), JSON.stringify({ username: PROXY_USER, password: PROXY_PW }));
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));

  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, [AGENT], {
    env: {
      ...process.env,
      ...CLEAN_ENV,
      GATEWAY_CONFIG_PATH: path.join(configDir, 'config.json'),
      GATEWAY_STATE_DIR: stateDir,
      GATEWAY_BIND_PORT: String(port),
      GATEWAY_CONTROL_PLANE_URL: '',
      GATEWAY_SOURCES: '',
      GATEWAY_ENROLLMENT_CODE: ENROLL_CODE,
      GATEWAY_HEARTBEAT_INTERVAL_SECONDS: '5',
    },
  });
  child.stdout?.on('data', (c) => (logs += c));
  child.stderr?.on('data', (c) => (logs += c));
  return {
    child,
    port,
    root,
    stateDir,
    logs: () => logs,
    status: async () => (await health(port)).gateway as GatewayStatusSummary,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describeBuilt('agent outbound network, end to end (real process; SIMULATED proxy and backend)', () => {
  beforeAll(() => {
    expect(statSync(AGENT).mtimeMs).toBeGreaterThanOrEqual(statSync(path.join(__dirname, 'transport.ts')).mtimeMs);
  });

  describe('enrols and heartbeats through an authenticating proxy, trusting the corporate CA from config.json', () => {
    let backend: MockBackend;
    let proxy: MockProxy;
    let agent: Agent;
    beforeAll(async () => {
      backend = await startMockBackend({ tls: 'localhost' });
      proxy = await startMockProxy({ auth: { username: PROXY_USER, password: PROXY_PW } });
      agent = await startAgent(
        {
          controlPlaneUrl: `https://${TUNNEL_HOST}:${backend.port}`,
          proxy: { url: proxy.url },
          tls: { extraCaCertsFile: 'corp-ca.pem' },
        },
        { caFile: true, proxyCreds: true },
      );
      await waitFor(async () => ((await agent.status()).enrolled ? true : undefined), 150_000, 'enrollment');
      await waitFor(async () => (backend.requests.some((r) => r.path === '/gateway/heartbeat') ? true : undefined), 30_000, 'heartbeat');
    }, 200_000);
    afterAll(async () => {
      await agent?.stop();
      await Promise.all([backend?.close(), proxy?.close()]);
    });

    it('enrolled, and the device credential/heartbeat travelled through the proxy tunnel', async () => {
      const status = await agent.status();
      expect(status).toMatchObject({ enrolled: true, enrollmentError: null, heartbeat: 'connected' });
      expect(backend.requests.map((r) => r.path)).toEqual(expect.arrayContaining(['/gateway/enroll', '/gateway/heartbeat']));
      expect(proxy.connects.length).toBeGreaterThan(0);
      expect(proxy.connects.every((c) => c.target === `${TUNNEL_HOST}:${backend.port}`)).toBe(true);
      expect(proxy.connects[0]!.proxyAuthorization).toBe(`Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PW}`).toString('base64')}`);
    });

    it('the proxy only ever saw ciphertext: no device token, no enrolment code', () => {
      const seen = proxy.tunnelledBytes().toString('latin1');
      expect(seen).not.toContain(backend.deviceToken);
      expect(seen).not.toContain(ENROLL_CODE);
    });

    it('reports the network configuration as labels and counts only', async () => {
      const status = await agent.status();
      expect(status.network).toMatchObject({
        proxy: 'config',
        proxyAuthentication: true,
        customTrust: true,
        tlsTrust: { extraCaCertificates: 1, windowsCertificateStore: false },
        proxyCredentialsError: null,
        lastErrorCode: null,
      });
      expect(JSON.stringify(status)).not.toContain(String(proxy.port));
    });

    it('logs contain no proxy password, no proxy address, no enrolment code, no device token', () => {
      const logs = agent.logs();
      expect(logs).toMatch(/outbound proxy: from config\.json, with Basic authentication/);
      expect(logs).toMatch(/1 CA certificate\(s\) from tls\.extraCaCertsFile; verification always on/);
      for (const secret of [PROXY_PW, Buffer.from(`${PROXY_USER}:${PROXY_PW}`).toString('base64'), ENROLL_CODE, backend.deviceToken, `:${proxy.port}`, 'corp-ca.pem']) {
        expect({ secret, inLogs: logs.includes(secret) }).toEqual({ secret, inLogs: false });
      }
    });

    const winIt = process.platform === 'win32' ? it : it.skip;
    winIt('proxy-credentials.json was rewritten DPAPI-protected (real DPAPI, developer account)', () => {
      const raw = readFileSync(path.join(agent.stateDir, 'proxy-credentials.json'), 'utf8');
      expect(raw).not.toContain(PROXY_PW);
      expect(JSON.parse(raw)).toMatchObject({ format: 'dpdp-gateway-proxy-credentials', version: 2, protected: { scheme: 'dpapi-user' } });
    });
  });

  describe('without the corporate CA, the certificate is rejected (fatal, reported, never ignored)', () => {
    let backend: MockBackend;
    let agent: Agent;
    beforeAll(async () => {
      backend = await startMockBackend({ tls: 'localhost' });
      agent = await startAgent({ controlPlaneUrl: `https://localhost:${backend.port}` });
      await waitFor(async () => ((await agent.status()).enrollmentError ? true : undefined), 150_000, 'enrollment error');
    }, 200_000);
    afterAll(async () => {
      await agent?.stop();
      await backend?.close();
    });

    it('enrollmentError is TLS_CERTIFICATE_REJECTED and the backend received nothing', async () => {
      expect((await agent.status()).enrollmentError).toBe('TLS_CERTIFICATE_REJECTED');
      expect(backend.requests).toHaveLength(0);
      expect(agent.logs()).toMatch(/TLS certificate verification failed \((UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\)/);
    });
  });

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  (lanIp ? describe : describe.skip)('a configured proxy that is down is never bypassed (destination directly reachable)', () => {
    let backend: MockBackend;
    let agent: Agent;
    beforeAll(async () => {
      backend = await startMockBackend({ tls: null, host: lanIp });
      agent = await startAgent({ controlPlaneUrl: `http://${lanIp}:${backend.port}`, proxy: { url: `http://127.0.0.1:${await closedPort()}` } });
      // Retryable: the enrolment retry loop backs off ~30 s before reporting.
      await waitFor(async () => ((await agent.status()).enrollmentError ? true : undefined), 170_000, 'enrollment error');
    }, 200_000);
    afterAll(async () => {
      await agent?.stop();
      await backend?.close();
    });

    it('enrollmentError is PROXY_UNREACHABLE and the reachable backend received NOTHING', async () => {
      expect((await agent.status()).enrollmentError).toBe('PROXY_UNREACHABLE');
      expect(backend.requests).toHaveLength(0);
      expect(agent.logs()).toMatch(/does not fall back to a direct connection/);
    });
  });

  it('refuses to start with proxy credentials inside config.json, without printing them', async () => {
    const agent = await startAgent({ controlPlaneUrl: 'https://dpdp.example', proxy: { url: `http://${PROXY_USER}:${PROXY_PW}@proxy.corp:8080` } });
    const code = await new Promise<number | null>((r) => (agent.child.exitCode !== null ? r(agent.child.exitCode) : agent.child.once('exit', r)));
    const logs = agent.logs();
    await agent.stop();
    expect(code).toBe(1);
    expect(logs).toMatch(/proxy-credentials\.json/);
    expect(logs).not.toContain(PROXY_PW);
    expect(logs).not.toContain('proxy.corp');
  }, 60_000);
});
