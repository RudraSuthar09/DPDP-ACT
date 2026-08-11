/**
 * Playwright verification for the first-login guided tour — against the real
 * backend and the real frontend.
 *
 *   node scripts/tour-ui.spec.mjs
 *
 * Needs API on :3001 and the Next dev server on :3000, both already running.
 *
 * The tour's whole promise is that it points at REAL screens, so the assertions
 * below never trust the tour's own copy: for each step they read the URL the
 * browser actually landed on and the element the highlight ring actually
 * measured, and check that ring is on-screen and non-empty. A tour that drew
 * its ring around nothing, or narrated a page it never opened, fails here.
 *
 * The tenant is seeded with the CA/tax sector template first, so the running
 * example the tour describes (Aadhaar, PAN, office WhatsApp, Income Tax Portal)
 * is genuinely on the screens it opens.
 */
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:3000';

const ok = (s) => console.log(`   ✓ ${s}`);
const info = (s) => console.log(`     ${s}`);
const bad = (s) => {
  console.error(`   ✗ ${s}`);
  process.exitCode = 1;
};
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
const EMAIL = `ca-${sfx}@tourfirm.example`;
const PASSWORD = 'a-long-enough-password-2026';

/** What each step must have actually opened and actually highlighted. */
const EXPECTED_STEPS = [
  { id: 'dashboard', url: /\/dashboard/, anchor: '[data-tour="dashboard-stats"]' },
  { id: 'inventory', url: /\/inventory$/, anchor: '[data-tour="inventory-register"]' },
  { id: 'systems-vendors', url: /\/inventory\/systems/, anchor: '[data-tour="systems-register"]' },
  { id: 'retention', url: /\/inventory\/[0-9a-f-]{36}/, anchor: '[data-tour="purposes-panel"]' },
  { id: 'consent', url: /\/consent$/, anchor: '[data-tour="consent-main"]' },
  { id: 'portal', url: /\/grievance$/, anchor: '[data-tour="portal-link"]' },
  { id: 'audit', url: /\/audit$/, anchor: '[data-tour="audit-main"]' },
  { id: 'closing', url: /\/dashboard/, anchor: '[data-tour="dashboard-stats"]' },
];

let browser;

/** Wait until the tour card reports the step id we expect. */
async function waitForStep(page, id) {
  await page.locator(`[data-testid="tour-card"][data-tour-step="${id}"]`).waitFor({ timeout: 20000 });
}

try {
  // =========================================================================
  step(1, 'Fresh signup, with the CA/tax template applied — the tour\'s running example');
  // =========================================================================
  const reg = await api('POST', '/auth/register', {
    body: {
      organisationName: `Deshpande & Co, Chartered Accountants ${sfx}`,
      ownerEmail: EMAIL,
      ownerName: 'Anil Deshpande',
      password: PASSWORD,
    },
  });
  const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
  const secret = base32Decode(enrol.secret);
  const confirmed = await api('POST', '/auth/mfa/confirm', {
    body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) },
  });
  const token = confirmed.accessToken;
  ok(`tenant ${reg.tenantId} registered`);

  const me = await api('GET', '/auth/me', { token });
  if (me.productTourStatus !== 'pending') {
    bad(`a brand-new user should start at 'pending', got '${me.productTourStatus}'`);
  } else {
    ok("a brand-new user starts at productTourStatus 'pending'");
  }

  const catalog = await api('GET', '/inventory/sector-templates', { token });
  const ca = catalog.templates.find((t) => t.sector === 'ca_tax_practice');
  await api('POST', `/inventory/sector-templates/${ca.id}/apply`, { token, expect: 201 });
  ok('CA/tax template applied — Aadhaar, PAN, bank details, office WhatsApp, Income Tax Portal are real rows now');

  // =========================================================================
  step(2, 'First login through the real UI auto-triggers the tour');
  // =========================================================================
  // TOTP replay protection correctly rejects reusing the enrolment step's code
  // within the same 30s window — wait for a fresh one before logging in.
  await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1000));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  async function login() {
    await page.goto(`${WEB}/login`);
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type=submit]');
    const mfaInput = page.locator('input[autocomplete="one-time-code"]');
    await mfaInput.waitFor({ timeout: 15000 });
    await mfaInput.fill(totp(secret));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  }

  await login();
  await page.locator('[data-testid="tour-card"]').waitFor({ timeout: 20000 });
  ok('tour opened by itself on first login — nobody clicked anything');

  const firstStepId = await page.locator('[data-testid="tour-card"]').getAttribute('data-tour-step');
  const counter = await page.locator('[data-testid="tour-step-count"]').innerText();
  if (firstStepId !== 'dashboard') bad(`tour opened on '${firstStepId}', expected 'dashboard'`);
  else ok(`opened at step 1: "${counter}"`);

  // =========================================================================
  step(3, 'Skip is visible on EVERY step, and each step opens the real screen it describes');
  // =========================================================================
  for (const [i, expected] of EXPECTED_STEPS.entries()) {
    await waitForStep(page, expected.id);

    // Skip must be reachable at this step, not just at the first one.
    if (!(await page.locator('[data-testid="tour-skip"]').isVisible())) {
      bad(`step ${i + 1} (${expected.id}) has no visible Skip`);
    }

    // The REAL screen: the browser's own URL, not anything the tour claims.
    await page.waitForURL(expected.url, { timeout: 20000 }).catch(() => {});
    const url = page.url();
    if (!expected.url.test(url)) {
      bad(`step ${i + 1} (${expected.id}) is on ${url}, expected ${expected.url}`);
    } else {
      // The REAL element: the ring must exist, name the anchor this step
      // declares, and sit over a genuinely visible box on that page. Compared
      // after the page settles, because these screens fetch before they paint
      // and the anchor moves as content lands above it.
      const ring = page.locator('[data-testid="tour-ring"]');
      await ring.waitFor({ timeout: 10000 }).catch(() => {});
      const target = page.locator(expected.anchor).first();
      await target.waitFor({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600); // let the ring's poll catch up to the settled layout

      if ((await ring.count()) === 0) {
        bad(`step ${i + 1} (${expected.id}) drew no highlight on ${url}`);
      } else {
        const ringAnchor = await ring.getAttribute('data-tour-anchor');
        const box = await ring.boundingBox();
        const targetBox = await target.boundingBox();
        if (ringAnchor !== expected.anchor) {
          bad(`step ${i + 1} (${expected.id}) highlighted ${ringAnchor}, expected ${expected.anchor}`);
        } else if (!box || box.width < 8 || box.height < 8) {
          bad(`step ${i + 1} (${expected.id}) ring is empty: ${JSON.stringify(box)}`);
        } else if (
          !targetBox ||
          Math.abs(box.x + 4 - targetBox.x) > 3 ||
          Math.abs(box.y + 4 - targetBox.y) > 3
        ) {
          bad(
            `step ${i + 1} (${expected.id}) ring is not over its element — ` +
              `ring ${JSON.stringify(box)} vs element ${JSON.stringify(targetBox)}`,
          );
        } else {
          const title = await page.locator('[data-testid="tour-title"]').innerText();
          ok(`step ${i + 1} "${title}"`);
          info(`${url.replace(WEB, '')} → highlights ${expected.anchor} (${Math.round(box.width)}x${Math.round(box.height)})`);
        }
      }
    }

    // Always advance, even after a failed assertion, so one bad step reports
    // itself instead of hiding every step behind it.
    if (i < EXPECTED_STEPS.length - 1) await page.click('[data-testid="tour-next"]');
  }

  // The retention step must be pointing at a real seeded element, not a stub.
  await waitForStep(page, 'closing');
  ok('reached the closing step');

  // =========================================================================
  step(4, 'Skip closes it, persists to the server, and it does NOT come back');
  // =========================================================================
  await page.click('[data-testid="tour-skip"]');
  await page.locator('[data-testid="tour-card"]').waitFor({ state: 'detached', timeout: 10000 });
  ok('Skip closed the tour');

  await page.waitForTimeout(1500); // let the PATCH land
  const afterSkip = await api('GET', '/auth/me', { token });
  if (afterSkip.productTourStatus !== 'skipped') {
    bad(`server still says '${afterSkip.productTourStatus}' after Skip`);
  } else {
    ok("server recorded productTourStatus 'skipped' — per user, not per browser");
  }

  // A full reload is the honest test: it re-runs the auto-launch decision from
  // scratch against whatever the server now says.
  await page.goto(`${WEB}/dashboard`);
  await page.waitForSelector('[data-tour="dashboard-stats"]', { timeout: 20000 });
  await page.waitForTimeout(2000);
  if ((await page.locator('[data-testid="tour-card"]').count()) > 0) {
    bad('the tour reappeared after being skipped');
  } else {
    ok('reloaded the dashboard — tour did not reappear');
  }

  // And on a genuinely new session, which is what "future logins" actually means.
  await page.context().clearCookies();
  await page.evaluate(() => window.localStorage.clear());
  await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1000));
  await login();
  await page.waitForTimeout(2500);
  if ((await page.locator('[data-testid="tour-card"]').count()) > 0) {
    bad('the tour forced itself on a SECOND login after being skipped');
  } else {
    ok('signed out and logged in fresh — still no tour. It does not force itself on future logins');
  }

  // =========================================================================
  step(5, '"Take the tour" replays it from Settings');
  // =========================================================================
  await page.goto(`${WEB}/settings`);
  await page.waitForSelector('[data-testid="settings-take-the-tour"]', { timeout: 20000 });
  const statusText = await page.locator('[data-testid="tour-status-text"]').innerText();
  if (!/skipped/i.test(statusText)) bad(`settings does not reflect the skipped state: "${statusText}"`);
  else ok(`Settings reports the real state: "${statusText}"`);

  await page.click('[data-testid="settings-take-the-tour"]');
  await waitForStep(page, 'dashboard');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  ok('"Take the tour" replayed it from step 1, on the real dashboard');

  // Replaying must not silently re-arm the auto-launch for future logins.
  const afterReplay = await api('GET', '/auth/me', { token });
  if (afterReplay.productTourStatus !== 'skipped') {
    bad(`replaying reset the stored status to '${afterReplay.productTourStatus}'`);
  } else {
    ok("replaying did not reset the stored status — 'show me again' ≠ 'pester me again'");
  }

  // Finishing it properly records 'completed'.
  for (let i = 0; i < EXPECTED_STEPS.length - 1; i += 1) {
    await page.click('[data-testid="tour-next"]');
  }
  await waitForStep(page, 'closing');
  const closingBody = await page.locator('[data-testid="tour-card"]').innerText();
  if (!/stay on your own systems/i.test(closingBody)) {
    bad('the closing step does not carry the "your documents stay with you" message');
  } else {
    ok('closing step delivers the central promise in plain language');
  }
  await page.click('[data-testid="tour-done"]');
  await page.locator('[data-testid="tour-card"]').waitFor({ state: 'detached', timeout: 10000 });
  await page.waitForTimeout(1500);
  const afterDone = await api('GET', '/auth/me', { token });
  if (afterDone.productTourStatus !== 'completed') {
    bad(`finishing recorded '${afterDone.productTourStatus}', expected 'completed'`);
  } else {
    ok("finishing recorded productTourStatus 'completed'");
  }

  // =========================================================================
  step(6, 'The topbar control works from anywhere, and the tour is not audited');
  // =========================================================================
  await page.goto(`${WEB}/audit`);
  await page.waitForSelector('[data-testid="take-the-tour"]', { timeout: 20000 });
  await page.click('[data-testid="take-the-tour"]');
  await waitForStep(page, 'dashboard');
  ok('the topbar "Take the tour" works from a different screen too');
  await page.click('[data-testid="tour-skip"]');
  await page.waitForTimeout(1500);

  // The dashboard button is the one used to demo the platform to a client, so
  // it has to work from the dashboard's ordinary state — tour already finished,
  // nothing auto-opening.
  await page.goto(`${WEB}/dashboard`);
  await page.waitForSelector('[data-testid="dashboard-take-the-tour"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  if ((await page.locator('[data-testid="tour-card"]').count()) > 0) {
    bad('the tour auto-opened on a dashboard where it should be closed');
  }
  await page.click('[data-testid="dashboard-take-the-tour"]');
  await waitForStep(page, 'dashboard');
  ok('the dashboard "Take the tour" button launches it from step 1');
  await page.click('[data-testid="tour-skip"]');
  await page.waitForTimeout(1500);

  const audit = await api('GET', '/audit?limit=200', { token });
  const tourEntries = audit.entries.filter((e) => /tour/i.test(e.action) || /tour/i.test(e.reason ?? ''));
  if (tourEntries.length > 0) {
    bad(`${tourEntries.length} tour row(s) polluted the S5 evidence log: ${tourEntries.map((e) => e.action).join(', ')}`);
  } else {
    ok('no tour rows in the audit log — interface state stayed out of the compliance evidence');
  }
  const chain = await api('GET', '/audit/verify', { token });
  if (!chain.intact || chain.breaks.length) bad(`audit chain broken: ${JSON.stringify(chain)}`);
  else ok(`audit chain still intact across ${chain.entriesChecked} entries`);
} catch (err) {
  bad(err.stack ?? String(err));
} finally {
  await browser?.close();
}

console.log(
  `\n${'='.repeat(70)}\n${process.exitCode ? 'FAILED — see ✗ above' : 'All checks passed.'}\n${'='.repeat(70)}\n`,
);
