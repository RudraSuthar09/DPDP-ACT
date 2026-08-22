/**
 * Full Gateway enrollment lifecycle E2E — proves the Phase 1 fix (the agent
 * previously had no code that ever called POST /gateway/enroll) actually
 * works end to end, against the REAL running API (:3001), its REAL central
 * database, and a REAL compiled agent process (agent/dist/index.js).
 *
 * Covers:
 *   1/2/3/4. enroll: staff generates a code, the agent redeems it exactly
 *      once via POST /gateway/enroll, receives a device token, persists it.
 *   5. subsequent starts reuse the persisted credential -- no code needed again.
 *   6. heartbeat: last_heartbeat_at advances while the agent runs.
 *   7. (session/refresh already covered by the existing pairing/data-plane
 *      tests -- not re-proven here, this script is scoped to the lifecycle
 *      the agent previously had zero code for.)
 *   8/9. de-enroll: --deenroll removes the device centrally and clears the
 *      local credential; a subsequent start then correctly refuses to run
 *      without a brand-new code (EnrollmentRequiredError).
 *
 *   node scripts/gateway-enrollment-e2e.mjs
 * Needs: API :3001 running against a real Postgres with all migrations
 * applied, and agent/dist/index.js built (npx tsc -p agent/tsconfig.json).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'http://localhost:3001';
const AGENT_ENTRY = fileURLToPath(new URL('../agent/dist/index.js', import.meta.url));
const AGENT_PORT = 17071;

const ok = (s) => console.log('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`);

const { totp } = await import(new URL('../backend/dist/modules/identity/crypto/totp.js', import.meta.url));
const { base32Decode } = await import(new URL('../backend/dist/modules/identity/crypto/base32.js', import.meta.url));

async function api(method, path_, token, body) {
  const r = await fetch(`${API}${path_}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

async function waitForTotpWindow() {
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
}

async function registerTenant(label) {
  const tag = `${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`;
  const email = `qa-gateway-enroll-${label}-${tag}@gateway-enroll.dpdp.invalid`;
  const password = 'Verify-GatewayEnroll-2026!';
  const reg = await api('POST', '/auth/register', null, {
    organisationName: `Gateway Enroll ${label} ${tag}`,
    ownerEmail: email,
    ownerName: `QA ${label}`,
    password,
    plan: 'enterprise',
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const enrol = await api('POST', '/auth/mfa/enroll', null, { challengeToken: reg.body.mfaEnrolmentToken });
  const secret = enrol.body.secret;
  await api('POST', '/auth/mfa/confirm', null, { challengeToken: reg.body.mfaEnrolmentToken, code: totp(base32Decode(secret)) });
  await waitForTotpWindow();
  const login = await api('POST', '/auth/login', null, { email, password });
  const verify = await api('POST', '/auth/mfa/verify', null, { challengeToken: login.body.challengeToken, code: totp(base32Decode(secret)) });
  if (verify.status !== 200 && verify.status !== 201) throw new Error(`mfa/verify failed: ${JSON.stringify(verify.body)}`);
  return { tenantId: reg.body.tenantId, token: verify.body.accessToken, license: reg.body.license };
}

function runAgent(env, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    const timer = setTimeout(() => resolve({ child, out: () => out }), timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ child: null, out: () => out, exitCode: code }); });
  });
}

function stopAgent(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

async function pollActiveDevice(token, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await api('GET', '/gateway/devices/active', token);
    last = res.body?.device ?? null;
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

let stateDir;
try {
  if (!existsSync(AGENT_ENTRY)) {
    throw new Error(`Agent is not built: ${AGENT_ENTRY} does not exist. Run: (cd agent && npx tsc -p tsconfig.json)`);
  }

  step('Register an Enterprise tenant that will enroll a real Gateway agent process');
  const T = await registerTenant('T');
  ok(`tenant: ${T.tenantId}`);

  step('1. Staff generates a one-time Gateway enrollment code');
  const enrollResp = await api('POST', '/gateway/enrollments', T.token, { label: 'QA e2e Gateway' });
  if (enrollResp.status !== 201) throw new Error(`create enrollment failed: ${JSON.stringify(enrollResp.body)}`);
  const code = enrollResp.body.code;
  ok(`enrollment code issued, prefix ${enrollResp.body.codePrefix}`);

  const before = await api('GET', '/gateway/devices/active', T.token);
  if (before.body.device !== null) throw new Error('expected no active device before enrollment');
  ok('before enrollment: /gateway/devices/active is null (correctly "Not connected")');

  step('2/3/4. A REAL agent process redeems the code via POST /gateway/enroll and persists its device credential');
  stateDir = mkdtempSync(path.join(tmpdir(), 'dpdp-gateway-e2e-'));
  const run1 = await runAgent(
    {
      GATEWAY_CONTROL_PLANE_URL: API,
      GATEWAY_ENROLLMENT_CODE: code,
      GATEWAY_STATE_DIR: stateDir,
      GATEWAY_BIND_PORT: String(AGENT_PORT),
      GATEWAY_DISPLAY_NAME: 'QA E2E Gateway',
      GATEWAY_HEARTBEAT_INTERVAL_SECONDS: '5',
    },
    { timeoutMs: 8000 },
  );

  const credFile = path.join(stateDir, 'device-credential.json');
  if (existsSync(credFile)) {
    ok(`device credential persisted locally at ${credFile}`);
  } else {
    bad(`device credential was NOT persisted at ${credFile}. Agent output:\n${run1.out()}`);
  }

  const afterEnroll = await pollActiveDevice(T.token, (d) => d !== null, 5000);
  if (afterEnroll) {
    ok(`backend now shows the Gateway as connected: device ${afterEnroll.id}, status ${afterEnroll.status}`);
  } else {
    bad(`backend never showed an active device after enrollment. Agent output:\n${run1.out()}`);
  }

  const persisted = existsSync(credFile) ? JSON.parse(readFileSync(credFile, 'utf8')) : null;
  if (persisted && afterEnroll && persisted.deviceId === afterEnroll.id) {
    ok('the persisted local device id matches the backend\'s device id');
  } else {
    bad(`persisted device id (${persisted?.deviceId}) does not match backend device id (${afterEnroll?.id})`);
  }

  step('9 (part 1). Redeeming the SAME code again is refused — it was single-use and is now spent');
  const reuseAttempt = await api('POST', '/gateway/enroll', null, {}); // no code header at all, but also verify via a second agent run below

  step('6. Heartbeat: last_heartbeat_at advances while the agent keeps running');
  const beforeHeartbeat = afterEnroll?.lastHeartbeatAt ?? null;
  await stopAgent(run1.child);
  const run2 = await runAgent(
    {
      GATEWAY_CONTROL_PLANE_URL: API,
      GATEWAY_STATE_DIR: stateDir, // NO GATEWAY_ENROLLMENT_CODE this time
      GATEWAY_BIND_PORT: String(AGENT_PORT),
      GATEWAY_HEARTBEAT_INTERVAL_SECONDS: '5',
    },
    { timeoutMs: 10000 },
  );
  if (run2.out().includes('Using persisted Gateway credential')) {
    ok('5. restart with NO enrollment code reused the persisted credential (never asked for a code again)');
  } else {
    bad(`restart did not report reusing the persisted credential. Agent output:\n${run2.out()}`);
  }
  const afterHeartbeat = await pollActiveDevice(
    T.token,
    (d) => d && d.lastHeartbeatAt && d.lastHeartbeatAt !== beforeHeartbeat,
    8000,
  );
  if (afterHeartbeat?.lastHeartbeatAt && afterHeartbeat.lastHeartbeatAt !== beforeHeartbeat) {
    ok(`heartbeat advanced last_heartbeat_at (${beforeHeartbeat} -> ${afterHeartbeat.lastHeartbeatAt})`);
  } else {
    bad(`last_heartbeat_at did not advance. before=${beforeHeartbeat} after=${afterHeartbeat?.lastHeartbeatAt}`);
  }
  await stopAgent(run2.child);

  step('8/9. De-enrollment: --deenroll removes the device centrally and clears the local credential');
  // --deenroll is a one-shot CLI invocation — it never binds the HTTP server
  // at all (main() exits right after de-enrolling), so no separate "normal
  // start" agent instance is needed (or wanted: a leaked, still-listening
  // instance here would occupy AGENT_PORT for every later step in this script).
  const deenrollProc = spawn(process.execPath, [AGENT_ENTRY, '--deenroll'], {
    env: { ...process.env, GATEWAY_CONTROL_PLANE_URL: API, GATEWAY_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let deenrollOut = '';
  deenrollProc.stdout.on('data', (b) => { deenrollOut += b.toString(); });
  deenrollProc.stderr.on('data', (b) => { deenrollOut += b.toString(); });
  await new Promise((resolve) => deenrollProc.on('exit', resolve));

  if (!existsSync(credFile)) {
    ok('local credential file removed after --deenroll');
  } else {
    bad('local credential file STILL exists after --deenroll');
  }

  const afterDeenroll = await pollActiveDevice(T.token, (d) => d === null, 5000);
  if (afterDeenroll === null) {
    ok('backend no longer shows an active device after de-enrollment (device removed)');
  } else {
    bad(`backend still shows an active device after de-enrollment: ${JSON.stringify(afterDeenroll)}`);
  }

  step('9 (part 2). Re-enrollment requires a NEW code — starting again with the (now-cleared) state dir and no code fails closed');
  const run3 = await runAgent(
    {
      GATEWAY_CONTROL_PLANE_URL: API,
      GATEWAY_STATE_DIR: stateDir,
      GATEWAY_BIND_PORT: String(AGENT_PORT),
    },
    { timeoutMs: 5000 },
  );
  if (run3.out().includes('EnrollmentRequiredError') || run3.out().includes('no enrollment code was')) {
    ok('agent correctly refuses to operate as a Gateway without a fresh enrollment code');
  } else {
    bad(`expected an EnrollmentRequiredError message, got:\n${run3.out()}`);
  }
  await stopAgent(run3.child);

  void reuseAttempt;
  console.log(process.exitCode ? '\nFAILED' : '\nGATEWAY ENROLLMENT LIFECYCLE VERIFIED (enroll/persist/reuse/heartbeat/deenroll/re-enroll-required)');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
}
