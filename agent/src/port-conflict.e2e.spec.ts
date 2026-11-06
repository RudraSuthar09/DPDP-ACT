/**
 * END-TO-END (Phase 6): the real compiled agent when its local port is taken.
 *
 * Root cause seen on a real Windows install: the full-stack Docker "agent"
 * container publishes 0.0.0.0:7071 as the desktop user; the Gateway service
 * (account NT SERVICE\DPDPGatewayAgent) was refused 127.0.0.1:7071 with
 * EACCES and crashed with an unexplained exit code 1, over and over.
 *
 * Here the port is held by this same account, so Windows reports EADDRINUSE
 * instead of EACCES; the agent handles both codes the same way. The
 * cross-ACCOUNT case itself needs a second Windows account and is covered by
 * the acceptance checklist, not by this test.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AGENT = path.join(__dirname, '..', 'dist', 'index.js');
const describeBuilt = existsSync(AGENT) ? describe : describe.skip;

describeBuilt('agent with its local port already in use (real process)', () => {
  let holder: Server;
  let port: number;
  let dir: string;
  beforeAll(async () => {
    expect(statSync(AGENT).mtimeMs).toBeGreaterThanOrEqual(statSync(path.join(__dirname, 'index.ts')).mtimeMs);
    holder = createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    port = (holder.address() as { port: number }).port;
    dir = mkdtempSync(path.join(tmpdir(), 'dpdp-portconflict-'));
  });
  afterAll(async () => {
    await new Promise((r) => holder.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits with the distinct code 3 and an actionable message, not a crash', async () => {
    let out = '';
    const child = spawn(process.execPath, [AGENT], {
      env: {
        ...process.env,
        HTTPS_PROXY: '',
        HTTP_PROXY: '',
        GATEWAY_STATE_DIR: path.join(dir, 'state'),
        GATEWAY_CONFIG_PATH: path.join(dir, 'none.json'),
        GATEWAY_CONTROL_PLANE_URL: '',
        GATEWAY_SOURCES: '',
        GATEWAY_BIND_PORT: String(port),
      },
    });
    child.stdout?.on('data', (c) => (out += c));
    child.stderr?.on('data', (c) => (out += c));
    const code = await new Promise<number | null>((r) => child.once('exit', r));

    expect(code).toBe(3);
    expect(out).toMatch(new RegExp(`Cannot open the local Gateway port 127\\.0\\.0\\.1:${port} \\((EADDRINUSE|EACCES)\\)`));
    expect(out).toMatch(/Only one DPDP Gateway can run on a computer/);
    expect(out).not.toMatch(/Uncaught|at Server\.setupListenHandle|node:internal/); // no raw crash stack
  }, 120_000);
});
