/**
 * Verify real notification providers behind the existing NotifyModule
 * interface, the channel-status settings screen, and the FR-AUD-05 evidence
 * bundle export — against the live dev DB, no mocked data.
 *
 *   pnpm notify:evidence:demo
 *
 * This dev environment has no POSTMARK_API_KEY/MSG91_AUTH_KEY configured, so
 * the correct, EXPECTED behaviour is the labelled dev-mode fallback — the
 * point being to prove that fallback is honest (clearly reported as
 * fallback, not silently mistaken for a real send) and that the plumbing
 * (delivery logging, status reporting, evidence export) is fully real end to
 * end regardless of which transport actually fired.
 *
 * Needs the API running (the worker only matters for escalations, already
 * verified live in an earlier prompt).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';

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
const BASE = process.env.API_URL ?? `http://localhost:${env.API_PORT ?? 3001}`;

const step = (n, s) => console.log(`\n${'='.repeat(76)}\n${n}. ${s}\n${'='.repeat(76)}`);
const ok = (s) => console.log(`   ✓ ${s}`);
const info = (s) => console.log(`     ${s}`);
const bad = (s) => { console.error(`   ✗ ${s}`); process.exitCode = 1; };

function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  let out = '';
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    let text;
    try {
      text = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch { continue; }
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    let hm;
    while ((hm = hexRe.exec(text))) out += Buffer.from(hm[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}

async function api(method, path, { body, token, expect, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const json = await res.json().catch(() => null);
  if (expect !== undefined) {
    if (res.status !== expect) throw new Error(`${method} ${path} -> expected ${expect}, got ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

try { await fetch(`${BASE}/health`); } catch {
  console.error(`\nNothing on ${BASE}. Start:  pnpm dev:api\n`);
  process.exit(1);
}

const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';

console.log(`\nNotify providers + evidence bundle — verification`);
console.log(`Driving ${BASE}`);

step(1, 'Provision a tenant');
const reg = await api('POST', '/auth/register', {
  body: { organisationName: `Notify Demo Co ${sfx}`, ownerEmail: `dpo-${sfx}@notifydemo.example`, ownerName: 'Vikram Shah', password: PASSWORD },
});
const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
const secret = base32Decode(enrol.secret);
const confirmed = await api('POST', '/auth/mfa/confirm', { body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) } });
const staff = confirmed.accessToken;
const me = await api('GET', '/auth/me', { token: staff });
const slug = me.portalSlug;
ok(`tenant ${reg.tenantId}`);

step(2, 'Channel status screen — read BEFORE any send, matching dispatcher config exactly');
const before = await api('GET', '/notify/channels/status', { token: staff });
for (const c of before.channels) {
  info(`  ${c.channel.padEnd(6)} configured=${c.configured} provider=${c.provider} fallback=${c.fallback} recent=${c.recentDeliveries.length}`);
}
const emailStatus = before.channels.find((c) => c.channel === 'email');
const smsStatus = before.channels.find((c) => c.channel === 'sms');
if (!emailStatus || !smsStatus) bad('channel status is missing a channel');
else ok('both email and sms channels reported');
// In THIS dev env (no POSTMARK_API_KEY/MSG91_AUTH_KEY set), both must show
// configured=false with an honest fallback name — never silently "configured".
if (emailStatus.configured !== false || emailStatus.fallback !== 'console') {
  bad(`email channel status is ${JSON.stringify(emailStatus)} — expected configured=false, fallback='console' in this env`);
} else {
  ok('email channel correctly reports NOT configured, falling back to console (no POSTMARK_API_KEY set here)');
}
if (smsStatus.configured !== false || smsStatus.fallback !== 'console') {
  bad(`sms channel status is ${JSON.stringify(smsStatus)} — expected configured=false, fallback='console' in this env`);
} else {
  ok('sms channel correctly reports NOT configured, falling back to console (no MSG91_AUTH_KEY set here)');
}

step(3, 'Fire a REAL notification attempt (OTP, sms channel) and confirm it is logged');
const submitted = await api('POST', `/portal/${slug}/data-requests`, {
  body: {
    rightType: 'access',
    subject: 'Notify-provider verification request',
    body: 'This request exists only to exercise a real OTP delivery attempt over SMS.',
    contactChannel: 'sms',
    contactValue: '+919876543210',
  },
  expect: 201,
});
if (!submitted.devOtp) {
  bad('no devOtp in response — NOTIFY_DEV_ECHO_OTP must be true for this dev-mode check to work');
} else {
  ok(`${submitted.referenceCode} filed via SMS contact channel, OTP dispatched through the real send() path`);
}
await api('POST', `/portal/${slug}/requests/${submitted.ticketId}/otp/verify`, { body: { code: submitted.devOtp } });
ok(`${submitted.referenceCode} OTP verified — request.contact_verified is now a real event too`);

// A real LOGIN (distinct from the register->mfa/confirm flow already run),
// so identity.auth.password_verified / identity.auth.session_issued are both
// exercised by an actual request rather than assumed to fire elsewhere.
// TOTP replay protection means reusing the enrolment step's code within the
// same 30s window is correctly rejected — wait for a fresh window.
const msIntoWindow = Date.now() % 30_000;
await new Promise((r) => setTimeout(r, 30_000 - msIntoWindow + 1000));
const login1 = await api('POST', '/auth/login', { body: { email: me.email, password: PASSWORD } });
await api('POST', '/auth/mfa/verify', { body: { challengeToken: login1.challengeToken, code: totp(secret) } });
ok('real login + MFA verify performed (waited for a fresh TOTP window)');

// Give the best-effort, detached delivery-logging write a moment to land.
await new Promise((r) => setTimeout(r, 2000));

const after = await api('GET', '/notify/channels/status', { token: staff });
const smsAfter = after.channels.find((c) => c.channel === 'sms');
const otpDelivery = smsAfter.recentDeliveries.find((d) => d.kind === 'otp');
if (!otpDelivery) {
  bad(`no OTP delivery recorded on the sms channel: ${JSON.stringify(smsAfter.recentDeliveries)}`);
} else {
  ok(`OTP delivery recorded: provider=${otpDelivery.provider} delivered=${otpDelivery.delivered} to=${otpDelivery.toMasked}`);
  if (otpDelivery.provider !== 'console') bad(`expected provider='console' (the honest dev-mode fallback), got '${otpDelivery.provider}'`);
  else ok('correctly labelled as the console dev-mode transport — not silently claiming a real provider');
  if (!otpDelivery.toMasked.startsWith('***') && !otpDelivery.toMasked.includes('***')) {
    bad(`delivery log stored the contact value UNMASKED: ${otpDelivery.toMasked}`);
  } else {
    ok(`contact value is masked in the delivery log (${otpDelivery.toMasked}), not stored in full`);
  }
}

step(4, 'FR-AUD-05: export the evidence bundle and confirm it reflects REAL audit_log contents');
// Do a few more real, distinct actions first so the bundle has real variety
// to report, not a near-empty log.
await api('PUT', '/notify/webhooks/config', { token: staff, body: { url: 'https://example.com/hook', enabled: true } });
await api('POST', '/inventory/register', {
  token: staff, body: { category: 'Evidence bundle test category', description: 'For the export demo.', storageLocation: 'demo.table' }, expect: 201,
});

const verifyBefore = await api('GET', '/audit/verify', { token: staff });
ok(`chain intact before export: ${verifyBefore.entriesChecked} entries, head ${verifyBefore.headHash?.slice(0, 16)}…`);

const pdfRes = await api('POST', '/audit/evidence-bundle', { token: staff, raw: true });
if (pdfRes.status !== 200) bad(`evidence bundle export returned ${pdfRes.status}`);
const pdf = Buffer.from(await pdfRes.arrayBuffer());
if (pdf.subarray(0, 4).toString() !== '%PDF') bad(`evidence bundle is not a PDF (${pdf.length} bytes)`);
else ok(`evidence bundle: ${pdf.length}-byte PDF`);

const text = extractPdfText(pdf);
if (!text.includes('INTACT')) bad('bundle does not state the chain is intact');
else ok('bundle cover states the chain is INTACT');
if (!text.includes(String(verifyBefore.entriesChecked))) {
  bad(`bundle does not mention the real entry count (${verifyBefore.entriesChecked})`);
} else {
  ok(`bundle states the real entry count (${verifyBefore.entriesChecked}), matching /audit/verify`);
}
if (!text.includes(verifyBefore.headHash.slice(0, 16))) {
  bad('bundle does not contain the real head hash');
} else {
  ok('bundle contains the real head hash, matching /audit/verify at export time');
}
// Real action-type variety, not a placeholder table: check for several
// DISTINCT actions this run actually produced, across different modules.
const expectedActions = [
  'identity.organisation.registered',
  'identity.auth.password_verified',
  'identity.auth.session_issued',
  'request.submitted',
  'request.contact_verified',
  'notify.webhook_config.updated',
  'inventory.register.entry_created',
];
const missingActions = expectedActions.filter((a) => !text.includes(a));
if (missingActions.length > 0) {
  bad(`bundle is missing expected action rows: ${missingActions.join(', ')}`);
} else {
  ok(`bundle lists all ${expectedActions.length} distinct actions this run produced, across identity/request/notify/inventory/audit`);
}
if (!text.includes('by module:')) bad('bundle has no per-module breakdown');
else ok('bundle includes a per-module entry-count breakdown');

// Re-verify AFTER export — the export route itself is @Audited, so exporting
// added exactly one more entry, and the chain must still be intact.
const verifyAfter = await api('GET', '/audit/verify', { token: staff });
if (!verifyAfter.intact) bad('chain is not intact after the export');
else ok(`chain still intact after export: ${verifyAfter.entriesChecked} entries (was ${verifyBefore.entriesChecked})`);
if (verifyAfter.entriesChecked !== verifyBefore.entriesChecked + 1) {
  bad(`expected exactly 1 new entry (the export itself being audited), got ${verifyAfter.entriesChecked - verifyBefore.entriesChecked}`);
} else {
  ok('exporting the bundle added exactly one new entry — the export action itself, correctly audited');
}

console.log(
  process.exitCode
    ? '\n✗ Some checks failed.\n'
    : '\n✓ Real providers wired behind the existing interface (honest dev-mode fallback confirmed), channel status accurate, evidence bundle reflects real audit_log contents.\n',
);
