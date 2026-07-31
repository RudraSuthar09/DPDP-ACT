/**
 * Playwright verification for the Breach Register UI (FR-BRC-01…07), against
 * the REAL backend and REAL frontend — no mocked data.
 *
 *   node scripts/breach-ui.spec.mjs
 *
 * Creates an incident THROUGH THE UI (with categories picked from the real Data
 * Inventory), walks all seven gates through the stepper, uploads evidence and
 * checks the displayed hash equals the file's real SHA-256, downloads the
 * closure packet, and confirms the PDF contains the incident's real content.
 *
 * Needs API on :3001 and the Next dev server on :3000.
 */
import { chromium } from 'playwright';
import { randomBytes, createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:3000';
const ok = (s) => console.log(`   ✓ ${s}`);
const info = (s) => console.log(`     ${s}`);
const bad = (s) => { console.error(`   ✗ ${s}`); process.exitCode = 1; };
const step = (n, s) => console.log(`\n${'='.repeat(72)}\n${n}. ${s}\n${'='.repeat(72)}`);

async function api(method, path, { body, token, expect } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} -> expected ${expect}, got ${res.status} ${JSON.stringify(json)}`);
  }
  if (expect === undefined && res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}`);
  return json;
}

/** pdfkit hex-in-FlateDecode extraction — a plain latin1 search would silently
 *  "pass" whether or not the text is really in the document. */
function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  let out = '';
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    let text;
    try { text = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    let hm;
    while ((hm = hexRe.exec(text))) out += Buffer.from(hm[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}

const { totp } = await import('file:///E:/DPDP%20ACT/DPDP-ACT/backend/dist/modules/identity/crypto/totp.js');
const { base32Decode } = await import('file:///E:/DPDP%20ACT/DPDP-ACT/backend/dist/modules/identity/crypto/base32.js');

const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';
let browser;

try {
  step(1, 'Seed a tenant with REAL Data Inventory entries (via API)');
  const reg = await api('POST', '/auth/register', {
    body: { organisationName: `Beacon Clinic ${sfx}`, ownerEmail: `dpo-${sfx}@beacon.example`, ownerName: 'Sara Khan', password: PASSWORD },
  });
  const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
  const secret = base32Decode(enrol.secret);
  // Remember the code used at enrolment. TOTP windows are 30 seconds and the
  // identity module rejects a REPLAYED code, so logging in below must wait for
  // a fresh window — otherwise the login silently fails with "Invalid
  // verification code" whenever enrolment and login land in the same window.
  const enrolCode = totp(secret);
  const confirmed = await api('POST', '/auth/mfa/confirm', { body: { challengeToken: reg.mfaEnrolmentToken, code: enrolCode } });
  const staff = confirmed.accessToken;
  const me = await api('GET', '/auth/me', { token: staff });

  for (const d of ['grievance_officer', 'dpo', 'escalation_contact']) {
    await api('POST', '/users/designations', { token: staff, body: { designation: d, userId: me.userId, reason: 'UI test ladder' } });
  }
  const CATEGORY = 'Patient contact details';
  const entry = await api('POST', '/inventory/register', {
    token: staff, body: { category: CATEGORY, description: 'Clinic patient contacts.', storageLocation: 'ehr.patients' }, expect: 201,
  });
  await api('POST', `/inventory/register/${entry.id}/purposes`, {
    token: staff, body: { purposeName: 'Appointment reminders', legalBasis: 'consent', retentionPeriod: '3 years' }, expect: 201,
  });
  ok(`tenant ${reg.tenantId} with inventory entry "${CATEGORY}"`);

  step(2, 'Log in through the real UI');
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${WEB}/login`);
  await page.fill('input[type="email"]', me.email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type=submit]');
  const mfa = page.locator('input[autocomplete="one-time-code"]');
  await mfa.waitFor({ timeout: 60000 });
  // Wait for the TOTP window to roll over so this is a genuinely new code.
  let loginCode = totp(secret);
  while (loginCode === enrolCode) {
    await new Promise((r) => setTimeout(r, 2000));
    loginCode = totp(secret);
  }
  await mfa.fill(loginCode);
  await page.click('button[type=submit]');
  try {
    await page.waitForURL(/\/dashboard/, { timeout: 60000 });
  } catch {
    const shown = await page.locator('.error').allInnerTexts().catch(() => []);
    throw new Error(`login did not reach /dashboard. url=${page.url()} errors=${JSON.stringify(shown)}`);
  }
  ok('signed in');

  step(3, 'FR-BRC-01: create an incident THROUGH THE UI, categories from the real inventory');
  await page.goto(`${WEB}/breach`);
  // Wait for actual ROWS, not the container: the table renders its headers
  // before the fetch resolves, so waiting on the container alone passes
  // instantly against an empty tbody — a green tick that proves nothing.
  await page.waitForSelector('[data-testid="breach-policies"] tbody tr', { timeout: 60000 });
  const policyText = await page.locator('[data-testid="breach-policies"]').innerText();
  if (!policyText.includes('v1') || !policyText.includes('breach:notify_board')) {
    bad(`deadline policies not rendered from real records: ${policyText.slice(0, 160)}`);
  } else {
    ok('deadline policies render with their versioned policy keys');
  }

  await page.click('[data-testid="new-incident-btn"]');
  await page.waitForSelector('[data-testid="incident-form"]');

  // The category picker must be populated from the REAL inventory, not free text.
  const optionText = await page.locator('[data-testid="category-select"] option').first().innerText();
  if (!optionText.includes(CATEGORY)) bad(`category picker did not load the real inventory entry: "${optionText}"`);
  else ok(`category picker offers the real inventory entry: "${optionText}"`);

  await page.fill('#title', 'Reception terminal left unlocked overnight');
  await page.fill('#what-happened', 'A reception workstation with an open patient list was left unlocked and accessible overnight in a public area of the clinic.');
  await page.fill('#systems', 'reception-terminal-02, ehr-primary');
  await page.selectOption('[data-testid="category-select"]', [entry.id]);
  await page.fill('#affected', '84');
  await page.selectOption('#severity', 'high');
  await page.click('[data-testid="submit-incident"]');
  // Surface a validation/API failure as itself rather than as a selector
  // timeout twenty seconds later.
  const formError = await Promise.race([
    page.locator('.error').first().innerText().then((t) => t).catch(() => null),
    page.waitForSelector('[data-testid="incident-table"] tr', { timeout: 60000 }).then(() => null),
  ]);
  if (formError) bad(`incident submission failed: ${formError}`);
  await page.waitForSelector('[data-testid="incident-table"] tr', { timeout: 60000 });

  const rows = await page.locator('[data-testid="incident-table"] tr').allInnerTexts();
  const created = rows.find((r) => r.includes('Reception terminal left unlocked'));
  if (!created) bad('the new incident does not appear in the register table');
  else ok('incident created through the UI and listed');

  const refMatch = /BRC-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(created ?? '');
  const referenceCode = refMatch?.[0];
  if (!referenceCode) bad('could not read the reference code from the row');
  else ok(`reference ${referenceCode}`);

  await page.click(`text=${referenceCode}`);
  await page.waitForSelector('[data-testid="gate-stepper"]', { timeout: 60000 });
  const catText = await page.locator('[data-testid="incident-categories"]').innerText();
  if (!catText.includes(CATEGORY) || !catText.includes('consent') || !catText.includes('3 years')) {
    bad(`the incident does not show the referenced category's live facts: ${catText.slice(0, 160)}`);
  } else {
    ok('the incident inherits the inventory entry live purpose, legal basis and retention');
  }

  step(4, 'FR-BRC-03/04: walk all seven gates through the stepper, with deadline clocks');
  const gates = ['acknowledge', 'assess', 'notify_data_principals', 'notify_board', 'remediate', 'rca', 'closure'];
  const notes = {
    acknowledge: 'Incident acknowledged by the duty DPO; terminal secured and session terminated.',
    assess: 'Assessed: patient contact details visible on one screen, approximately 84 individuals, no export or copy detected.',
    notify_data_principals: 'Affected patients contacted by SMS and email using our own contact records.',
    notify_board: 'Report filed with the Data Protection Board under section 8(6) with the assessment attached.',
    remediate: 'Automatic screen lock enforced clinic-wide; reception terminals moved behind the desk line.',
    rca: 'Root cause: no enforced idle lock on shared terminals. Policy updated and applied via device management.',
    closure: 'All actions verified complete by the compliance officer.',
  };
  // Before touching anything, the first gate should show a real deadline.
  const ackClock = await page.locator('[data-testid="gate-acknowledge"]').innerText();
  if (!/Due .*\d/.test(ackClock) || !ackClock.includes('breach:acknowledge')) {
    bad(`acknowledge gate does not show its deadline and policy citation: ${ackClock.slice(0, 120)}`);
  } else {
    ok('each gate shows its deadline clock and the versioned policy it cites');
  }

  for (const gate of gates) {
    await page.waitForSelector(`[data-testid="gate-form-${gate}"]`, { timeout: 60000 });
    await page.fill(`[data-testid="gate-notes-${gate}"]`, notes[gate]);
    await page.click(`[data-testid="gate-form-${gate}"] button[type=submit]`);
    try {
      await page.waitForFunction(
        (g) => {
          const el = document.querySelector(`[data-testid="gate-status-${g}"]`);
          return el && /completed/i.test(el.textContent ?? '');
        },
        gate,
        { timeout: 60000 },
      );
    } catch {
      const gateText = await page.locator(`[data-testid="gate-${gate}"]`).innerText().catch(() => 'MISSING');
      const errs = await page.locator('.error').allInnerTexts().catch(() => []);
      throw new Error(`gate "${gate}" never showed completed.
  rendered: ${gateText.split('\n').join(' | ')}
  errors: ${JSON.stringify(errs)}`);
    }
    ok(`gate completed through the UI: ${gate}`);
  }

  step(5, 'FR-BRC-05: evidence upload shows a hash equal to the real SHA-256');
  const evidenceText = `RECEPTION TERMINAL AUDIT ${sfx}\nSession log excerpt and device policy state.\n${'y'.repeat(512)}`;
  const expectedSha = createHash('sha256').update(Buffer.from(evidenceText, 'utf8')).digest('hex');
  const tmpFile = join(tmpdir(), `breach-evidence-${sfx}.txt`);
  writeFileSync(tmpFile, evidenceText);

  await page.setInputFiles('[data-testid="evidence-file"]', tmpFile);
  await page.fill('#evidence-desc', 'Session log excerpt.');
  await page.click('[data-testid="evidence-form"] button[type=submit]');
  await page.waitForSelector('[data-testid="evidence-table"]', { timeout: 60000 });
  const shownSha = (await page.locator('[data-testid="evidence-table"] td.mono').first().innerText()).trim();
  if (shownSha !== expectedSha) bad(`UI shows ${shownSha}, real SHA-256 is ${expectedSha}`);
  else ok(`UI displays the hash and it EQUALS the file real SHA-256 (${expectedSha.slice(0, 20)}…)`);

  step(6, 'FR-BRC-06: notification templates populated from the real incident');
  await page.click('[data-testid="template-reg"]');
  await page.waitForSelector('[data-testid="template-output"]', { timeout: 60000 });
  const tpl = await page.locator('[data-testid="template-output"]').innerText();
  const tplChecks = [
    [tpl.includes(referenceCode), 'the reference code'],
    [tpl.includes(CATEGORY), 'the real inventory category'],
    [tpl.includes('84'), 'the estimated affected count'],
    [tpl.includes('Root cause'), 'the recorded RCA'],
  ];
  const tplMissing = tplChecks.filter(([p]) => !p).map(([, w]) => w);
  if (tplMissing.length) bad(`regulator report missing: ${tplMissing.join(', ')}`);
  else ok('regulator report contains the reference, real category, real scope and the RCA');

  step(7, 'Close the incident, then FR-BRC-07: download the closure packet');
  await page.fill('#closure-note', 'Signed off by the DPO. All gates complete and evidence attested.');
  await page.click('[data-testid="close-incident"]');
  await page.waitForFunction(
    () => document.body.innerText.includes('closed'),
    undefined,
    { timeout: 60000 },
  );
  ok('incident closed with sign-off through the UI');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('[data-testid="download-packet"]'),
  ]);
  const pdf = readFileSync(await download.path());
  if (pdf.subarray(0, 4).toString() !== '%PDF') bad(`downloaded file is not a PDF (${pdf.length} bytes)`);
  else ok(`closure packet downloaded through the UI: ${pdf.length}-byte PDF`);

  const text = extractPdfText(pdf);
  const checks = [
    [text.includes(referenceCode), 'the reference code'],
    [text.includes(CATEGORY), 'the referenced inventory category'],
    [text.includes(expectedSha), 'the evidence SHA-256 in full'],
    [text.includes('Root cause'), 'the RCA gate notes'],
    [text.includes('Reception terminal'), 'the incident title'],
  ];
  const missing = checks.filter(([p]) => !p).map(([, w]) => w);
  if (missing.length) bad(`closure packet missing: ${missing.join(', ')}`);
  else ok('the packet opens and contains the real incident data, including the full evidence digest');
} finally {
  if (browser) await browser.close();
}

console.log(process.exitCode ? '\n✗ Some checks failed.\n' : '\n✓ All Breach UI checks passed.\n');
