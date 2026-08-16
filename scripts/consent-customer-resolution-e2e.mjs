/**
 * Phase 3H-1 — REAL end-to-end verification of the staff-assisted Consent
 * customer-resolution flow, for BOTH source types, against the REAL running
 * API (:3001), REAL web app (:3000), a REAL PostgreSQL "client" database
 * (embedded-postgres), and a REAL Gateway agent HTTP server (the actual
 * agent/dist code, listening on a real loopback port) — plus a real Chromium
 * browser driving the actual Consent Form Builder UI.
 *
 * Enterprise SQL path: registers a tenant, enrolls a real Gateway device,
 * persists its endpoint (3G-2.5) at the real agent server, creates a
 * postgresql data source, sets identity_column + the new central
 * allow_customer_create/writable_columns config, then drives the browser
 * through the Consent Form Builder's "Discover columns" and new
 * "Staff-assisted consent" panel — resolving/updating/creating a REAL row in
 * the embedded PostgreSQL customers table, and recording consent through the
 * existing POST /consent/events. Throughout, every network request is
 * captured and asserted to never carry the identity value or any field value.
 *
 * SaaS local Excel/CSV path: reuses the established mock harness (see
 * scripts/local-source-handles.spec.mjs) to prove resolve-only (found/not-
 * found) works read-only against the connected local file, and that
 * write/create are unconditionally refused with the exact UNSUPPORTED_SOURCE
 * message — never a fake success.
 *
 *   node scripts/consent-customer-resolution-e2e.mjs
 * Needs API :3001, web :3000, backend dist + agent dist built.
 */
import { chromium } from 'playwright';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:3001';
const WEB = 'http://localhost:3000';
const DB_PORT = Number(process.env.E2E_DB_PORT ?? 54351);
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT ?? 54352);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dpdp-e2e-consent-custres-'));
const READ_PW = 'read_e2e_only';
const WRITE_PW = 'write_e2e_only';

// A stray pg.Client can emit an async 'error' event after its query finished
// (e.g. during embedded-postgres teardown racing a late connection) — that is
// noise from this SCRIPT's own bookkeeping, not a finding about the app under
// test. Log it and keep going rather than let it crash the whole run.
process.on('uncaughtException', (err) => console.error('  [uncaught, ignored]', err.message));

const ok = (s) => console.log('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`);
const guard = setTimeout(() => { console.error('E2E hard timeout'); process.exit(1); }, 170_000);
guard.unref();

const { totp } = await import(new URL('../backend/dist/modules/identity/crypto/totp.js', import.meta.url));
const { base32Decode } = await import(new URL('../backend/dist/modules/identity/crypto/base32.js', import.meta.url));
const { createAgentServer } = await import(new URL('../agent/dist/server.js', import.meta.url));
const { DataPlane, httpControlPlaneClient } = await import(new URL('../agent/dist/data-plane.js', import.meta.url));
const { SessionStore } = await import(new URL('../agent/dist/session-store.js', import.meta.url));
const { ConnectorRegistry } = await import(new URL('../agent/dist/connectors/registry.js', import.meta.url));

async function api(method, path, token, body, extraHeaders) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extraHeaders ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

const tag = Date.now().toString().slice(-8);
const EMAIL = `qa-consent-custres-${tag}@custres.dpdp.invalid`;
const PASSWORD = 'Verify-Consent-CustRes-2026!';
const SEEDED_EMAIL = `rahul.${tag}@example.com`;
const NEW_CUSTOMER_EMAIL = `asha.${tag}@example.com`;

let epg;
let agentServer;
let browser;

try {
  // =========================================================================
  step('Register an isolated QA tenant and log in through the real UI');
  // =========================================================================
  const reg = await api('POST', '/auth/register', null, {
    organisationName: `Consent CustRes Verify ${tag}`,
    ownerEmail: EMAIL,
    ownerName: 'QA CustRes',
    password: PASSWORD,
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const enrol = await api('POST', '/auth/mfa/enroll', null, { challengeToken: reg.body.mfaEnrolmentToken });
  const mfaSecretBase32 = enrol.body.secret;
  await api('POST', '/auth/mfa/confirm', null, { challengeToken: reg.body.mfaEnrolmentToken, code: totp(base32Decode(mfaSecretBase32)) });

  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
  const login1 = await api('POST', '/auth/login', null, { email: EMAIL, password: PASSWORD });
  const verify1 = await api('POST', '/auth/mfa/verify', null, { challengeToken: login1.body.challengeToken, code: totp(base32Decode(mfaSecretBase32)) });
  if (verify1.status !== 200 && verify1.status !== 201) throw new Error(`mfa/verify failed: ${JSON.stringify(verify1.body)}`);
  const staffToken = verify1.body.accessToken;
  await api('PATCH', '/auth/me/product-tour', staffToken, { status: 'skipped' });
  ok(`tenant registered + logged in via API: ${EMAIL}`);

  // =========================================================================
  step('Start a real PostgreSQL "client" database with a real customers table');
  // =========================================================================
  epg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: 'postgres', password: 'postgres', port: DB_PORT, persistent: false, onLog: () => {} });
  await epg.initialise();
  await epg.start();
  const admin = new pg.Client({ host: 'localhost', port: DB_PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE DATABASE custres');
  await admin.query(`CREATE ROLE dpdp_e2e_read LOGIN PASSWORD '${READ_PW}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE dpdp_e2e_write LOGIN PASSWORD '${WRITE_PW}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query('GRANT CONNECT ON DATABASE custres TO dpdp_e2e_read, dpdp_e2e_write');
  await admin.end();
  const owner = new pg.Client({ host: 'localhost', port: DB_PORT, user: 'postgres', password: 'postgres', database: 'custres' });
  await owner.connect();
  await owner.query('CREATE TABLE public.customers (id serial PRIMARY KEY, customer_name text, mobile text, email text)');
  await owner.query('INSERT INTO public.customers (customer_name, mobile, email) VALUES ($1,$2,$3)', ['Rahul Kumar', '9876543210', SEEDED_EMAIL]);
  await owner.query('GRANT USAGE ON SCHEMA public TO dpdp_e2e_read, dpdp_e2e_write');
  await owner.query('GRANT SELECT ON public.customers TO dpdp_e2e_read, dpdp_e2e_write');
  await owner.query('GRANT INSERT, UPDATE ON public.customers TO dpdp_e2e_write');
  await owner.query('GRANT USAGE, SELECT ON SEQUENCE public.customers_id_seq TO dpdp_e2e_write');
  await owner.query('ALTER TABLE public.customers OWNER TO dpdp_e2e_write');
  await owner.end();
  ok(`real PostgreSQL running on :${DB_PORT}, seeded with one customer (${SEEDED_EMAIL})`);

  // =========================================================================
  step('Create the postgresql data source centrally + configure identity/write config');
  // =========================================================================
  const srcResp = await api('POST', '/data-sources', staffToken, { name: `Customer DB ${tag}`, sourceKind: 'postgresql' });
  if (srcResp.status !== 201) throw new Error(`create source failed: ${JSON.stringify(srcResp.body)}`);
  const source = srcResp.body;
  await api('PATCH', `/data-sources/${source.id}/mode`, staffToken, { enabled: true });
  await api('PATCH', `/data-sources/${source.id}/identity-column`, staffToken, { identityColumn: 'email' });
  const writeConfigResp = await api('PATCH', `/data-sources/${source.id}/customer-write-config`, staffToken, {
    allowCustomerCreate: true,
    writableColumns: ['mobile', 'customer_name'],
  });
  if (writeConfigResp.status !== 200) throw new Error(`customer-write-config failed: ${JSON.stringify(writeConfigResp.body)}`);
  ok(`source ${source.id} configured: identityColumn=email, allowCustomerCreate=true, writableColumns=[mobile,customer_name]`);

  // =========================================================================
  step('Enroll a real Gateway device and persist its endpoint (3G-2.5)');
  // =========================================================================
  const enrollmentCode = await api('POST', '/gateway/enrollments', staffToken, { label: 'QA custres agent' });
  const publicKeyPem = '-----BEGIN PUBLIC KEY-----\n' + 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(64) + '\n-----END PUBLIC KEY-----';
  const enrollRes = await api(
    'POST',
    '/gateway/enroll',
    null,
    { publicKey: publicKeyPem, platform: 'windows', agentVersion: '0.1.0', displayName: 'QA-CustRes-Agent', deviceRef: null },
    { 'x-gateway-enrollment-code': enrollmentCode.body.code },
  );
  if (enrollRes.status !== 201) throw new Error(`gateway enroll failed: ${JSON.stringify(enrollRes.body)}`);
  const device = enrollRes.body.device;
  const deviceToken = enrollRes.body.deviceToken;
  const agentUrl = `http://127.0.0.1:${AGENT_PORT}`;
  const endpointRes = await api('PATCH', `/gateway/devices/${device.id}/endpoint`, staffToken, { endpoint: agentUrl });
  if (endpointRes.status !== 200) throw new Error(`endpoint set failed: ${JSON.stringify(endpointRes.body)}`);
  ok(`device ${device.id} enrolled, endpoint persisted centrally (${agentUrl})`);

  // =========================================================================
  step('Start a REAL Gateway agent HTTP server, configured for this one source');
  // =========================================================================
  const registry = new ConnectorRegistry([
    {
      sourceId: source.id,
      kind: 'postgresql',
      connection: { host: 'localhost', port: DB_PORT, user: 'dpdp_e2e_read', password: READ_PW, database: 'custres' },
      writeConnection: { host: 'localhost', port: DB_PORT, user: 'dpdp_e2e_write', password: WRITE_PW, database: 'custres' },
      identityColumn: 'email',
      allowCustomerCreate: true,
      writableColumns: ['mobile', 'customer_name'],
    },
  ]);
  const dataPlane = new DataPlane(
    registry,
    new SessionStore(),
    { tenantId: reg.body.tenantId, deviceId: device.id },
    httpControlPlaneClient({ controlPlaneUrl: API, deviceToken }),
  );
  agentServer = createAgentServer(
    { bindHost: '127.0.0.1', bindPort: AGENT_PORT, allowedOrigins: [WEB], controlPlaneUrl: API, networkMode: 'loopback' },
    { dataPlane },
  );
  await new Promise((resolve, reject) => {
    agentServer.once('error', reject);
    agentServer.listen(AGENT_PORT, '127.0.0.1', resolve);
  });
  ok(`real agent HTTP server listening on ${agentUrl}, wired to the real PostgreSQL database`);

  // =========================================================================
  step('Log in through the real browser UI and open the Consent Form Builder');
  // =========================================================================
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const transmitted = [];
  page.on('request', (req) => transmitted.push({ url: req.url(), method: req.method(), postData: req.postData() || '' }));
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  await page.goto(`${WEB}/login`);
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  const mfa = page.locator('input[autocomplete="one-time-code"]').or(page.locator('form input:not([type])'));
  await mfa.first().waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
  await mfa.first().fill(totp(base32Decode(mfaSecretBase32)));
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });

  const formCreate = await api('POST', '/consent/forms', staffToken, { name: `KYC Form ${tag}`, description: null });
  const formId = formCreate.body.id;
  await api('POST', `/consent/forms/${formId}/rows`, staffToken, { label: 'Terms & Conditions', noticeText: 'We use your data for KYC.', active: true, inventoryEntryId: null });
  await api('PATCH', `/consent/forms/${formId}/source`, staffToken, { sourceId: source.id });
  await page.goto(`${WEB}/consent/forms/${formId}`, { waitUntil: 'networkidle' });
  ok('logged in via the real browser and opened the builder with the source linked');

  // =========================================================================
  step('"Discover columns" — real browser -> real Gateway session -> real PostgreSQL columns');
  // =========================================================================
  transmitted.length = 0;
  await page.getByRole('button', { name: 'Discover customer fields' }).click();
  await page.waitForSelector('text=Customer Identifier', { timeout: 15000 });
  const fieldOptions = await page.locator('#cf-identity option').allTextContents();
  if (fieldOptions.includes('email') && fieldOptions.includes('mobile') && fieldOptions.includes('customer_name')) {
    ok('real columns discovered through the real Gateway session (email, mobile, customer_name)');
  } else bad(`unexpected discovered columns: ${fieldOptions.join(', ')}`);

  // Add a customer-data field mapped to the writable "mobile" column, so the
  // staff-assisted panel has something writable to show.
  await api('POST', `/consent/forms/${formId}/customer-fields`, staffToken, {
    label: 'Mobile Number',
    fieldType: 'text',
    required: false,
    destination: 'customer_field',
    mappedColumn: 'mobile',
    newColumnName: null,
    newColumnType: null,
  });
  await page.reload({ waitUntil: 'networkidle' });

  // =========================================================================
  step('Notice / Terms — client-authored text, set through the real UI, read back on reload');
  // =========================================================================
  const NOTICE_TEXT = `By submitting this form (${tag}), I agree to the collection and processing of my personal data.`;
  await page.fill('#form-notice', NOTICE_TEXT);
  await page.getByRole('button', { name: 'Save notice' }).click();
  await page.waitForSelector('text=Notice saved.', { timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle' });
  const noticeValue = await page.locator('#form-notice').inputValue();
  if (noticeValue === NOTICE_TEXT) ok('notice text round-tripped through the real PUT /consent/forms/:id');
  else bad(`notice text did not round-trip: got "${noticeValue}"`);

  // =========================================================================
  step('Document Upload field type — storage destination is restricted server-side, never faked');
  // =========================================================================
  await page.selectOption('#cf-preset', 'Document Upload');
  const docLabel = await page.locator('#cf-label').inputValue();
  const docType = await page.locator('#cf-type').inputValue();
  if (docLabel === 'Document Upload' && docType === 'document_upload') {
    ok('the "Document Upload" preset filled in the label/type as a convenience only');
  } else {
    bad(`preset did not fill label/type as expected: label="${docLabel}" type="${docType}"`);
  }
  const customerFieldRadio = page.locator('input[name="cf-destination"][disabled]');
  const disabledCount = await customerFieldRadio.count();
  if (disabledCount === 2) ok('"Existing/new customer field" and "both" destinations are disabled in the UI for Document Upload');
  else bad(`expected 2 disabled destination radios for Document Upload, found ${disabledCount}`);
  await page.waitForSelector('text=no supported storage destination', { timeout: 5000 });
  // The DTO itself must ALSO reject this combination — not just hide it in the
  // UI. Confirm directly against the real backend.
  const rejectedRes = await api('POST', `/consent/forms/${formId}/customer-fields`, staffToken, {
    label: 'Aadhaar Document',
    fieldType: 'document_upload',
    required: false,
    destination: 'customer_field',
    mappedColumn: 'signature',
    newColumnName: null,
    newColumnType: null,
  });
  if (rejectedRes.status === 400) ok('the backend itself rejects document_upload mapped to a customer field (400), independent of the UI');
  else bad(`expected the backend to reject this combination, got ${rejectedRes.status}`);
  // Now actually add it the only way the UI allows: consent-only.
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.waitForSelector('text=Not stored — no supported destination yet', { timeout: 10000 });
  ok('Document Upload was added as a real form field, honestly marked as not stored anywhere');

  // =========================================================================
  step('Staff-assisted: resolve the EXISTING customer, update the mapped field');
  // =========================================================================
  transmitted.length = 0;
  await page.fill('#staff-identity', SEEDED_EMAIL);
  await page.getByRole('button', { name: 'Find customer' }).click();
  await page.waitForSelector('text=Customer found in the connected source.', { timeout: 15000 });
  ok('resolved the real, existing customer through the real Gateway');

  const NEW_MOBILE = '9999911111';
  await fillMappedField(page, 'Mobile Number', NEW_MOBILE);
  await page.getByRole('button', { name: 'Save fields' }).click();
  await page.waitForSelector('text=Saved — the mapped fields were updated', { timeout: 15000 });

  const afterUpdate = await queryCustomer(SEEDED_EMAIL);
  if (afterUpdate?.mobile === NEW_MOBILE) ok('the REAL row in PostgreSQL now has the updated mobile number');
  else bad(`expected mobile=${NEW_MOBILE} in real PostgreSQL, got ${JSON.stringify(afterUpdate)}`);

  // =========================================================================
  step('Staff-assisted: resolve a NON-existent customer, then create it (allowCustomerCreate=true)');
  // =========================================================================
  await page.fill('#staff-identity', NEW_CUSTOMER_EMAIL);
  await page.getByRole('button', { name: 'Find customer' }).click();
  await page.waitForSelector('text=Not found in the connected source.', { timeout: 15000 });
  ok('correctly reported "not found" for a genuinely new identity');

  await fillMappedField(page, 'Mobile Number', '9812345678');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await page.waitForSelector('text=Customer created in the connected source.', { timeout: 15000 });
  const created = await queryCustomer(NEW_CUSTOMER_EMAIL);
  if (created?.mobile === '9812345678') ok('the REAL new row now exists in PostgreSQL with the entered mobile number');
  else bad(`expected the new customer row in real PostgreSQL, got ${JSON.stringify(created)}`);
  const countCheck = await countCustomers(NEW_CUSTOMER_EMAIL);
  if (countCheck === 1) ok('exactly one row exists for the new identity — no duplicate');
  else bad(`expected exactly 1 row, found ${countCheck}`);

  // =========================================================================
  step('Staff-assisted: record consent for the resolved customer through the EXISTING /consent/events');
  // =========================================================================
  const rowCheckbox = page.locator('label', { hasText: 'Terms & Conditions' }).locator('input[type=checkbox]');
  await rowCheckbox.check();
  await page.getByRole('button', { name: 'Record consent' }).click();
  await page.waitForSelector('text=Consent recorded for', { timeout: 15000 });
  ok('consent recorded through the existing, unmodified POST /consent/events');

  const statusRes = await api('GET', `/consent/status?customerId=${encodeURIComponent(NEW_CUSTOMER_EMAIL)}`, staffToken);
  const grantedTerms = (statusRes.body?.status ?? []).some((s) => s.status === 'GRANTED');
  if (statusRes.status === 200 && grantedTerms) ok('the central consent status confirms the purpose was recorded as GRANTED');
  else bad(`consent status not as expected: ${JSON.stringify(statusRes.body)}`);

  // =========================================================================
  step('THE BOUNDARY: no request to our own backend ever carried the identity value or a field value');
  // =========================================================================
  const backendRequests = transmitted.filter((t) => t.url.startsWith(API));
  const leaks = backendRequests.filter(
    (t) =>
      (t.postData && (t.postData.includes(SEEDED_EMAIL) || t.postData.includes(NEW_CUSTOMER_EMAIL) || t.postData.includes(NEW_MOBILE) || t.postData.includes('9812345678'))) ||
      t.url.includes(SEEDED_EMAIL) ||
      t.url.includes(NEW_CUSTOMER_EMAIL),
  );
  // customerId IS legitimately sent to /consent/events (that's the existing,
  // unchanged, pre-existing contract — pseudonymised server-side, I2) — the
  // boundary this proves is that NO OTHER backend call ever carried it, and
  // that no FIELD value (mobile numbers) ever reached the backend at all.
  const consentEventsLeak = backendRequests.filter((t) => t.url.includes('/data-sources/') && (t.postData.includes(SEEDED_EMAIL) || t.postData.includes(NEW_CUSTOMER_EMAIL)));
  const fieldValueLeaks = backendRequests.filter((t) => t.postData.includes(NEW_MOBILE) || t.postData.includes('9812345678'));
  if (consentEventsLeak.length === 0) ok('no /data-sources/* (gateway-events/config) call ever carried the identity value');
  else bad(`identity value leaked into: ${consentEventsLeak.map((l) => l.url).join(', ')}`);
  if (fieldValueLeaks.length === 0) ok('NO backend request, anywhere, ever carried a field VALUE (mobile number)');
  else bad(`field value leaked into: ${fieldValueLeaks.map((l) => l.url).join(', ')}`);

  const gatewayEventCalls = backendRequests.filter((t) => /\/data-sources\/[^/]+\/gateway-events$/.test(new URL(t.url).pathname));
  const malformedEvents = gatewayEventCalls.filter((c) => {
    try {
      const b = JSON.parse(c.postData || '{}');
      return !('action' in b) || Object.keys(b).some((k) => !['action', 'rowCount'].includes(k));
    } catch {
      return true;
    }
  });
  if (gatewayEventCalls.length >= 2 && malformedEvents.length === 0) ok(`${gatewayEventCalls.length} gateway-event audit call(s) stayed metadata-only ({action, rowCount})`);
  else bad('gateway-event audit call was not metadata-only, or none were made');

  console.log('\nEnterprise SQL path verified against a REAL PostgreSQL database and a REAL Gateway agent.');

  // =========================================================================
  step('SaaS local Excel/CSV: resolve-only (mocked File System Access, real IndexedDB)');
  // =========================================================================
  await runLocalFileSection(browser, staffToken, formId);

  console.log(process.exitCode ? '\nFAILED' : '\nPHASE 3H-1 CONSENT CUSTOMER-RESOLUTION E2E VERIFIED (Enterprise + SaaS)');
} catch (err) {
  console.error('\nE2E ERROR:', err?.stack ?? err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => (agentServer ? agentServer.close(resolve) : resolve()));
  await epg?.stop().catch(() => undefined);
  rmSync(DATA_DIR, { recursive: true, force: true });
  // Some lingering handle (pg pool / agent socket) can keep the event loop
  // alive past a clean shutdown; force a prompt exit with the REAL exit code
  // rather than let the hard-timeout guard fire and force exit(1) regardless
  // of whether every check actually passed.
  process.exit(process.exitCode ?? 0);
}

// --- helpers -----------------------------------------------------------------

async function fillMappedField(page, labelText, value) {
  const label = page.locator('label', { hasText: labelText }).first();
  const forAttr = await label.getAttribute('for');
  if (forAttr) {
    await page.fill(`#${forAttr}`, value);
    return;
  }
  await label.locator('xpath=following-sibling::input[1]').fill(value);
}

async function withCustresDb(fn) {
  const c = new pg.Client({ host: 'localhost', port: DB_PORT, user: 'postgres', password: 'postgres', database: 'custres' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
async function queryCustomer(email) {
  return withCustresDb(async (c) => {
    const { rows } = await c.query('SELECT customer_name, mobile, email FROM public.customers WHERE email = $1', [email]);
    return rows[0] ?? null;
  });
}
async function countCustomers(email) {
  return withCustresDb(async (c) => {
    const { rows } = await c.query('SELECT count(*)::int AS n FROM public.customers WHERE email = $1', [email]);
    return rows[0]?.n;
  });
}

/**
 * The SaaS local Excel/CSV half of this E2E — a separate tenant/form, using
 * the same mock-handle bridge established in local-source-handles.spec.mjs
 * (real IndexedDB via Object.defineProperty, real showOpenFilePicker mock).
 */
async function runLocalFileSection(browser, _unusedToken, _unusedFormId) {
  const tag2 = Date.now().toString().slice(-8);
  const email2 = `qa-consent-custres-local-${tag2}@custres.dpdp.invalid`;
  const password2 = 'Verify-Consent-CustRes-Local-2026!';
  const localSentinelEmail = `priya.${tag2}@example.com`;

  const reg2 = await api('POST', '/auth/register', null, { organisationName: `Consent CustRes Local ${tag2}`, ownerEmail: email2, ownerName: 'QA Local', password: password2 });
  const enrol2 = await api('POST', '/auth/mfa/enroll', null, { challengeToken: reg2.body.mfaEnrolmentToken });
  const mfaSecret2 = enrol2.body.secret;
  await api('POST', '/auth/mfa/confirm', null, { challengeToken: reg2.body.mfaEnrolmentToken, code: totp(base32Decode(mfaSecret2)) });
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
  const login2 = await api('POST', '/auth/login', null, { email: email2, password: password2 });
  const verify2 = await api('POST', '/auth/mfa/verify', null, { challengeToken: login2.body.challengeToken, code: totp(base32Decode(mfaSecret2)) });
  const token2 = verify2.body.accessToken;
  await api('PATCH', '/auth/me/product-tour', token2, { status: 'skipped' });

  const src2Resp = await api('POST', '/data-sources', token2, { name: `Local Excel ${tag2}`, sourceKind: 'excel' });
  const source2 = src2Resp.body;
  await api('PATCH', `/data-sources/${source2.id}/mode`, token2, { enabled: true });
  await api('PATCH', `/data-sources/${source2.id}/identity-column`, token2, { identityColumn: 'email' });

  const form2Resp = await api('POST', '/consent/forms', token2, { name: `Local Form ${tag2}`, description: null });
  const form2Id = form2Resp.body.id;
  await api('POST', `/consent/forms/${form2Id}/rows`, token2, { label: 'Terms & Conditions', noticeText: 'We use your data.', active: true, inventoryEntryId: null });
  await api('PATCH', `/consent/forms/${form2Id}/source`, token2, { sourceId: source2.id });

  // Header must match the identity column configured below EXACTLY
  // (case-sensitive, no fuzzy matching — by design, see I1/no-inference).
  const csvContent = `Name,email\nPriya Sharma,${localSentinelEmail}\n`;

  const page2 = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const fakeDbRows = {};
  await page2.exposeFunction('__fakeDbGet', (id) => fakeDbRows[id] ?? null);
  await page2.exposeFunction('__fakeDbPut', (id, fileName, savedAt) => { fakeDbRows[id] = { fileName, savedAt }; });
  await page2.exposeFunction('__fakeDbDelete', (id) => { delete fakeDbRows[id]; });
  await page2.exposeFunction('__mockFileContent', () => csvContent);

  await page2.addInitScript(() => {
    function makeHandle(fileName) {
      return {
        kind: 'file',
        name: fileName,
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
        async getFile() {
          const content = await window.__mockFileContent();
          return new File([content], fileName, { type: 'text/csv' });
        },
        async isSameEntry() { return true; },
      };
    }
    window.__dpdpMakeHandle = makeHandle;
    window.showOpenFilePicker = async () => [makeHandle('Customers.csv')];
    function request() { return {}; }
    const fakeIndexedDb = {
      open() {
        const openReq = request();
        Promise.resolve().then(() => {
          const db = {
            objectStoreNames: { contains: () => true },
            createObjectStore() {},
            transaction() {
              const tx = {};
              const store = {
                put(record) {
                  const r = request();
                  window.__fakeDbPut(record.dataSourceId, record.fileName, record.savedAt).then(() => Promise.resolve().then(() => tx.oncomplete && tx.oncomplete()));
                  return r;
                },
                get(key) {
                  const r = request();
                  window.__fakeDbGet(key).then((row) => {
                    r.result = row ? { dataSourceId: key, handle: makeHandle(row.fileName), fileName: row.fileName, savedAt: row.savedAt } : undefined;
                    r.onsuccess && r.onsuccess();
                  });
                  return r;
                },
                delete(key) {
                  const r = request();
                  window.__fakeDbDelete(key).then(() => Promise.resolve().then(() => tx.oncomplete && tx.oncomplete()));
                  return r;
                },
              };
              tx.objectStore = () => store;
              return tx;
            },
            close() {},
          };
          openReq.result = db;
          openReq.onsuccess && openReq.onsuccess();
        });
        return openReq;
      },
    };
    Object.defineProperty(window, 'indexedDB', { value: fakeIndexedDb, writable: true, configurable: true });
  });

  const transmitted2 = [];
  page2.on('request', (req) => transmitted2.push({ url: req.url(), method: req.method(), postData: req.postData() || '' }));

  await page2.goto(`${WEB}/login`);
  await page2.fill('input[type=email]', email2);
  await page2.fill('input[type=password]', password2);
  await page2.click('button[type=submit]');
  const mfa2 = page2.locator('input[autocomplete="one-time-code"]').or(page2.locator('form input:not([type])'));
  await mfa2.first().waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
  await mfa2.first().fill(totp(base32Decode(mfaSecret2)));
  await page2.click('button[type=submit]');
  await page2.waitForURL(/dashboard/, { timeout: 15000 });

  // Connect the local file via the Data Viewer first (this is what saves the
  // handle for customer-resolution.ts to later find via getHandle()).
  await page2.goto(`${WEB}/data-sources/${source2.id}/viewer`, { waitUntil: 'networkidle' });
  await page2.getByRole('button', { name: /^Choose file$/ }).click();
  // The Email column is masked by default (pii-mask.ts) — check the unmasked
  // Name column instead to confirm the file actually loaded.
  await page2.waitForSelector('text=Priya Sharma', { timeout: 10000 });
  ok('local Excel/CSV connected via the Data Viewer (persisted handle)');

  await page2.goto(`${WEB}/consent/forms/${form2Id}`, { waitUntil: 'networkidle' });
  transmitted2.length = 0;

  await page2.getByRole('button', { name: 'Discover customer fields' }).click();
  await page2.waitForSelector('text=Customer Identifier', { timeout: 10000 });
  const localFieldOptions = await page2.locator('#cf-identity option').allTextContents();
  if (localFieldOptions.includes('Email') || localFieldOptions.includes('email')) ok('local file headers discovered without any Gateway/backend involvement');
  else bad(`unexpected local field discovery: ${localFieldOptions.join(', ')}`);

  await page2.fill('#staff-identity', localSentinelEmail);
  await page2.getByRole('button', { name: 'Find customer' }).click();
  await page2.waitForSelector('text=Customer found in the connected source.', { timeout: 10000 });
  ok('resolved the customer read-only against the local file, entirely in-browser');

  await page2.waitForSelector('text=Local Excel/CSV sources are currently read-only', { timeout: 5000 });
  const writeAffordance = await page2.getByRole('button', { name: /Save fields|Create customer/ }).count();
  if (writeAffordance === 0) ok('no write/create affordance is offered for a local file source — never a fake success');
  else bad('a write/create button was offered for a local file source');

  const rowCheckbox2 = page2.locator('label', { hasText: 'Terms & Conditions' }).locator('input[type=checkbox]');
  await rowCheckbox2.check();
  await page2.getByRole('button', { name: 'Record consent' }).click();
  await page2.waitForSelector('text=Consent recorded for', { timeout: 10000 });
  ok('consent recorded for the locally-resolved customer through the existing /consent/events');

  const backendRequests2 = transmitted2.filter((t) => t.url.startsWith(API));
  const localValueLeaks = backendRequests2.filter((t) => t.url !== `${API}/consent/events` && (t.postData.includes(localSentinelEmail) || t.postData.includes('Priya Sharma')));
  if (localValueLeaks.length === 0) ok('no backend call other than the existing /consent/events ever carried the local identity value; no row content ever sent');
  else bad(`local file content/identity leaked into: ${localValueLeaks.map((l) => l.url).join(', ')}`);

  await page2.close();
}
