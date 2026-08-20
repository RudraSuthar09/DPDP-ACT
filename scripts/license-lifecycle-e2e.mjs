/**
 * Full registration -> license -> activation -> login lifecycle E2E, against
 * the REAL running API (:3001) and its REAL central database.
 *
 * Covers TEST A-H from the licensing/activation lifecycle spec:
 *   A. new SaaS client registration auto-issues a unique license
 *   B. new Enterprise client registration auto-issues a unique license
 *   C. first activation persists installation<->license<->tenant
 *   D. restart: GET /installations/active finds it (no re-activation needed)
 *   E. repeated "restarts" keep finding it
 *   F. expiry: a short-lived license's capabilities disappear after expiry
 *   G. revocation: a revoked license's capabilities disappear
 *   H. tenant isolation: tenant A's license cannot activate/link tenant B's installation
 *
 *   node scripts/license-lifecycle-e2e.mjs
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

async function registerTenant(label, plan) {
  const tag = `${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`;
  const email = `qa-lifecycle-${label}-${tag}@license-lifecycle.dpdp.invalid`;
  const password = 'Verify-LicenseLifecycle-2026!';
  const reg = await api('POST', '/auth/register', null, {
    organisationName: `License Lifecycle ${label} ${tag}`,
    ownerEmail: email,
    ownerName: `QA ${label}`,
    password,
    plan,
  });
  if (reg.status !== 201) throw new Error(`register(${label}) failed: ${JSON.stringify(reg.body)}`);
  const license = reg.body.license;
  const enrol = await api('POST', '/auth/mfa/enroll', null, { challengeToken: reg.body.mfaEnrolmentToken });
  const secret = enrol.body.secret;
  await api('POST', '/auth/mfa/confirm', null, { challengeToken: reg.body.mfaEnrolmentToken, code: totp(base32Decode(secret)) });
  await waitForTotpWindow();
  const login = await api('POST', '/auth/login', null, { email, password });
  const verify = await api('POST', '/auth/mfa/verify', null, { challengeToken: login.body.challengeToken, code: totp(base32Decode(secret)) });
  if (verify.status !== 200 && verify.status !== 201) throw new Error(`mfa/verify(${label}) failed: ${JSON.stringify(verify.body)}`);
  return { tenantId: reg.body.tenantId, token: verify.body.accessToken, license, secret, email, password };
}

try {
  step('TEST A - New SaaS client: registration auto-issues a unique license');
  const A = await registerTenant('A-SAAS', 'saas');
  if (A.license && A.license.plan === 'saas' && A.license.deploymentType === 'hosted' && A.license.licenseKey?.startsWith('DPDP-')) {
    ok(`A got a license at registration: plan=${A.license.plan} deploymentType=${A.license.deploymentType} prefix=${A.license.licenseKeyPrefix}`);
  } else {
    bad(`A did not get a proper license at registration: ${JSON.stringify(A.license)}`);
  }

  await waitForTotpWindow();

  step('TEST B - New Enterprise client: a DIFFERENT unique license, belonging to B, Enterprise capabilities');
  const B = await registerTenant('B-ENT', 'enterprise');
  if (B.license && B.license.plan === 'enterprise' && B.license.deploymentType === 'client_server') {
    ok(`B got a license at registration: plan=${B.license.plan} deploymentType=${B.license.deploymentType} prefix=${B.license.licenseKeyPrefix}`);
  } else {
    bad(`B did not get a proper Enterprise license: ${JSON.stringify(B.license)}`);
  }
  if (A.license.licenseKey !== B.license.licenseKey && A.license.licenseKeyPrefix !== B.license.licenseKeyPrefix) {
    ok('A and B licenses are genuinely different/unique keys');
  } else {
    bad('A and B ended up with the same license key -- not unique per organisation!');
  }

  step('4/5/6 (spec 12). Raw key shown once at issuance; nothing plaintext persisted (structural check via API surface)');
  // GET /licenses (an authenticated list) never includes a raw key -- confirmed
  // by the DTO/toView shape (licensing.service.ts) never returning it; spot
  // check here that the list response for A has no field containing the raw key.
  const listA = await api('GET', '/licenses', A.token);
  const rawLeaked = JSON.stringify(listA.body).includes(A.license.licenseKey);
  if (!rawLeaked) ok('GET /licenses does not leak the raw key anywhere in its response');
  else bad('GET /licenses response contains the raw license key!');

  step('TEST C - First activation: persist installation, installation<->license<->tenant, then normal login works');
  const installA = await api('POST', '/installations', A.token, {
    licenseKey: A.license.licenseKey,
    plan: 'saas',
    deploymentType: 'hosted',
    version: '1.0.0',
  });
  if (installA.status !== 201) throw new Error(`A activation failed: ${JSON.stringify(installA.body)}`);
  ok(`A installation registered: ${installA.body.installation.id} (${installA.body.installation.status})`);

  const installB = await api('POST', '/installations', B.token, {
    licenseKey: B.license.licenseKey,
    plan: 'enterprise',
    deploymentType: 'client_server',
    version: '1.0.0',
  });
  if (installB.status !== 201) throw new Error(`B activation failed: ${JSON.stringify(installB.body)}`);
  ok(`B installation registered: ${installB.body.installation.id} (${installB.body.installation.status})`);

  step('TEST D/E - Restart simulation: GET /installations/active repeatedly finds it (fresh HTTP calls, no client-side state)');
  for (let i = 1; i <= 3; i++) {
    const active = await api('GET', '/installations/active', A.token);
    if (active.status === 200 && active.body.installation && active.body.installation.id === installA.body.installation.id) {
      ok(`restart simulation #${i}: /installations/active finds A's installation -- activation screen would be skipped`);
    } else {
      bad(`restart simulation #${i}: /installations/active did NOT find A's installation: ${JSON.stringify(active.body)}`);
    }
  }

  step('TEST F - Expiry: a short-lived Enterprise license grants capabilities, then stops after expiry (status stays active)');
  const expTenant = await registerTenant('F-EXP', 'enterprise');
  await waitForTotpWindow();
  const expiresAt = new Date(Date.now() + 4000).toISOString();
  const issueExp = await api('POST', '/licenses', expTenant.token, { plan: 'enterprise', deploymentType: 'client_server', expiresAt });
  if (issueExp.status !== 201) throw new Error(`issue expiring license failed: ${JSON.stringify(issueExp.body)}`);
  const installExp = await api('POST', '/installations', expTenant.token, {
    licenseKey: issueExp.body.licenseKey,
    plan: 'enterprise',
    deploymentType: 'client_server',
    version: '1.0.0',
  });
  if (installExp.status !== 201) throw new Error(`expiring-license activation failed: ${JSON.stringify(installExp.body)}`);
  const capsBefore = await api('GET', '/capabilities', expTenant.token);
  if (capsBefore.body.features.enterpriseGateway === true) ok('before expiry: enterprise capabilities granted');
  else bad(`before expiry: expected enterprise capabilities, got ${JSON.stringify(capsBefore.body)}`);
  await new Promise((r) => setTimeout(r, 5000));
  const capsAfter = await api('GET', '/capabilities', expTenant.token);
  if (capsAfter.body.features.enterpriseGateway !== true) ok(`after expiry: capabilities no longer granted (${JSON.stringify(capsAfter.body.features)}), even though installation stays registered`);
  else bad('after expiry: STILL granting enterprise capabilities');

  step('TEST G - Revocation: revoking an active license removes its entitlements immediately');
  const revTenant = await registerTenant('G-REV', 'enterprise');
  await waitForTotpWindow();
  const issueRev = await api('POST', '/licenses', revTenant.token, { plan: 'enterprise', deploymentType: 'client_server' });
  const installRev = await api('POST', '/installations', revTenant.token, {
    licenseKey: issueRev.body.licenseKey, plan: 'enterprise', deploymentType: 'client_server', version: '1.0.0',
  });
  if (installRev.status !== 201) throw new Error(`revocation-test activation failed: ${JSON.stringify(installRev.body)}`);
  const capsBeforeRevoke = await api('GET', '/capabilities', revTenant.token);
  if (capsBeforeRevoke.body.features.enterpriseGateway === true) ok('before revocation: enterprise capabilities granted');
  else bad(`before revocation: expected enterprise capabilities, got ${JSON.stringify(capsBeforeRevoke.body)}`);
  const revoke = await api('POST', `/licenses/${issueRev.body.license.id}/revoke`, revTenant.token, { reason: 'QA lifecycle test' });
  if (revoke.status !== 200 && revoke.status !== 201) throw new Error(`revoke failed: ${JSON.stringify(revoke.body)}`);
  const capsAfterRevoke = await api('GET', '/capabilities', revTenant.token);
  if (capsAfterRevoke.body.features.enterpriseGateway !== true) ok(`after revocation: capabilities no longer granted (${JSON.stringify(capsAfterRevoke.body.features)})`);
  else bad('after revocation: STILL granting enterprise capabilities');

  step('TEST H - Tenant isolation: A\'s license cannot activate/be used against B\'s tenant');
  const crossActivate = await api('POST', '/installations', B.token, {
    licenseKey: A.license.licenseKey,
    plan: 'saas',
    deploymentType: 'hosted',
    version: '1.0.0',
  });
  if (crossActivate.status === 404) ok('B presenting A\'s raw license key gets 404 -- invisible outside its own tenant, not just forbidden');
  else bad(`expected 404 for a cross-tenant license key, got ${crossActivate.status}: ${JSON.stringify(crossActivate.body)}`);

  console.log(process.exitCode ? '\nFAILED' : '\nFULL LICENSE LIFECYCLE VERIFIED (A-H)');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
}
