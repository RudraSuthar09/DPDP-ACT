/**
 * Playwright verification for the NEW-MODEL consent forms (single-screen
 * builder + tenant-wide website embed). Reuses the verify-session tenant.
 *   node scripts/consent-forms-newmodel-ui.spec.mjs
 * Needs API :3001, web :3000, backend dist built, sdk/dist built.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const API = 'http://localhost:3001', WEB = 'http://localhost:3000';
const S = 'C:/Users/Rudra/AppData/Local/Temp/claude/E--DPDP-ACT/3495d79a-fb77-4a10-9262-97ce0578da9d/scratchpad';
const state = JSON.parse(readFileSync(`${S}/.verify-state.json`, 'utf8'));
const { totp } = await import('file:///E:/DPDP%20ACT/DPDP-ACT/backend/dist/modules/identity/crypto/totp.js');
const { base32Decode } = await import('file:///E:/DPDP%20ACT/DPDP-ACT/backend/dist/modules/identity/crypto/base32.js');
const EMAIL = 'owner@verify-session.dpdp.invalid', PW = 'Verify-Session-Value-2026!';
const ok = (s) => console.log('  ✓', s), bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (n, s) => console.log(`\n${'='.repeat(68)}\n${n}. ${s}\n${'='.repeat(68)}`);
const tag = Date.now().toString().slice(-6);

async function api(method, path, token, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

const login = await api('POST', '/auth/login', null, { email: EMAIL, password: PW });
await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
const verify = await api('POST', '/auth/mfa/verify', null, { challengeToken: login.challengeToken, code: totp(base32Decode(state.mfaSecretBase32)) });
const token = verify.accessToken;
await api('PATCH', '/auth/me/product-tour', token, { status: 'skipped' });
const key = await api('POST', '/consent/api-keys', token, { label: `newmodel-ui ${tag}` });

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`${WEB}/login`);
  await page.fill('input[type=email]', EMAIL); await page.fill('input[type=password]', PW);
  await page.click('button[type=submit]');
  const mfa = page.locator('input[autocomplete="one-time-code"]').or(page.locator('form input:not([type])'));
  await mfa.first().waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 800));
  await mfa.first().fill(totp(base32Decode(state.mfaSecretBase32)));
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });

  step(1, 'Build a 3-row form (one linked to an inventory element) via the real builder UI');
  await page.goto(`${WEB}/consent/forms`, { waitUntil: 'networkidle' });
  page.once('dialog', (d) => d.accept(`NewModel UI Form ${tag}`));
  await page.getByRole('button', { name: '+ New form' }).click();
  await page.waitForURL(/\/consent\/forms\/[0-9a-f-]{36}$/, { timeout: 10000 });
  const formId = page.url().split('/').pop();

  async function addRow(label, notice, linkCategory) {
    await page.fill('#row-label', label);
    await page.fill('#row-notice', notice);
    if (linkCategory) await page.selectOption('#row-inv', { label: linkCategory });
    await page.getByRole('button', { name: 'Add row' }).click();
    await page.waitForSelector(`text=${label}`, { timeout: 10000 });
  }
  await addRow(`Aadhaar ${tag}`, 'We collect your Aadhaar for KYC.', null);
  await addRow(`Marketing ${tag}`, 'We email you offers.', null);
  await addRow(`Bank ${tag}`, 'We store bank details for refunds.', 'Aadhaar Card');
  ok('3 rows added through the builder (third linked to the "Aadhaar Card" element)');

  // Turn the form on.
  await page.getByRole('button', { name: 'Turn on' }).first().click();
  await page.waitForSelector('.badge.success:has-text("Live")', { timeout: 10000 });
  ok('form turned on (Live) via the builder');

  step(2, 'The tenant-wide embed renders the live form on a bare HTML page');
  const manifest = await fetch(`${API}/consent-sdk/v1/form-widget-manifest.json`).then((r) => r.json());
  const bare = await browser.newPage();
  await bare.setContent('<!doctype html><html><body><div id="c"></div></body></html>', { baseURL: API });
  await bare.addScriptTag({ url: `${API}/consent-sdk/v1/${manifest.file}` });
  await bare.evaluate(({ apiKey }) => {
    // eslint-disable-next-line no-undef
    new DPDPConsentForms({ apiKey, container: '#c', customerId: 'embed-e2e', apiBaseUrl: 'http://localhost:3001' }).mount();
  }, { apiKey: key.key });
  await bare.waitForSelector(`text=NewModel UI Form ${tag}`, { timeout: 10000 });
  const boxes = await bare.locator('#c input[type=checkbox]').count();
  if (boxes === 3) ok('embed rendered the form with its 3 rows on a bare page'); else bad(`embed rendered ${boxes} rows, expected 3`);

  step(3, 'Submit through the embed on the bare page');
  await bare.locator('#c input[type=checkbox]').first().check();
  await bare.getByRole('button', { name: 'Save my choices' }).click();
  await bare.waitForSelector('text=Saved. Thank you.', { timeout: 10000 });
  ok('embed submitted successfully on the bare page');

  step(4, 'Toggle the form OFF and confirm the embed stops showing it — no code change');
  await page.bringToFront();
  await page.getByRole('button', { name: 'Turn off' }).first().click();
  await page.waitForSelector('.badge.neutral:has-text("Off")', { timeout: 10000 });
  const bare2 = await browser.newPage();
  await bare2.setContent('<!doctype html><html><body><div id="c"></div></body></html>', { baseURL: API });
  await bare2.addScriptTag({ url: `${API}/consent-sdk/v1/${manifest.file}` });
  await bare2.evaluate(({ apiKey }) => {
    // eslint-disable-next-line no-undef
    new DPDPConsentForms({ apiKey, container: '#c', customerId: 'embed-e2e', apiBaseUrl: 'http://localhost:3001' }).mount();
  }, { apiKey: key.key });
  await bare2.waitForFunction(() => document.querySelector('#c')?.getAttribute('data-dpdp-consent-forms') !== null, { timeout: 10000 });
  const stillShown = await bare2.locator(`text=NewModel UI Form ${tag}`).count();
  if (stillShown === 0) ok('after toggling off, the same embed code no longer shows the form'); else bad('embed still shows the form after it was turned off');

  step(5, 'The embed submission shows in the staff builder');
  await page.goto(`${WEB}/consent/forms/${formId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Submissions', { timeout: 10000 });
  const subsText = await page.locator('table').last().innerText();
  if (subsText.includes('Website embed')) ok('staff builder lists the embed submission'); else bad(`submission not shown: ${subsText.slice(0, 200)}`);

  console.log(process.exitCode ? '\nFAILED' : '\nNEW-MODEL CONSENT FORMS UI VERIFIED');
} finally {
  await browser?.close();
}
