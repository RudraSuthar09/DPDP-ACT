/**
 * Idempotent demo-data seed for a live pilot walkthrough.
 *
 *   pnpm build          (once, or after any backend change)
 *   pnpm dev:api         (terminal 1 — this script drives the real API)
 *   pnpm seed:demo       (terminal 2)
 *
 * Populates ONE fixed, clearly-synthetic tenant ("Demo — Meridian Health")
 * across every module, entirely through the real HTTP surface the frontend
 * and the other scripts/*.mjs proofs use — never a raw INSERT. Nothing here
 * is a customer record: every name, email, phone number and customer id is
 * invented and marked "Demo — " so it can never be mistaken for pilot data.
 *
 * IDEMPOTENT, not merely re-runnable: every module is seeded from a query
 * against the tenant's OWN current state (not a local cache), so running
 * this twice against the same tenant does not duplicate purposes, notices,
 * tickets or incidents. The one thing that cannot be re-derived from the
 * server — the demo owner's TOTP secret, since MFA enrolment happens once —
 * is persisted locally in .seed-demo-state.json (gitignored) so a second run
 * can log back in instead of re-registering.
 *
 * Needs NOTIFY_DEV_ECHO_OTP=true (already set in .env) so the public-portal
 * OTP round trip can complete without a real inbox — same requirement as
 * scripts/request-substrate-demo.mjs and scripts/dprequest-demo.mjs.
 *
 * The worker (pnpm --filter @dpdp/api dev:worker) is NOT required: nothing
 * here waits for a deadline to actually fire. The dashboard's open-item
 * counters and the late-closure register export both key off timestamps
 * this script produces directly (a ticket resolved after its own due date),
 * not off the escalation ladder firing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, 'scripts', '.seed-demo-state.json');
const EXPORT_DIR = join(ROOT, 'backend', 'var', 'seed-demo-exports');

// ===========================================================================
// Safety: refuse outright against a production environment (R6 in spirit —
// this is demo data, and demo data in a production tenant is exactly the
// "just temporarily" mistake that rule exists to prevent).
// ===========================================================================
const envFile = existsSync(join(ROOT, '.env'))
  ? Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  : {};
if (process.env.NODE_ENV === 'production' || envFile.NODE_ENV === 'production') {
  console.error(
    '\nRefusing to run: NODE_ENV=production.\n' +
      'This script writes clearly-synthetic demo data and must never touch a production tenant.\n',
  );
  process.exit(1);
}

const distTotp = join(ROOT, 'backend', 'dist', 'modules', 'identity', 'crypto', 'totp.js');
if (!existsSync(distTotp)) {
  console.error('The backend is not built yet. Run:  pnpm build');
  process.exit(1);
}
const { totp } = await import(`file:///${distTotp.replace(/\\/g, '/')}`);
const { base32Decode } = await import(
  `file:///${join(ROOT, 'backend', 'dist', 'modules', 'identity', 'crypto', 'base32.js').replace(/\\/g, '/')}`
);

const BASE = process.env.API_URL ?? `http://localhost:${envFile.API_PORT ?? 3001}`;

async function api(method, path, { body, token, expect, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (expect !== undefined ? res.status !== expect : res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

const step = (n, s) => console.log(`\n${'='.repeat(76)}\n${n}. ${s}\n${'='.repeat(76)}`);
const ok = (s) => console.log(`   + ${s}`);
const skip = (s) => console.log(`   . ${s} (already seeded)`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await fetch(`${BASE}/health`);
} catch {
  console.error(
    `\nNothing is answering on ${BASE}.\n\nStart it first:\n   pnpm build\n   pnpm dev:api\n`,
  );
  process.exit(1);
}

// ===========================================================================
// Fixed identifiers — one demo tenant, every field obviously synthetic.
// ===========================================================================
const DEMO_TAG = 'Demo — ';
const OWNER_EMAIL = 'owner@demo-pilot.dpdp.invalid';
const OWNER_NAME = `${DEMO_TAG}Asha Rao (Compliance Owner)`;
const ORG_NAME = `${DEMO_TAG}Meridian Health (Pilot Walkthrough)`;
const PASSWORD = 'Demo-Pilot-Seed-Value-2026!';

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

console.log(`\nDPDP demo-data seed — ${ORG_NAME}`);
console.log(`Driving ${BASE}`);

// ===========================================================================
step(1, 'Provision (or resume) the fixed demo tenant and staff session');
// ===========================================================================
let staff;
let tenantId;
let ownerUserId;

if (state.mfaSecretBase32) {
  // We have enrolled MFA before — log back in rather than re-registering.
  const login = await api('POST', '/auth/login', { body: { email: OWNER_EMAIL, password: PASSWORD }, raw: true });
  if (login.ok) {
    const loginBody = await login.json();
    const verify = await api('POST', '/auth/mfa/verify', {
      body: { challengeToken: loginBody.challengeToken, code: totp(base32Decode(state.mfaSecretBase32)) },
    });
    staff = verify.accessToken;
    ok(`resumed existing demo tenant via login (MFA secret from ${STATE_FILE})`);
  }
}

if (!staff) {
  const reg = await api('POST', '/auth/register', {
    body: { organisationName: ORG_NAME, ownerEmail: OWNER_EMAIL, ownerName: OWNER_NAME, password: PASSWORD },
    raw: true,
  });
  if (reg.status === 201) {
    const regBody = await reg.json();
    const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: regBody.mfaEnrolmentToken } });
    const secret = base32Decode(enrol.secret);
    const confirmed = await api('POST', '/auth/mfa/confirm', {
      body: { challengeToken: regBody.mfaEnrolmentToken, code: totp(secret) },
    });
    staff = confirmed.accessToken;
    state.mfaSecretBase32 = enrol.secret;
    saveState();
    ok(`registered fresh demo tenant ${regBody.tenantId}`);
  } else if (reg.status === 409) {
    // The tenant exists server-side but our local MFA secret was lost — this
    // demo account cannot be recovered without it (MFA is not optional here).
    // Documented limitation, not a bug: drop the demo tenant's rows and rerun,
    // or restore .seed-demo-state.json from backup.
    console.error(
      `\nAn account already exists for ${OWNER_EMAIL} but ${STATE_FILE} has no MFA secret for it.\n` +
        'This demo tenant cannot be recovered without its original TOTP secret. Either restore ' +
        'the state file, or remove the tenant from the database and rerun this script.\n',
    );
    process.exit(1);
  } else {
    throw new Error(`POST /auth/register -> unexpected ${reg.status}`);
  }
}

const me = await api('GET', '/auth/me', { token: staff });
tenantId = me.tenantId ?? null;
ownerUserId = me.userId;
const portalSlug = me.portalSlug;
ok(`staff session: ${me.email} (${me.role}) · portal /portal/${portalSlug}`);

// ===========================================================================
step(2, 'Name the escalation ladder (idempotent — designations are upserts)');
// ===========================================================================
for (const designation of ['grievance_officer', 'dpo', 'escalation_contact']) {
  await api('POST', '/users/designations', {
    token: staff,
    body: { designation, userId: ownerUserId, reason: 'Demo seed: naming the escalation ladder' },
  });
}
ok('grievance_officer / dpo / escalation_contact -> Demo — Asha Rao (all three rungs, single-user demo tenant)');

// ===========================================================================
step(3, 'Data Inventory — apply the healthcare sector template (FR-INV-11)');
// ===========================================================================
const registerBefore = await api('GET', '/inventory/register', { token: staff });
let inventoryEntries;
if (registerBefore.elements.some((e) => e.category === 'Patient full name')) {
  skip('healthcare sector template');
  inventoryEntries = registerBefore.elements;
} else {
  const templates = await api('GET', '/inventory/sector-templates', { token: staff });
  const healthcare = templates.templates.find((t) => t.sector === 'healthcare');
  const applied = await api('POST', `/inventory/sector-templates/${healthcare.id}/apply`, { token: staff, expect: 201 });
  ok(`applied "${applied.template.name}" — ${applied.created.length} data elements seeded`);
  const after = await api('GET', '/inventory/register', { token: staff });
  inventoryEntries = after.elements;
}
const entryByCategory = (category) => inventoryEntries.find((e) => e.category === category);

// ===========================================================================
step(4, 'Consent Register — purposes, bilingual notices, real EventSink events');
// ===========================================================================
async function findOrCreatePurpose(name, description) {
  const { purposes } = await api('GET', '/consent/purposes', { token: staff });
  const existing = purposes.find((p) => p.name === name);
  if (existing) {
    skip(`consent purpose "${name}"`);
    return existing.id;
  }
  const created = await api('POST', '/consent/purposes', { token: staff, body: { name, description }, expect: 201 });
  ok(`consent purpose "${name}" created`);
  return created.id;
}

async function findOrCreateNotice(purposeId, translations) {
  const { notices } = await api('GET', `/consent/purposes/${purposeId}/notices`, { token: staff });
  if (notices.length > 0) {
    skip('notice version');
    return notices[0].id;
  }
  const created = await api('POST', `/consent/purposes/${purposeId}/notices`, {
    token: staff,
    body: { translations },
    expect: 201,
  });
  ok('notice version published (en + hi)');
  return created.id;
}

// Named IDENTICALLY to the healthcare template's inventory purpose so the
// purpose-link suggester (step 5) scores it a perfect match.
const apptPurposeId = await findOrCreatePurpose(
  'Appointment reminders and care coordination',
  'Demo — sending appointment reminders and coordinating care by SMS/email.',
);
const apptNoticeId = await findOrCreateNotice(apptPurposeId, [
  { language: 'en', body: 'We will contact you about upcoming appointments and to coordinate your care.' },
  { language: 'hi', body: 'हम आपको आगामी अपॉइंटमेंट के बारे में सूचित करेंगे और आपकी देखभाल के समन्वय के लिए संपर्क करेंगे।' },
]);

const marketingPurposeId = await findOrCreatePurpose(
  `${DEMO_TAG}Marketing communications and promotional offers`,
  'Demo — wellness-camp and promotional-offer communications, opt-in only.',
);
const marketingNoticeId = await findOrCreateNotice(marketingPurposeId, [
  { language: 'en', body: 'With your consent, we may send you wellness camp invitations and promotional offers.' },
  { language: 'hi', body: 'आपकी सहमति से, हम आपको वेलनेस कैंप के निमंत्रण और प्रचार ऑफ़र भेज सकते हैं।' },
]);

// Synthetic Indian data-principal identifiers — never a real customer id.
const CUST_ANANYA = 'DEMO-CUST-ANANYA-0001';
const CUST_VIKRAM = 'DEMO-CUST-VIKRAM-0002'; // the grant + withdrawal pair, and the DPR access subject
const CUST_FATIMA = 'DEMO-CUST-FATIMA-0003';

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

async function recordConsent(customerId, purposeId, noticeVersionId, status, source, occurredAt, key) {
  return api('POST', '/consent/events', {
    token: staff,
    body: { customerId, purposeId, noticeVersionId, status, source, occurredAt, idempotencyKey: key },
    expect: 201,
  });
}

// recordConsent is idempotent on idempotencyKey server-side (S2), so these are
// always safe to re-run — no existence check needed.
await recordConsent(CUST_ANANYA, apptPurposeId, apptNoticeId, 'GRANTED', 'web_sdk', daysAgo(6), 'seed-ananya-appt-grant');
await recordConsent(CUST_ANANYA, marketingPurposeId, marketingNoticeId, 'GRANTED', 'web_sdk', daysAgo(6), 'seed-ananya-mkt-grant');

await recordConsent(CUST_VIKRAM, apptPurposeId, apptNoticeId, 'GRANTED', 'portal', daysAgo(5), 'seed-vikram-appt-grant');
await recordConsent(CUST_VIKRAM, marketingPurposeId, marketingNoticeId, 'GRANTED', 'portal', daysAgo(5), 'seed-vikram-mkt-grant');
await recordConsent(CUST_VIKRAM, marketingPurposeId, marketingNoticeId, 'WITHDRAWN', 'portal', daysAgo(1), 'seed-vikram-mkt-withdraw');

await recordConsent(CUST_FATIMA, apptPurposeId, apptNoticeId, 'GRANTED', 'mobile_sdk', daysAgo(2), 'seed-fatima-appt-grant');
ok('3 data principals: grants, plus one grant-then-withdrawal pair (Vikram / marketing)');

// ===========================================================================
step(5, 'Link the consent purpose to its inventory purpose (Tier-1 attribution)');
// ===========================================================================
const existingLinks = await api('GET', '/dprequest/purpose-links', { token: staff });
if (existingLinks.links.some((l) => l.consentPurposeId === apptPurposeId)) {
  skip('purpose link');
} else {
  const { suggestions } = await api('GET', '/dprequest/purpose-links/suggestions', { token: staff });
  const match = suggestions.find((s) => s.consentPurposeId === apptPurposeId);
  if (!match) {
    throw new Error('Expected a purpose-link suggestion for the appointment-reminders purpose; found none.');
  }
  await api('POST', '/dprequest/purpose-links', {
    token: staff,
    body: { consentPurposeId: match.consentPurposeId, inventoryPurposeId: match.inventoryPurposeId },
    expect: 201,
  });
  ok(`linked "${match.consentPurposeName}" -> inventory purpose (confidence ${match.confidence})`);
}

// ===========================================================================
step(6, 'Grievance Register — a few tickets across different lifecycle states');
// ===========================================================================
async function submitAndVerify(kind, body) {
  const path = kind === 'grievance' ? `/portal/${portalSlug}/grievances` : `/portal/${portalSlug}/data-requests`;
  const submitted = await api('POST', path, { body, expect: 201 });
  if (!submitted.devOtp) {
    throw new Error('No devOtp echoed — set NOTIFY_DEV_ECHO_OTP=true in .env and restart the API.');
  }
  const verified = await api('POST', `/portal/${portalSlug}/requests/${submitted.ticketId}/otp/verify`, {
    body: { code: submitted.devOtp },
  });
  return { ...submitted, ...verified };
}

// Guarded per-category, not by a total count — a crash partway through this
// step (network hiccup, ctrl-C) must not cause a rerun to recreate tickets
// that already exist just because the total looked low.
const existingGrievances = (await api('GET', '/grievance/tickets?limit=50', { token: staff })).tickets;
const grievanceExists = (category) => existingGrievances.some((t) => t.category === category);

// G1 — filed, handed off, resolved on time.
if (grievanceExists('unauthorized_sharing')) {
  skip('grievance G1 (unauthorized_sharing)');
} else {
  const g1 = await submitAndVerify('grievance', {
    category: 'unauthorized_sharing',
    subject: `${DEMO_TAG}My data was shared with a third party without consent`,
    body:
      'I received marketing SMS from a company I have never dealt with, quoting details I only ever ' +
      'gave to the hospital. Please tell me who you shared my information with and why.',
    contactChannel: 'email',
    contactValue: 'demo.reena.sharma@dpdp-demo.invalid',
  });
  await api('POST', `/requests/${g1.ticketId}/identity-verification`, {
    token: staff,
    body: { outcome: 'matched', reason: 'Matched to a patient record in our HMS by registered email.' },
  });
  await api('POST', `/requests/${g1.ticketId}/correspondence`, {
    token: staff,
    body: { direction: 'outbound', body: 'We identified the recipient and have withdrawn the data-sharing arrangement.' },
  });
  await api('POST', `/requests/${g1.ticketId}/status`, {
    token: staff,
    body: {
      status: 'resolved',
      reason: 'Third-party recipient identified and sharing stopped',
      resolution: 'Data-sharing arrangement withdrawn; recipient instructed to delete the data.',
    },
  });
  ok(`G1 ${g1.referenceCode} — unauthorized_sharing, resolved on time`);
}

// G2 — filed, handed off, left in_progress (an active complaint on the queue).
if (grievanceExists('marketing_after_opt_out')) {
  skip('grievance G2 (marketing_after_opt_out)');
} else {
  const g2 = await submitAndVerify('grievance', {
    category: 'marketing_after_opt_out',
    subject: `${DEMO_TAG}Still receiving marketing after I opted out`,
    body: 'I withdrew my marketing consent last week through your portal but received a promotional SMS yesterday.',
    contactChannel: 'sms',
    // E.164-ish only (backend/src/modules/request/dto.ts: /^\+?[0-9]{8,15}$/)
    // — a synthetic Indian mobile number, never a real one.
    contactValue: '+919900000002',
  });
  await api('POST', `/requests/${g2.ticketId}/identity-verification`, {
    token: staff,
    body: { outcome: 'matched', reason: 'Matched to a patient record in our HMS by registered mobile number.' },
  });
  await api('POST', `/requests/${g2.ticketId}/correspondence`, {
    token: staff,
    body: { direction: 'internal_note', body: 'Checking the marketing platform sync lag with the withdrawal event.' },
  });
  await api('POST', `/requests/${g2.ticketId}/status`, {
    token: staff,
    body: { status: 'in_progress', reason: 'Investigating a possible sync delay in the marketing platform.' },
  });
  ok(`G2 ${g2.referenceCode} — marketing_after_opt_out, in_progress`);
}

// G3 — freshly filed and verified only, still awaiting the identity handoff.
if (grievanceExists('excessive_collection')) {
  skip('grievance G3 (excessive_collection)');
} else {
  const g3 = await submitAndVerify('grievance', {
    category: 'excessive_collection',
    subject: `${DEMO_TAG}Asked for more information than necessary at registration`,
    body: 'The registration desk asked for my full family details, which does not seem necessary for an OPD visit.',
    contactChannel: 'email',
    contactValue: 'demo.arjun.mehta@dpdp-demo.invalid',
  });
  ok(`G3 ${g3.referenceCode} — excessive_collection, awaiting identity verification (fresh in the queue)`);
}

// ===========================================================================
step(7, 'Data Principal Request Tracker — one on-time, one deliberately late');
// ===========================================================================
// Guarded per rightType — the correction ticket involves a real 65s wait, and
// a crash or ctrl-C during that wait is realistic enough to design around.
const dprByType = async (rightType) =>
  (await api('GET', `/dprequest/tickets?rightType=${rightType}&limit=10`, { token: staff })).tickets;

// 7a — an ACCESS request, resolved on time, with a real Tier-1 Personal Data
// Summary — "the demo moment" per the master build document.
if ((await dprByType('access')).length > 0) {
  skip('DPR access request');
} else {
  const access = await submitAndVerify('dprequest', {
    rightType: 'access',
    subject: `${DEMO_TAG}Request to know what personal data you hold about me`,
    body: 'Please tell me what personal information you hold about me, why, and for how long, under the DPDP Act.',
    contactChannel: 'email',
    contactValue: 'demo.vikram.rao@dpdp-demo.invalid',
  });
  await api('POST', `/requests/${access.ticketId}/identity-verification`, {
    token: staff,
    body: { outcome: 'matched', reason: 'Matched to a patient record in our HMS by registered email.' },
  });
  await api('POST', `/dprequest/tickets/${access.ticketId}/subject-reference`, {
    token: staff,
    body: { customerId: CUST_VIKRAM, reason: 'Verified against our HMS patient record during identity verification.' },
  });
  const summary = await api('POST', `/dprequest/tickets/${access.ticketId}/personal-data-summary`, { token: staff });
  await api('POST', `/requests/${access.ticketId}/status`, {
    token: staff,
    body: {
      status: 'resolved',
      reason: 'Personal Data Summary assembled and shared with the requester',
      resolution: 'Tier-1 summary provided; no Tier-2 fulfilment required for this access request.',
    },
  });
  ok(`ACCESS ${access.referenceCode} — resolved on time; Tier-1 summary covers ${summary.dataCategories.length} data categor${summary.dataCategories.length === 1 ? 'y' : 'ies'}`);
}

// 7b — a CORRECTION request deliberately closed AFTER its own deadline, to
// exercise the late-closure path in the register export (FR-DPR-06/09). The
// statutory floor on a superseded SLA is 60 seconds; we shorten to that floor
// just long enough to seed one late example, then restore the normal 30-day
// default so every request filed afterwards behaves realistically.
//
// The "shorten -> file -> wait -> resolve -> restore" sequence spans a real
// 65s sleep, which is the single most likely place for this script to be
// interrupted. So the restore step is verified independently below, keyed off
// the POLICY'S state rather than the ticket's — an interrupted run must never
// leave every future correction request in this tenant with a 60-second clock.
const STANDARD_LADDER = [
  { level: 1, atPercent: 50, rung: 'grievance_officer' },
  { level: 2, atPercent: 80, rung: 'dpo' },
  { level: 3, atPercent: 100, rung: 'escalation_contact' },
];
const STANDARD_CORRECTION_DAYS = 30;

if ((await dprByType('correction')).length > 0) {
  skip('DPR correction request (late-closure example)');
} else {
  await api('POST', '/dprequest/deadline-policies/correction', {
    token: staff,
    body: {
      slaSeconds: 60,
      ladder: STANDARD_LADDER,
      note: 'Demo seed: temporarily shortened to the 60s floor to seed one realistic late-closure example.',
    },
    expect: 201,
  });

  const correction = await submitAndVerify('dprequest', {
    rightType: 'correction',
    subject: `${DEMO_TAG}My date of birth is recorded incorrectly`,
    body: 'My date of birth on file is one day off from my Aadhaar record. Please correct it.',
    contactChannel: 'email',
    contactValue: 'demo.fatima.sheikh@dpdp-demo.invalid',
  });
  await api('POST', `/requests/${correction.ticketId}/identity-verification`, {
    token: staff,
    body: { outcome: 'matched', reason: 'Matched to a patient record in our HMS by registered email.' },
  });
  await api('POST', `/dprequest/tickets/${correction.ticketId}/subject-reference`, {
    token: staff,
    body: { customerId: CUST_FATIMA, reason: 'Verified against our HMS patient record during identity verification.' },
  });

  console.log('   waiting ~65s for the 60-second window to pass (so this closes LATE)...');
  await sleep(65_000);

  await api('POST', `/requests/${correction.ticketId}/status`, {
    token: staff,
    body: {
      status: 'resolved',
      reason: 'Date of birth corrected in the HMS after verification against the Aadhaar record',
      resolution: 'Corrected; closing past the shortened demo window on purpose to illustrate the register export.',
    },
  });
  ok(`CORRECTION ${correction.referenceCode} — resolved AFTER its deadline (closedOnTime=false)`);
}

// Independent of whether a ticket was just created or already existed: if the
// correction policy is still sitting at the demo-shortened window (whether
// from this run or an interrupted earlier one), restore the statutory default.
const { policies: policiesNow } = await api('GET', '/dprequest/deadline-policies', { token: staff });
const correctionNow = policiesNow.find((p) => p.rightType === 'correction');
if (correctionNow && correctionNow.slaDays < 1) {
  await api('POST', '/dprequest/deadline-policies/correction', {
    token: staff,
    body: {
      slaSeconds: STANDARD_CORRECTION_DAYS * 86400,
      ladder: STANDARD_LADDER,
      note: 'Demo seed: restored the standard statutory window after seeding one late-closure example.',
    },
    expect: 201,
  });
  ok(`correction deadline policy restored to ${STANDARD_CORRECTION_DAYS} days`);
} else {
  skip('correction deadline policy already at its statutory default');
}

// ===========================================================================
step(8, 'Breach Register — one incident, partway through its gated workflow');
// ===========================================================================
const existingIncidents = await api('GET', '/breach/incidents?limit=50', { token: staff });
let incidentId;
if (existingIncidents.incidents.length >= 1) {
  incidentId = existingIncidents.incidents[0].id;
  skip(`breach incident ${existingIncidents.incidents[0].referenceCode ?? incidentId}`);
} else {
  const patientName = entryByCategory('Patient full name');
  const diagnosis = entryByCategory('Diagnosis / medical history notes');
  const incident = await api('POST', '/breach/incidents', {
    token: staff,
    body: {
      title: `${DEMO_TAG}Misconfigured backup bucket exposed patient records`,
      whatHappened:
        'A nightly database backup was written to an object-storage bucket whose access policy had been ' +
        'changed to public during unrelated maintenance. The bucket was reachable without credentials for ' +
        'approximately 18 hours before an internal routine scan flagged it.',
      discoveredAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      occurredAt: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
      systemsAffected: ['hms-primary', 'nightly-backup-pipeline', 'object-storage:ap-south-1'],
      dataCategoryEntryIds: [patientName?.id, diagnosis?.id].filter(Boolean),
      estimatedAffectedCount: 640,
      severity: 'high',
    },
    expect: 201,
  });
  incidentId = incident.id;
  ok(`incident ${incident.referenceCode} opened, severity ${incident.severity}`);
}

const incidentDetail = await api('GET', `/breach/incidents/${incidentId}`, { token: staff });
const gateNotes = {
  acknowledge: 'Incident acknowledged by the on-call DPO; bucket ACL reverted to private immediately.',
  assess: 'Assessed: two data categories exposed, approximately 640 patients, bucket public for ~18 hours.',
};
for (const gate of ['acknowledge', 'assess']) {
  const status = incidentDetail.gateStatuses.find((g) => g.gate === gate);
  if (status?.completedAt) {
    skip(`gate ${gate}`);
  } else {
    await api('POST', `/breach/incidents/${incidentId}/gates/${gate}`, { token: staff, body: { notes: gateNotes[gate] } });
    ok(`gate passed: ${gate}`);
  }
}
if (!incidentDetail.evidence || incidentDetail.evidence.length === 0) {
  const evidenceBody = 'DEMO FORENSIC EXTRACT — bucket ACL change history (synthetic, for pilot walkthrough only).';
  await api('POST', `/breach/incidents/${incidentId}/evidence`, {
    token: staff,
    body: {
      fileName: 'demo-bucket-acl-history.txt',
      contentType: 'text/plain',
      contentBase64: Buffer.from(evidenceBody, 'utf8').toString('base64'),
      description: 'Demo evidence: access-log excerpt showing the public window.',
    },
    expect: 201,
  });
  ok('evidence attached (sha256 recorded; bytes never stored)');
} else {
  skip('evidence');
}
ok('incident left OPEN, stopped at notify_data_principals — partway through the gated workflow');

// ===========================================================================
step(9, 'Evidence exports — RoPA, grievance resolution, and the late-closure DPR register');
// ===========================================================================
mkdirSync(EXPORT_DIR, { recursive: true });

async function saveExport(name, res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const path = join(EXPORT_DIR, name);
  writeFileSync(path, buf);
  return { path, size: buf.length, isPdf: buf.subarray(0, 4).toString() === '%PDF' };
}

const ropaRes = await api('POST', '/inventory/ropa/export', { token: staff, body: { format: 'pdf' }, raw: true });
const ropaFile = await saveExport('ropa.pdf', ropaRes);
ok(`RoPA export: ${ropaFile.size} bytes, valid PDF=${ropaFile.isPdf} -> ${ropaFile.path}`);

const resolvedGrievances = (await api('GET', '/grievance/tickets?status=resolved&limit=50', { token: staff })).tickets;
const g1Ticket = resolvedGrievances.find((t) => t.category === 'unauthorized_sharing');
if (g1Ticket) {
  const resolutionRes = await api('POST', `/grievance/tickets/${g1Ticket.id}/resolution-export`, {
    token: staff,
    raw: true,
  });
  const resolutionFile = await saveExport('grievance-resolution.pdf', resolutionRes);
  ok(`Grievance resolution export: ${resolutionFile.size} bytes, valid PDF=${resolutionFile.isPdf} -> ${resolutionFile.path}`);
} else {
  console.log('   . no resolved grievance found to export (unexpected — G1 should be resolved)');
}

const dprRegisterRes = await api('POST', '/dprequest/register/export', { token: staff, raw: true });
const dprRegisterFile = await saveExport('dpr-register.pdf', dprRegisterRes);
const { stats } = await api('GET', '/dprequest/register', { token: staff });
ok(
  `DPR register export (late-closure path): ${dprRegisterFile.size} bytes, valid PDF=${dprRegisterFile.isPdf} -> ${dprRegisterFile.path}`,
);
ok(`register stats: total=${stats.total} closed=${stats.closed} closedOnTime=${stats.closedOnTime} overdue=${stats.overdue}`);

// ===========================================================================
step(10, 'Dashboard summary — the counters a live pilot walkthrough opens on');
// ===========================================================================
const summary = await api('GET', '/dashboard/summary', { token: staff });
console.log(JSON.stringify(summary, null, 2));

console.log(`\n${'='.repeat(76)}`);
console.log(`Done. Tenant: ${ORG_NAME}`);
console.log(`Sign in as ${OWNER_EMAIL} (password stored only in ${STATE_FILE}).`);
console.log(`Portal: ${BASE}/portal/${portalSlug}`);
console.log('='.repeat(76) + '\n');
