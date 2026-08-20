/**
 * Focused E2E for the license-hardening fix: runtime expiry enforcement.
 *
 * Proves, against the REAL running API (:3001) and its REAL central database,
 * that CapabilityService.resolve() -> LicensingService.findActiveForTenant()
 * stops treating a license as usable the moment it passes expires_at, even
 * though its stored `status` stays 'active' (no sweeper flips it -- see the
 * migration/repository comments). This is the one behavior
 * deployment-topologies-e2e.mjs does not already cover (it never lets a
 * license actually reach its expiry while active).
 *
 *   node scripts/license-expiry-e2e.mjs
 * Needs: API :3001 running against a real Postgres with all migrations applied.
 */
const API = 'http://localhost:3001';
const ok = (s) => console.log('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`);

const { totp } = await import(new URL('../backend/dist/modules/identity/crypto/totp.js', import.meta.url));
const { base32Decode } = await import(new URL('../backend/dist/modules/identity/crypto/base32.js', import.meta.url));

async function api(method, path, token, body) {
  const r = await fetch(`${API}${path}`, {
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
  const email = `qa-license-expiry-${label}-${tag}@license-expiry.dpdp.invalid`;
  const password = 'Verify-LicenseExpiry-2026!';
  const reg = await api('POST', '/auth/register', null, {
    organisationName: `License Expiry ${label} ${tag}`,
    ownerEmail: email,
    ownerName: `QA ${label}`,
    password,
  });
  if (reg.status !== 201) throw new Error(`register(${label}) failed: ${JSON.stringify(reg.body)}`);
  const enrol = await api('POST', '/auth/mfa/enroll', null, { challengeToken: reg.body.mfaEnrolmentToken });
  const secret = enrol.body.secret;
  await api('POST', '/auth/mfa/confirm', null, { challengeToken: reg.body.mfaEnrolmentToken, code: totp(base32Decode(secret)) });
  await waitForTotpWindow();
  const login = await api('POST', '/auth/login', null, { email, password });
  const verify = await api('POST', '/auth/mfa/verify', null, { challengeToken: login.body.challengeToken, code: totp(base32Decode(secret)) });
  if (verify.status !== 200 && verify.status !== 201) throw new Error(`mfa/verify(${label}) failed: ${JSON.stringify(verify.body)}`);
  return { tenantId: reg.body.tenantId, token: verify.body.accessToken };
}

try {
  step('Register a tenant that will hold a SHORT-LIVED Enterprise/client_server license');
  const T = await registerTenant('EXP');
  ok(`tenant: ${T.tenantId}`);

  step('1. Issue + activate a license that expires in a few seconds');
  const expiresAt = new Date(Date.now() + 4000).toISOString();
  const issue = await api('POST', '/licenses', T.token, { plan: 'enterprise', deploymentType: 'client_server', expiresAt });
  if (issue.status !== 201) throw new Error(`issue failed: ${JSON.stringify(issue.body)}`);
  ok(`license issued, expiresAt=${expiresAt}`);

  const install = await api('POST', '/installations', T.token, {
    licenseKey: issue.body.licenseKey,
    plan: 'enterprise',
    deploymentType: 'client_server',
    version: '1.0.0',
  });
  if (install.status !== 201) throw new Error(`activation failed: ${JSON.stringify(install.body)}`);
  ok(`installation registered + license activated: ${install.body.installation.id}`);

  step('2. Active, UNEXPIRED license: capabilities reflect the license (enterprise, enterpriseGateway=true)');
  const capsBefore = await api('GET', '/capabilities', T.token);
  if (capsBefore.body.plan === 'enterprise' && capsBefore.body.features.enterpriseGateway === true) {
    ok(`capabilities while unexpired: ${JSON.stringify(capsBefore.body.features)}`);
  } else {
    bad(`expected enterprise capabilities while unexpired, got ${JSON.stringify(capsBefore.body)}`);
  }

  step('3. Wait past expires_at (license row stays status=active in storage -- no sweeper)');
  await new Promise((r) => setTimeout(r, 5000));

  step('4. Active but EXPIRED license: capabilities must NOT continue granting the licensed entitlement');
  const capsAfter = await api('GET', '/capabilities', T.token);
  // organisations.plan/deployment_type default to saas/hosted (see
  // 1737002900000_org-plan-deployment-type.sql) -- this tenant never set them,
  // so falling back to org defaults means plan flips away from 'enterprise'
  // and enterpriseGateway drops to false the moment the license stops counting.
  if (capsAfter.body.plan !== 'enterprise' || capsAfter.body.features.enterpriseGateway !== true) {
    ok(`capabilities after expiry no longer reflect the expired license: ${JSON.stringify(capsAfter.body)}`);
  } else {
    bad(`expired license STILL granting enterprise capabilities: ${JSON.stringify(capsAfter.body)}`);
  }

  console.log(process.exitCode ? '\nFAILED' : '\nLICENSE EXPIRY ENFORCEMENT VERIFIED');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
}
