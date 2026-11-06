/**
 * END-TO-END (Phase 6): the basic customer journey, with the REAL compiled
 * agent and CLI as child processes:
 *
 *   pair (dist/cli-pair.js pair --stdin, exactly what the elevated helper runs)
 *   -> service start (dist/index.js, DEFAULT heartbeat interval)
 *   -> enrolled + Connected -> restart -> still enrolled, no re-enrolment
 *   -> backend outage -> Reconnecting -> backend back -> Connected
 *
 * plus the onboarding failures the Setup wizard must explain.
 *
 * SIMULATED: the DPDP backend is a local mock (__fixtures__/mock-network.ts),
 * and the processes run as the developer, not as the Windows Service
 * (NT SERVICE\DPDPGatewayAgent). Not a real tenant, not a real service.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GATEWAY_AUTH_HEADER } from '@dpdp/shared';
import type { GatewayStatusSummary } from './health';
import { closedPort, startMockBackend, type MockBackend } from './__fixtures__/mock-network';

const DIST = path.join(__dirname, '..', 'dist');
const AGENT = path.join(DIST, 'index.js');
const CLI = path.join(DIST, 'cli-pair.js');
const describeBuilt = existsSync(AGENT) && existsSync(CLI) ? describe : describe.skip;
const CODE = 'journey-code-0123456789';
const CLEAN_ENV = { HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '', GATEWAY_NO_PROXY: '' };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function status(port: number): Promise<GatewayStatusSummary> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).gateway as GatewayStatusSummary);
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

interface Install {
  root: string;
  env: NodeJS.ProcessEnv;
}

function newInstall(): Install {
  const root = mkdtempSync(path.join(tmpdir(), 'dpdp-journey-'));
  mkdirSync(path.join(root, 'config'));
  return {
    root,
    env: {
      ...process.env,
      ...CLEAN_ENV,
      GATEWAY_CONFIG_PATH: path.join(root, 'config', 'config.json'),
      GATEWAY_STATE_DIR: path.join(root, 'state'),
      GATEWAY_CONTROL_PLANE_URL: '',
      GATEWAY_ENROLLMENT_CODE: '',
      GATEWAY_SOURCES: '',
      GATEWAY_HEARTBEAT_INTERVAL_SECONDS: '',
    },
  };
}

/** What the elevated helper does on "Pair device": the real CLI, input on stdin. */
async function pair(install: Install, serverUrl: string): Promise<number | null> {
  const child = spawn(process.execPath, [CLI, 'pair', '--stdin'], { env: install.env });
  child.stdin.end(JSON.stringify({ enrollmentCode: CODE, controlPlaneUrl: serverUrl, displayName: 'Journey PC' }));
  return new Promise((r) => child.once('exit', r));
}

interface Service {
  port: number;
  logs: () => string;
  stop: () => Promise<void>;
}

async function startService(install: Install, extraEnv: NodeJS.ProcessEnv = {}): Promise<Service> {
  const port = await freePort();
  let logs = '';
  const child: ChildProcess = spawn(process.execPath, [AGENT], { env: { ...install.env, ...extraEnv, GATEWAY_BIND_PORT: String(port) } });
  child.stdout?.on('data', (c) => (logs += c));
  child.stderr?.on('data', (c) => (logs += c));
  return {
    port,
    logs: () => logs,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
      }
    },
  };
}

describeBuilt('customer journey, end to end (real agent + CLI processes; SIMULATED backend)', () => {
  beforeAll(() => {
    expect(statSync(AGENT).mtimeMs).toBeGreaterThanOrEqual(statSync(path.join(__dirname, 'enrollment.ts')).mtimeMs);
  });

  describe('pair -> Connected -> restart -> outage -> recovery', () => {
    let backend: MockBackend;
    let install: Install;
    let service: Service | undefined;
    beforeAll(async () => {
      backend = await startMockBackend({ tls: null });
      install = newInstall();
    });
    afterAll(async () => {
      await service?.stop();
      await backend?.close();
      rmSync(install.root, { recursive: true, force: true });
    });

    it('pairing writes the configuration and hands the code to the service', async () => {
      expect(await pair(install, `http://127.0.0.1:${backend.port}`)).toBe(0);
    });

    it('with the DEFAULT 60 s heartbeat interval, the service reports Connected within seconds of pairing', async () => {
      const started = Date.now();
      service = await startService(install);
      const s = await waitFor(async () => {
        const st = await status(service!.port);
        return st.enrolled && st.heartbeat === 'connected' ? st : undefined;
      }, 60_000, 'Connected');
      expect(Date.now() - started).toBeLessThan(30_000); // the wizard waits for exactly this
      expect(s).toMatchObject({ enrollmentError: null, lastHeartbeatAt: expect.any(String) });
      expect(backend.requests.filter((r) => r.path === '/gateway/enroll')).toHaveLength(1);
      expect(service.logs()).not.toContain(CODE);
      expect(service.logs()).not.toContain(backend.deviceToken);
    }, 90_000);

    it('after a restart it is still paired and Connected, without enrolling again (credential persisted)', async () => {
      await service!.stop();
      service = await startService(install);
      const s = await waitFor(async () => {
        const st = await status(service!.port);
        return st.heartbeat === 'connected' ? st : undefined;
      }, 60_000, 'Connected after restart');
      expect(s.enrolled).toBe(true);
      expect(backend.requests.filter((r) => r.path === '/gateway/enroll')).toHaveLength(1);
    }, 90_000);

    it('a backend outage shows Reconnecting, and it recovers by itself when the backend returns', async () => {
      await service!.stop();
      service = await startService(install, { GATEWAY_HEARTBEAT_INTERVAL_SECONDS: '5' });
      await waitFor(async () => ((await status(service!.port)).heartbeat === 'connected' ? true : undefined), 60_000, 'Connected');

      const port = backend.port;
      await backend.close();
      const down = await waitFor(async () => {
        const st = await status(service!.port);
        return st.heartbeat === 'degraded' ? st : undefined;
      }, 30_000, 'Reconnecting');
      expect(down.network.lastErrorCode).toBe('CONNECT_FAILED');
      expect(down.enrolled).toBe(true); // an outage never un-pairs the Gateway

      backend = await startMockBackend({ tls: null, port });
      const up = await waitFor(async () => {
        const st = await status(service!.port);
        return st.heartbeat === 'connected' ? st : undefined;
      }, 30_000, 'Connected again');
      expect(up.network.lastErrorCode).toBeNull();
    }, 120_000);
  });

  describe('(Phase 6) dashboard link over the existing heartbeat: no hand-entered endpoint or origin', () => {
    const DASHBOARD = 'http://dashboard.test:3000';
    let backend: MockBackend;
    let install: Install;
    let service: Service | undefined;
    beforeAll(async () => {
      backend = await startMockBackend({ tls: null, heartbeatReply: { deviceStatus: 'active', boundSourceIds: [], dashboardOrigins: [DASHBOARD] } });
      install = newInstall();
      expect(await pair(install, `http://127.0.0.1:${backend.port}`)).toBe(0);
      service = await startService(install);
      await waitFor(async () => ((await status(service!.port)).heartbeat === 'connected' ? true : undefined), 60_000, 'Connected');
    }, 90_000);
    afterAll(async () => {
      await service?.stop();
      await backend?.close();
      rmSync(install.root, { recursive: true, force: true });
    });

    it('the heartbeat reports this Gateway\'s own loopback listener', () => {
      const hb = backend.requests.find((r) => r.path === '/gateway/heartbeat');
      expect(JSON.parse(hb!.body)).toEqual({ agentVersion: expect.any(String), localEndpoint: `http://127.0.0.1:${service!.port}` });
    });

    function browserGet(origin: string): Promise<{ status: number; allowOrigin: unknown }> {
      return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: service!.port, path: '/health', headers: { origin } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, allowOrigin: res.headers['access-control-allow-origin'] }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    it('the dashboard origin from the reply is accepted by the local listener (exact CORS reflection)', async () => {
      expect(await browserGet(DASHBOARD)).toEqual({ status: 200, allowOrigin: DASHBOARD });
    });

    it('any other origin is still refused', async () => {
      expect((await browserGet('http://evil.test')).status).toBe(403);
    });
  });

  describe('(Enterprise consent copy) the real service writes into a folder authorized for WRITE only', () => {
    const STORAGE_ROOT = '0b6a6b9e-1d3c-4a71-9c6f-1f0e0d0c0b0a';
    const SUBMISSION = '7c1e2d3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
    let backend: MockBackend;
    let install: Install;
    let service: Service | undefined;
    let writeFolder: string;
    let readFolder: string;

    beforeAll(async () => {
      writeFolder = mkdtempSync(path.join(tmpdir(), 'dpdp-write-grant-'));
      readFolder = mkdtempSync(path.join(tmpdir(), 'dpdp-read-grant-'));
      backend = await startMockBackend({
        tls: null,
        claimReplies: [
          {
            ready: true,
            target: 'gateway',
            deliveryId: 'delivery-e2e',
            storageRootId: STORAGE_ROOT,
            files: [{ path: ['Consent copies'], filename: `Email - ${SUBMISSION} - f1.txt`, contentBase64: Buffer.from('asha@example.com').toString('base64') }],
          },
        ],
      });
      install = newInstall();
      expect(await pair(install, `http://127.0.0.1:${backend.port}`)).toBe(0);
      service = await startService(install, {
        GATEWAY_SOURCES: JSON.stringify([
          { sourceId: 'finance', kind: 'filesystem', roots: [readFolder] }, // existing-style entry: read only
          { sourceId: STORAGE_ROOT, kind: 'filesystem', roots: [writeFolder], access: 'write', storageRootId: STORAGE_ROOT },
        ]),
      });
      await waitFor(async () => (backend.requests.some((q) => q.path === '/gateway/submissions/delivery-e2e/ack') ? true : undefined), 60_000, 'ack');
    }, 90_000);
    afterAll(async () => {
      await service?.stop();
      await backend?.close();
      rmSync(install.root, { recursive: true, force: true });
      rmSync(writeFolder, { recursive: true, force: true });
      rmSync(readFolder, { recursive: true, force: true });
    });

    it('claims advertising ONLY the write-authorized location (no local Central root on this Gateway)', () => {
      const claim = backend.requests.find((q) => q.path === '/gateway/submissions/claim')!;
      expect(JSON.parse(claim.body)).toEqual({ central: false, storageRootIds: [STORAGE_ROOT] });
    });

    it('writes the copy into the authorized folder (creating the mapped sub-folder) and acknowledges it', () => {
      expect(readFileSync(path.join(writeFolder, 'Consent copies', `Email - ${SUBMISSION} - f1.txt`), 'utf8')).toBe('asha@example.com');
    });

    it('the read-only folder is untouched, and its data plane does not expose the write-only folder', async () => {
      expect(readdirSync(readFolder)).toEqual([]);
      expect((await status(service!.port)).sourcesConfigured).toBe(1);
    });

    it('logs carry no value and no path', () => {
      const logs = service!.logs();
      expect(logs).toContain('Delivered Enterprise copy delivery=delivery-e2e written=1');
      expect(logs).not.toContain('asha@example.com');
      expect(logs).not.toContain(writeFolder);
    });
  });

  describe('(file picker) a browser browses the authorized folder through the real agent', () => {
    const DASHBOARD = 'http://dashboard.test:3000';
    const SOURCE_ID = 'folder-source-1';
    let backend: MockBackend;
    let install: Install;
    let service: Service | undefined;
    let folder: string;
    let token = '';

    beforeAll(async () => {
      folder = mkdtempSync(path.join(tmpdir(), 'dpdp-picker-'));
      mkdirSync(path.join(folder, 'Exports', '2024'), { recursive: true });
      writeFileSync(path.join(folder, 'customers.csv'), 'Name\nAsha\n');
      writeFileSync(path.join(folder, 'notes.txt'), 'not offered');
      writeFileSync(path.join(folder, 'Exports', '2024', 'q1.xlsx'), 'x');
      backend = await startMockBackend({ tls: null, heartbeatReply: { dashboardOrigins: [DASHBOARD] } });
      install = newInstall();
      expect(await pair(install, `http://127.0.0.1:${backend.port}`)).toBe(0);
      service = await startService(install, { GATEWAY_SOURCES: JSON.stringify([{ sourceId: SOURCE_ID, kind: 'filesystem', roots: [folder] }]) });
      await waitFor(async () => ((await status(service!.port)).heartbeat === 'connected' ? true : undefined), 60_000, 'Connected');
    }, 90_000);
    afterAll(async () => {
      await service?.stop();
      await backend?.close();
      rmSync(install.root, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    });

    // Loosely typed on purpose: these replies are asserted field by field.
    type BrowseJson = { sessionToken: string; entries: Array<{ entryKind: string; label: string; handle: string }> };
    function browserPost(p: string, body: unknown, session?: string): Promise<{ status: number; json: BrowseJson }> {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers: Record<string, string> = { origin: DASHBOARD, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) };
        if (session) headers[GATEWAY_AUTH_HEADER] = session;
        const req = request({ host: '127.0.0.1', port: service!.port, path: p, method: 'POST', headers }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end(payload);
      });
    }

    it('opens a session the existing way (backend-brokered pairing)', async () => {
      const r = await browserPost('/session/establish', { sourceId: SOURCE_ID, nonce: 'nonce-from-backend' });
      expect(r.status).toBe(200);
      token = r.json.sessionToken;
      expect(backend.requests.some((q) => q.path === '/gateway/pair/redeem')).toBe(true);
    });

    it('lists the REAL folder: sub-folder and approved file, no unapproved file, no paths', async () => {
      const r = await browserPost('/source/browse', { sourceId: SOURCE_ID }, token);
      expect(r.status).toBe(200);
      expect(r.json.entries.map((e: { entryKind: string; label: string }) => `${e.entryKind}:${e.label}`)).toEqual(['folder:Exports', 'file:customers.csv']);
      expect(JSON.stringify(r.json)).not.toContain(folder.replace(/\\/g, '\\\\'));
    });

    it('navigates into sub-folders by handle, down to the nested file', async () => {
      const top = await browserPost('/source/browse', { sourceId: SOURCE_ID }, token);
      const exportsDir = await browserPost('/source/browse', { sourceId: SOURCE_ID, folder: top.json.entries[0]!.handle }, token);
      const y2024 = await browserPost('/source/browse', { sourceId: SOURCE_ID, folder: exportsDir.json.entries[0]!.handle }, token);
      expect(y2024.json.entries.map((e: { label: string }) => e.label)).toEqual(['q1.xlsx']);
    });

    it('refuses without a session, with a forged handle, or with a path', async () => {
      expect((await browserPost('/source/browse', { sourceId: SOURCE_ID })).status).toBe(401);
      expect((await browserPost('/source/browse', { sourceId: SOURCE_ID, folder: 'forged' }, token)).status).toBe(404);
      expect((await browserPost('/source/browse', { sourceId: SOURCE_ID, folder: folder }, token)).status).toBe(404);
    });

    it('browsing never changes the folder', () => {
      expect(readdirSync(folder).sort()).toEqual(['Exports', 'customers.csv', 'notes.txt']);
    });
  });

  describe('onboarding failures the wizard must explain', () => {
    const cases: Array<{ name: string; backend: () => Promise<{ url: string; close: () => Promise<void>; enrollCalls: () => number }>; expected: string; within: number }> = [
      {
        name: 'an invalid or expired code is rejected quickly: CODE_REJECTED',
        backend: async () => {
          const b = await startMockBackend({ tls: null, statusFor: { '/gateway/enroll': 401 } });
          return { url: `http://127.0.0.1:${b.port}`, close: b.close, enrollCalls: () => b.requests.length };
        },
        expected: 'CODE_REJECTED',
        within: 30_000,
      },
      {
        name: 'the dashboard web address instead of the server address: WRONG_SERVER, quickly, without retrying',
        backend: async () => {
          const b = await startMockBackend({ tls: null, htmlSite: true });
          return { url: `http://127.0.0.1:${b.port}`, close: b.close, enrollCalls: () => b.requests.length };
        },
        expected: 'WRONG_SERVER',
        within: 30_000,
      },
      {
        name: 'DPDP not reachable at all: BACKEND_UNREACHABLE after bounded retries',
        backend: async () => ({ url: `http://127.0.0.1:${await closedPort()}`, close: async () => undefined, enrollCalls: () => 0 }),
        expected: 'BACKEND_UNREACHABLE',
        within: 120_000,
      },
    ];

    for (const c of cases) {
      it(
        c.name,
        async () => {
          const b = await c.backend();
          const install = newInstall();
          let service: Service | undefined;
          try {
            expect(await pair(install, b.url)).toBe(0);
            const started = Date.now();
            service = await startService(install);
            const s = await waitFor(async () => {
              const st = await status(service!.port);
              return st.enrollmentError ? st : undefined;
            }, c.within, c.expected);
            expect(s.enrollmentError).toBe(c.expected);
            expect(s.enrolled).toBe(false);
            expect(Date.now() - started).toBeLessThan(c.within);
            if (c.expected !== 'BACKEND_UNREACHABLE') expect(b.enrollCalls()).toBe(1); // not retried
            const logs = service.logs();
            expect(logs).not.toContain(CODE);
            expect(logs).not.toMatch(/<!DOCTYPE|<html/i); // no foreign HTML in the log
          } finally {
            await service?.stop();
            await b.close();
            rmSync(install.root, { recursive: true, force: true });
          }
        },
        c.within + 30_000,
      );
    }
  });
});
