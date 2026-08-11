/**
 * Playwright verification for the notification channel status screen and the
 * dashboard's evidence-bundle export button — against the real backend and
 * real frontend.
 *
 *   node scripts/notify-settings-ui.spec.mjs
 *
 * Needs API on :3001 and the Next dev server on :3000, both already running.
 */
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:3000';

const ok = (s) => console.log(`   ✓ ${s}`);
const bad = (s) => { console.error(`   ✗ ${s}`); process.exitCode = 1; };
const step = (n, s) => console.log(`\n${'='.repeat(70)}\n${n}. ${s}\n${'='.repeat(70)}`);

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
  if (expect === undefined && res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

const { totp } = await import(new URL('../backend/dist/modules/identity/crypto/totp.js', import.meta.url));
const { base32Decode } = await import(new URL('../backend/dist/modules/identity/crypto/base32.js', import.meta.url));

const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';
let browser;

try {
  step(1, 'Seed a real tenant via the API');
  const reg = await api('POST', '/auth/register', {
    body: { organisationName: `UI Notify Co ${sfx}`, ownerEmail: `dpo-${sfx}@uinotify.example`, ownerName: 'Neha Bhatt', password: PASSWORD },
  });
  const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
  const secret = base32Decode(enrol.secret);
  await api('POST', '/auth/mfa/confirm', { body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) } });
  ok(`tenant ${reg.tenantId} seeded`);

  step(2, 'Log in through the real UI');
  // TOTP replay protection correctly rejects reusing the enrolment step's
  // code within the same 30s window — wait for a fresh one before logging in.
  await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1000));
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${WEB}/login`);
  await page.fill('input[type="email"]', `dpo-${sfx}@uinotify.example`);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type=submit]');
  const mfaInput = page.locator('input[autocomplete="one-time-code"]');
  await mfaInput.waitFor({ timeout: 10000 });
  await mfaInput.fill(totp(secret));
  await page.click('button[type=submit]');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  ok('logged in, landed on dashboard');

  step(3, 'Notification channel status screen reflects real, unconfigured providers');
  await page.goto(`${WEB}/settings/notifications`);
  await page.waitForSelector('[data-testid="channel-email"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="channel-sms"]', { timeout: 15000 });

  const emailStatusText = await page.locator('[data-testid="channel-email-status"]').innerText();
  const smsStatusText = await page.locator('[data-testid="channel-sms-status"]').innerText();
  if (!/not configured/i.test(emailStatusText) || !/console/i.test(emailStatusText)) {
    bad(`email channel status text unexpected: "${emailStatusText}"`);
  } else {
    ok(`email channel correctly shown as: "${emailStatusText}"`);
  }
  if (!/not configured/i.test(smsStatusText) || !/console/i.test(smsStatusText)) {
    bad(`sms channel status text unexpected: "${smsStatusText}"`);
  } else {
    ok(`sms channel correctly shown as: "${smsStatusText}"`);
  }

  step(4, 'Fire a real OTP via the portal, then confirm it appears in the UI as a recent delivery');
  // Wait out the TOTP window so this login's code is fresh, not a replay of
  // the enrolment step's — the identity module correctly rejects reuse.
  const wait = 30_000 - (Date.now() % 30_000) + 1000;
  await new Promise((r) => setTimeout(r, wait));
  const login = await api('POST', '/auth/login', { body: { email: `dpo-${sfx}@uinotify.example`, password: PASSWORD } });
  const verified = await api('POST', '/auth/mfa/verify', { body: { challengeToken: login.challengeToken, code: totp(secret) } });
  const meRes = await api('GET', '/auth/me', { token: verified.accessToken });
  const slug = meRes.portalSlug;

  const submitted = await api('POST', `/portal/${slug}/data-requests`, {
    body: {
      rightType: 'access',
      subject: 'UI notify-settings verification request',
      body: 'Exercising a real OTP send so the settings screen has a real delivery to show.',
      contactChannel: 'email',
      contactValue: `principal-${sfx}@personal.example`,
    },
    expect: 201,
  });
  ok(`${submitted.referenceCode} filed — a real OTP email send just happened`);

  // The delivery-log write is best-effort and detached from the request's own
  // transaction (NotificationDispatcher.send never awaits it into the caller's
  // response) — give it a moment to land before asking the UI to refresh.
  await page.waitForTimeout(2500);
  await page.click('button:has-text("Refresh")');
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('[data-testid="channel-email-deliveries"] tr');
      return rows.length > 0;
    },
    { timeout: 15000 },
  );
  const deliveryRows = await page.locator('[data-testid="channel-email-deliveries"] tr').count();
  if (deliveryRows === 0) bad('no delivery rows appeared on the email channel after refresh');
  else ok(`${deliveryRows} recent delivery row(s) now shown on the email channel, including the one just sent`);

  step(5, 'Export the full evidence bundle from the dashboard and confirm it is a real PDF');
  await page.goto(`${WEB}/dashboard`);
  await page.waitForSelector('[data-testid="export-evidence-bundle-btn"]', { timeout: 15000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click('[data-testid="export-evidence-bundle-btn"]'),
  ]);
  const path = await download.path();
  const buf = await (await import('node:fs')).promises.readFile(path);
  if (buf.subarray(0, 4).toString() !== '%PDF') bad(`downloaded file is not a PDF (${buf.length} bytes)`);
  else ok(`evidence bundle downloaded through the real dashboard button: ${buf.length}-byte PDF`);
} finally {
  if (browser) await browser.close();
}

console.log(process.exitCode ? '\n✗ Some checks failed.\n' : '\n✓ All notification-settings + evidence-bundle UI checks passed.\n');
