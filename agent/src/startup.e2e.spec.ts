/**
 * END-TO-END: the real compiled agent (dist/index.js) started as a child
 * process, exactly as the service wrapper starts it, against a temp state
 * directory. On Windows this uses REAL DPAPI under the account running the
 * tests (NOT NT SERVICE\DPDPGatewayAgent — that needs an installed service;
 * see gateway-installer/README.md's acceptance checklist).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AGENT = path.join(__dirname, '..', 'dist', 'index.js');
const built = existsSync(AGENT);
const describeBuilt = built ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function get(port: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await get(port)).status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('agent did not start listening in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describeBuilt('agent startup, end to end (real process, real DPAPI on Windows)', () => {
  let stateDir: string;
  let child: ChildProcess | null = null;
  let logs = '';
  let port: number;

  beforeAll(async () => {
    expect(statSync(AGENT).mtimeMs).toBeGreaterThanOrEqual(statSync(path.join(__dirname, 'index.ts')).mtimeMs);

    stateDir = mkdtempSync(path.join(tmpdir(), 'dpdp-e2e-'));
    writeFileSync(
      path.join(stateDir, 'sources.json'),
      JSON.stringify([{ sourceId: 'legacy-db', kind: 'mysql', connection: { host: 'h', port: 3306, user: 'u', password: 'LEGACY-PW', database: 'd' } }]),
    );
    writeFileSync(
      path.join(stateDir, 'pending-sources.json'),
      JSON.stringify({
        format: 'dpdp-gateway-pending-sources',
        version: 1,
        upserts: [{ sourceId: 'new-db', kind: 'postgresql', connection: { host: 'h', port: 5432, user: 'u', password: 'QUEUED-PW', database: 'd' } }],
      }),
    );

    port = await freePort();
    child = spawn(process.execPath, [AGENT], {
      env: {
        ...process.env,
        GATEWAY_STATE_DIR: stateDir,
        GATEWAY_CONFIG_PATH: path.join(stateDir, 'no-config.json'),
        GATEWAY_BIND_PORT: String(port),
        GATEWAY_ALLOWED_ORIGINS: 'https://app.test.example',
        GATEWAY_CONTROL_PLANE_URL: '',
        GATEWAY_SOURCES: '',
      },
    });
    child.stdout?.on('data', (c) => (logs += c));
    child.stderr?.on('data', (c) => (logs += c));
    await waitForHealth(port, 120_000);
  }, 180_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.once('exit', r));
      child.kill();
      await exited;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('merged the queued source, and removed the pending file', () => {
    expect(existsSync(path.join(stateDir, 'pending-sources.json'))).toBe(false);
    expect(logs).toMatch(/Applied 1 queued source change/);
  });

  const winIt = process.platform === 'win32' ? it : it.skip;

  winIt('migrated sources.json to the DPAPI-protected format: no password on disk', () => {
    const raw = readFileSync(path.join(stateDir, 'sources.json'), 'utf8');
    expect(raw).not.toContain('LEGACY-PW');
    expect(raw).not.toContain('QUEUED-PW');
    expect(JSON.parse(raw)).toMatchObject({ format: 'dpdp-gateway-sources', version: 2 });
  });

  it('never logged a password', () => {
    expect(logs).not.toContain('LEGACY-PW');
    expect(logs).not.toContain('QUEUED-PW');
  });

  it('serves local status to the local non-browser caller: kinds and counts only, no source IDs', async () => {
    const r = await get(port);
    const gw = JSON.parse(r.body).gateway;
    expect(gw).toMatchObject({ sourcesConfigured: 2, sourceKinds: { mysql: 1, postgresql: 1 }, sourcesError: null });
    expect(gw.credentialProtection).toBe(process.platform === 'win32' ? 'dpapi' : 'none');
    expect(r.body).not.toContain('legacy-db');
    expect(r.body).not.toContain('new-db');
  });

  it('refuses a DNS-rebinding Host on the live listener', async () => {
    expect((await get(port, { host: `attacker.example:${port}` })).status).toBe(403);
  });

  it('gives an allowlisted browser origin liveness only', async () => {
    const r = await get(port, { origin: 'https://app.test.example' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).gateway).toBeUndefined();
  });

  it('a second instance against the same state directory refuses to start', async () => {
    const second = spawn(process.execPath, [AGENT], {
      env: { ...process.env, GATEWAY_STATE_DIR: stateDir, GATEWAY_CONFIG_PATH: path.join(stateDir, 'no-config.json'), GATEWAY_BIND_PORT: String(await freePort()) },
    });
    let out = '';
    second.stdout?.on('data', (c) => (out += c));
    second.stderr?.on('data', (c) => (out += c));
    const code = await new Promise<number | null>((r) => second.once('exit', r));
    expect(code).toBe(1);
    expect(out).toMatch(/already running/);
  }, 120_000);
});
