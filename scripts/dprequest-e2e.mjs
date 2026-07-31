/**
 * Playwright walk of the DPR portal and staff queue (Prompt 27, Part B).
 *
 *   node scripts/dprequest-e2e.mjs
 *
 * Files ONE request of EACH of the six rights types through the real public
 * portal — clicking the real form, reading the real dev OTP off the real
 * confirmation step — then logs in as staff and checks all six appear in the
 * DPR queue with the deadline the versioned policy for that right actually
 * says.
 *
 * Needs the API and the web app running, and NOTIFY_DEV_ECHO_OTP=true.
 * Override with API_URL / WEB_URL.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
// Playwright is not a dependency of this repo — it is a verification tool, not
// something the product ships. Resolved from wherever it is installed:
// PLAYWRIGHT_PATH for an out-of-tree install, otherwise the bare specifier.
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { totp } = await import(
  `file:///${join(ROOT, 'backend/dist/modules/identity/crypto/totp.js').replace(/\\/g, '/')}`
);
const { base32Decode } = await import(
  `file:///${join(ROOT, 'backend/dist/modules/identity/crypto/base32.js').replace(/\\/g, '/')}`
);

const env = existsSync(join(ROOT, '.env'))
  ? Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  : {};
const API = process.env.API_URL ?? `http://localhost:${env.API_PORT ?? 3001}`;
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';

const ok = (s) => console.log(`   ✓ ${s}`);
const bad = (s) => {
  console.error(`   ✗ ${s}`);
  process.exitCode = 1;
};
const step = (n, s) => console.log(`\n${'-'.repeat(74)}\n${n}. ${s}\n${'-'.repeat(74)}`);

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';
const ownerEmail = `dpo-e2e-${sfx}@westgate.example`;

console.log(`\nDPR portal + queue, driven through the browser`);
console.log(`API ${API}   WEB ${WEB}`);

// The tenant is provisioned over the API — registering + enrolling MFA through
// the UI is the identity suite's job, not this one's, and doing it here would
// make a DPR failure look like an auth failure.
step(1, 'Provision a tenant (API) so the browser walk starts at the portal');
const reg = await api('POST', '/auth/register', {
  body: {
    organisationName: `Westgate Insurance ${sfx}`,
    ownerEmail,
    ownerName: 'Priya Nair',
    password: PASSWORD,
  },
});
const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
const mfaSecret = base32Decode(enrol.secret);
const confirmed = await api('POST', '/auth/mfa/confirm', {
  body: { challengeToken: reg.mfaEnrolmentToken, code: totp(mfaSecret) },
});
const me = await api('GET', '/auth/me', { token: confirmed.accessToken });
ok(`tenant ready, portal ${WEB}/portal/${me.portalSlug}`);

const EXPECTED_DAYS = {
  access: 30,
  correction: 30,
  erasure: 30,
  nomination: 30,
  portability: 30,
  withdraw_consent: 7,
};
const RIGHT_LABEL = {
  access: 'Access',
  correction: 'Correction',
  erasure: 'Erasure',
  nomination: 'Nomination',
  portability: 'Portability',
  withdraw_consent: 'Withdraw consent',
};

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const filed = [];

try {
  // =========================================================================
  step(2, 'PUBLIC PORTAL: file one request of each of the six rights types');
  // =========================================================================
  for (const rightType of Object.keys(EXPECTED_DAYS)) {
    await page.goto(`${WEB}/portal/${me.portalSlug}`, { waitUntil: 'networkidle' });
    await page.selectOption('#request-type', 'dprequest');

    // The picker only exists for a rights request — its presence IS the
    // assertion that the form branched correctly.
    await page.waitForSelector('[data-testid="right-type"]');
    await page.selectOption('[data-testid="right-type"]', rightType);

    await page.fill('#subject', `Exercising my right of ${rightType.replace(/_/g, ' ')}`);
    await page.fill(
      '#body',
      `I am exercising my statutory right of ${rightType.replace(/_/g, ' ')} under the DPDP Act. ` +
        `Please confirm what you hold about me and act on this request.`,
    );
    await page.fill('#contact-value', `principal-${rightType}-${sfx}@personal.example`);
    await page.click('button[type="submit"]');

    // Step 2 of the stepper. The dev OTP is echoed on screen only because
    // NOTIFY_DEV_ECHO_OTP is on; in production the requester reads it in email.
    await page.waitForSelector('[data-testid="dev-otp"]');
    const otp = (await page.textContent('[data-testid="dev-otp"] strong'))?.trim();
    // innerText, not input value — the code is rendered text here. (Reading it
    // with inputValue() silently returns '' and the form then fails on a
    // six-digit check that has nothing to do with the bug.)
    await page.fill('#otp-code', otp ?? '');
    await page.click('button[type="submit"]');

    await page.waitForSelector('[data-testid="reference-code"]');
    const referenceCode = (await page.textContent('[data-testid="reference-code"]'))?.trim();
    filed.push({ rightType, referenceCode });
    ok(`${referenceCode}  ${rightType}`);
  }

  // =========================================================================
  step(3, 'STAFF QUEUE: all six appear, each with the right deadline');
  // =========================================================================
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  // The login form's inputs carry no ids — selected by type, which is what the
  // markup actually offers.
  await page.fill('input[type="email"]', ownerEmail);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[autocomplete="one-time-code"]');
  await page.fill('input[autocomplete="one-time-code"]', totp(mfaSecret));
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
  ok('signed in as the DPO');

  await page.goto(`${WEB}/dprequest`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="dpr-ticket-table"]');

  // The versioned policy strip: the queue states which record it is judging
  // against, not just a number.
  for (const [rightType, days] of Object.entries(EXPECTED_DAYS)) {
    const row = await page.textContent(`[data-testid="policy-${rightType}"]`);
    if (!row?.includes(`${days} days`) || !row.includes(`dprequest:${rightType} v1`)) {
      bad(`policy strip for ${rightType} reads "${row?.replace(/\s+/g, ' ').trim()}"`);
    }
  }
  ok('policy strip cites dprequest:<right> v1 and its day count for all six rights');

  for (const { rightType, referenceCode } of filed) {
    const rowSel = `[data-testid="dpr-row-${referenceCode}"]`;
    if ((await page.locator(rowSel).count()) === 0) {
      bad(`${referenceCode} (${rightType}) is missing from the queue`);
      continue;
    }
    const shown = (await page.textContent(`[data-testid="dpr-right-${referenceCode}"]`))?.trim();
    const sla = (await page.textContent(`[data-testid="dpr-sla-${referenceCode}"]`))?.trim() ?? '';
    // "Due in 29d 23h" — the countdown rounds down, so the day before the
    // expected figure is the correct expectation, not a tolerance fudge.
    const days = Number(/Due in (\d+)d/.exec(sla)?.[1] ?? -1);
    const expected = EXPECTED_DAYS[rightType];
    if (shown !== RIGHT_LABEL[rightType]) {
      bad(`${referenceCode}: queue shows right "${shown}", expected "${RIGHT_LABEL[rightType]}"`);
    } else if (days !== expected - 1 && days !== expected) {
      bad(`${referenceCode} (${rightType}): countdown says ${days}d, expected ~${expected}d`);
    } else {
      ok(`${referenceCode}  ${shown.padEnd(17)} ${sla.replace(/\s+/g, ' ')}`);
    }
  }

  // =========================================================================
  step(4, 'The queue filters by right, and the detail page carries the clock');
  // =========================================================================
  await page.selectOption('#right-filter', 'withdraw_consent');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="dpr-ticket-table"] tr').length === 1,
    null,
    { timeout: 10_000 },
  );
  ok('filtering by "Withdraw consent" narrows the queue to the one 7-day request');

  const target = filed.find((f) => f.rightType === 'withdraw_consent');
  await page.click(`[data-testid="dpr-row-${target.referenceCode}"] a`);
  await page.waitForSelector('[data-testid="dpr-detail-right"]');
  const detailSla = await page.textContent('[data-testid="dpr-detail-sla"]');
  const cited = await page.textContent('body');
  if (!cited?.includes('dprequest:withdraw_consent') || !cited.includes('7 days under')) {
    bad('the detail page does not cite the versioned policy the deadline came from');
  } else {
    ok(`detail page: ${detailSla?.trim()}, cited as 7 days under dprequest:withdraw_consent v1`);
  }
  if (!cited.includes('Subject reference')) bad('the FR-DPR-02 resolution panel is missing');
  else ok('the subject-reference resolution panel is on the page for a handler role');
} finally {
  await browser.close();
}

console.log(process.exitCode ? '\n✗ Something above failed.\n' : '\n✓ All browser checks passed.\n');
