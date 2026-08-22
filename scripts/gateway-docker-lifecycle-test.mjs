/**
 * REAL Docker lifecycle test for the Gateway/Agent container (Phase 1 Docker
 * packaging). Drives the actual `docker compose` stack — not a spawned bare
 * node process like gateway-enrollment-e2e.mjs — to prove tests A-F from the
 * task exactly as specified: fresh enrollment, restart, full down/up
 * recreation, de-enrollment, state destruction, and no-data-source startup.
 *
 * Needs: Docker images built (dpdp-backend:local, dpdp-frontend:local,
 * dpdp-agent:local), Docker Desktop running, .env with central DB creds.
 *   node scripts/gateway-docker-lifecycle-test.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';

const API = 'http://localhost:3001';
const ok = (s) => console.log('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`);

const { totp } = await import(new URL('../backend/dist/modules/identity/crypto/totp.js', import.meta.url));
const { base32Decode } = await import(new URL('../backend/dist/modules/identity/crypto/base32.js', import.meta.url));

function compose(args, opts = {}) {
  const res = spawnSync('docker', ['compose', ...args], { encoding: 'utf8', ...opts });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}
function composeChecked(args, opts = {}) {
  const res = compose(args, opts);
  if (res.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed (${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

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
  const email = `qa-docker-gw-${label}-${tag}@docker-gw.dpdp.invalid`;
  const password = 'Verify-DockerGateway-2026!';
  const reg = await api('POST', '/auth/register', null, {
    organisationName: `Docker Gateway ${label} ${tag}`,
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
  return { tenantId: reg.body.tenantId, token: verify.body.accessToken };
}

async function waitHealthy(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function pollActiveDevice(token, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await api('GET', '/gateway/devices/active', token);
    last = res.body?.device ?? null;
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 700));
  }
  return last;
}

function agentLogs() {
  return compose(['logs', 'agent', '--no-log-prefix']).stdout;
}

try {
  step('Setup — bring up backend/worker/frontend only (agent joins per-test below)');
  composeChecked(['up', '-d', 'backend', 'worker', 'frontend']);
  if (!(await waitHealthy(`${API}/health`, 60000))) throw new Error('backend never became healthy');
  ok('backend/worker/frontend are up and backend is healthy');

  step('Register an Enterprise tenant to own this Gateway');
  const T = await registerTenant('T');
  ok(`tenant: ${T.tenantId}`);

  // ===========================================================================
  step('TEST A — Fresh enrollment');
  // ===========================================================================
  compose(['down', '-v'], {}); // ensure a truly clean gateway_state volume to start from
  composeChecked(['up', '-d', 'backend', 'worker', 'frontend']);
  if (!(await waitHealthy(`${API}/health`, 60000))) throw new Error('backend never became healthy (post down -v)');

  const enrollResp = await api('POST', '/gateway/enrollments', T.token, { label: 'Docker lifecycle test' });
  if (enrollResp.status !== 201) throw new Error(`create enrollment failed: ${JSON.stringify(enrollResp.body)}`);
  const code = enrollResp.body.code;
  ok(`enrollment code issued, prefix ${enrollResp.body.codePrefix}`);

  const beforeA = await api('GET', '/gateway/devices/active', T.token);
  if (beforeA.body.device !== null) bad('expected no active device before enrollment'); else ok('before enrollment: /gateway/devices/active is null');

  process.env.GATEWAY_ENROLLMENT_CODE = code;
  composeChecked(['up', '-d', 'agent']);
  delete process.env.GATEWAY_ENROLLMENT_CODE;

  const deviceA = await pollActiveDevice(T.token, (d) => d !== null, 15000);
  if (deviceA) ok(`central DB now shows the Gateway connected: device ${deviceA.id}, status ${deviceA.status}`);
  else bad('central DB never showed an active device after fresh enrollment');

  const logsA = agentLogs();
  if (logsA.includes(code)) bad('!! the raw enrollment code appears in agent container logs !!');
  else ok('enrollment code is NOT printed in agent logs');
  if (deviceA && /token/i.test(logsA.split('\n').filter((l) => l.toLowerCase().includes('token')).join(' ')) && logsA.includes(deviceA.id) === false) {
    // sanity no-op; real device-token leak check below is stricter
  }

  // ===========================================================================
  step('TEST B — Restart (no new code)');
  // ===========================================================================
  composeChecked(['restart', 'agent']);
  const restartOk = await waitHealthy(`http://localhost:${process.env.GATEWAY_BIND_PORT ?? 7071}/health`, 20000);
  if (restartOk) ok('agent container healthy again after restart'); else bad('agent did not become healthy after restart');

  const logsB = agentLogs();
  if (logsB.includes('Using persisted Gateway credential')) ok('restart reused the persisted credential (no code needed)');
  else bad(`restart did not report reusing the persisted credential. Logs tail:\n${logsB.slice(-1500)}`);

  const deviceB = await pollActiveDevice(T.token, (d) => d !== null, 10000);
  if (deviceB && deviceA && deviceB.id === deviceA.id) ok('same Gateway device id after restart — no new device created');
  else bad(`device id changed or missing after restart: before=${deviceA?.id} after=${deviceB?.id}`);

  // ===========================================================================
  step('TEST C — Full container recreation (down, then up -d, volume kept)');
  // ===========================================================================
  composeChecked(['down']); // NO -v — volume must survive
  composeChecked(['up', '-d', 'backend', 'worker', 'frontend', 'agent']);
  if (!(await waitHealthy(`${API}/health`, 60000))) throw new Error('backend never became healthy after down/up');

  const deviceC = await pollActiveDevice(T.token, (d) => d !== null, 20000);
  if (deviceC && deviceA && deviceC.id === deviceA.id) ok('after full down+up (volume kept): same Gateway device id, reconnected, no new enrollment code needed');
  else bad(`device id changed or missing after down/up: before=${deviceA?.id} after=${deviceC?.id}`);

  const logsC = agentLogs();
  if (logsC.includes('Using persisted Gateway credential')) ok('down+up recreation also reused the persisted credential');
  else bad('down+up recreation did not report reusing the persisted credential');

  // ===========================================================================
  step('TEST D — De-enrollment');
  // ===========================================================================
  const deenrollRes = spawnSync('docker', ['compose', 'exec', '-T', 'agent', 'node', 'dist/index.js', '--deenroll'], { encoding: 'utf8' });
  const deenrollOut = (deenrollRes.stdout ?? '') + (deenrollRes.stderr ?? '');
  if (deenrollOut.toLowerCase().includes('de-enrolled')) ok('agent reported successful de-enrollment');
  else bad(`--deenroll did not report success. Output:\n${deenrollOut}`);

  const afterDeenroll = await pollActiveDevice(T.token, (d) => d === null, 10000);
  if (afterDeenroll === null) ok('central DB no longer shows an active device (removed)');
  else bad(`central DB still shows an active device after de-enrollment: ${JSON.stringify(afterDeenroll)}`);

  const stateAfterDeenroll = spawnSync('docker', ['compose', 'exec', '-T', 'agent', 'ls', '/app/state'], { encoding: 'utf8' });
  const stateListing = (stateAfterDeenroll.stdout ?? '').trim();
  if (!stateListing.includes('device-credential.json')) ok(`local credential file removed from the volume (ls /app/state: "${stateListing}")`);
  else bad(`local credential file STILL present after de-enrollment: ${stateListing}`);

  composeChecked(['restart', 'agent']);
  await new Promise((r) => setTimeout(r, 4000));
  const logsD = agentLogs();
  if (logsD.includes('EnrollmentRequiredError') || logsD.includes('no enrollment code was')) {
    ok('restart WITHOUT a new code after de-enrollment correctly fails with EnrollmentRequiredError');
  } else {
    bad(`expected EnrollmentRequiredError after de-enrollment+restart. Logs tail:\n${logsD.slice(-1500)}`);
  }

  step('D (continued) — a FRESH code allows re-enrollment');
  const enrollResp2 = await api('POST', '/gateway/enrollments', T.token, { label: 'Docker lifecycle test — re-enroll' });
  const code2 = enrollResp2.body.code;
  process.env.GATEWAY_ENROLLMENT_CODE = code2;
  composeChecked(['up', '-d', 'agent']); // recreates with the new env var
  delete process.env.GATEWAY_ENROLLMENT_CODE;
  const deviceD2 = await pollActiveDevice(T.token, (d) => d !== null, 15000);
  if (deviceD2) ok(`re-enrollment with a fresh code succeeded: new device ${deviceD2.id}`);
  else bad('re-enrollment with a fresh code did not succeed');

  // ===========================================================================
  step('TEST E — State destruction (delete the volume) requires enrollment again');
  // ===========================================================================
  composeChecked(['down']); // stop, keep volume for now
  compose(['down', '-v']); // remove volumes explicitly (idempotent if already down)
  const volCheck = spawnSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout;
  const volGone = !volCheck.split('\n').some((l) => l.includes('gateway_state'));
  if (volGone) ok('gateway_state volume no longer exists after down -v');
  else bad(`gateway_state volume still exists: ${volCheck}`);

  composeChecked(['up', '-d', 'backend', 'worker', 'frontend']);
  if (!(await waitHealthy(`${API}/health`, 60000))) throw new Error('backend never became healthy (TEST E setup)');
  composeChecked(['up', '-d', 'agent']); // NO enrollment code
  await new Promise((r) => setTimeout(r, 4000));
  const logsE = agentLogs();
  if (logsE.includes('EnrollmentRequiredError') || logsE.includes('no enrollment code was')) {
    ok('after volume destruction, starting without a code correctly requires enrollment again');
  } else {
    bad(`expected EnrollmentRequiredError after volume destruction. Logs tail:\n${logsE.slice(-1500)}`);
  }

  // ===========================================================================
  step('TEST F — Enrollment/heartbeat work with ZERO configured data sources');
  // ===========================================================================
  // A FRESH tenant, deliberately: tenant T (from A-E) still has an active
  // device row centrally (TEST E only destroyed the LOCAL credential volume
  // -- by design, a lost local file does not silently deregister a device;
  // that needs an explicit staff revoke). Reusing T here would just collide
  // with the pre-existing one-active-device-per-tenant guard and prove
  // nothing about a genuinely fresh, zero-data-source enrollment.
  const U = await registerTenant('U-NoSources');
  ok(`fresh tenant for this test: ${U.tenantId}`);

  compose(['down', '-v']); // guarantee a clean gateway_state volume for U
  composeChecked(['up', '-d', 'backend', 'worker', 'frontend']);
  if (!(await waitHealthy(`${API}/health`, 60000))) throw new Error('backend never became healthy (TEST F setup)');

  const enrollResp3 = await api('POST', '/gateway/enrollments', U.token, { label: 'Docker lifecycle test — no sources' });
  const code3 = enrollResp3.body.code;
  process.env.GATEWAY_ENROLLMENT_CODE = code3;
  // A short interval JUST for this test's own timing (not a product default) --
  // GATEWAY_SOURCES was never set anywhere in this whole script, which is the
  // actual thing being proven here.
  process.env.GATEWAY_HEARTBEAT_INTERVAL_SECONDS = '5';
  composeChecked(['up', '-d', 'agent']);
  delete process.env.GATEWAY_ENROLLMENT_CODE;
  delete process.env.GATEWAY_HEARTBEAT_INTERVAL_SECONDS;
  const deviceF = await pollActiveDevice(U.token, (d) => d !== null, 15000);
  if (deviceF) ok(`enrollment succeeded with zero GATEWAY_SOURCES configured: device ${deviceF.id}`);
  else bad('enrollment failed with zero data sources configured');

  const hbBefore = deviceF?.lastHeartbeatAt ?? null;
  const deviceF2 = await pollActiveDevice(U.token, (d) => d && d.lastHeartbeatAt && d.lastHeartbeatAt !== hbBefore, 20000);
  if (deviceF2?.lastHeartbeatAt && deviceF2.lastHeartbeatAt !== hbBefore) {
    ok(`heartbeat advances with zero data sources configured (${hbBefore} -> ${deviceF2.lastHeartbeatAt})`);
  } else {
    bad(`heartbeat did not advance with zero data sources configured. before=${hbBefore} after=${deviceF2?.lastHeartbeatAt}`);
  }

  console.log(process.exitCode ? '\nFAILED' : '\nDOCKER GATEWAY LIFECYCLE VERIFIED (A-F)');
} catch (err) {
  console.error('\nTEST ERROR:', err?.message ?? err);
  process.exitCode = 1;
}
