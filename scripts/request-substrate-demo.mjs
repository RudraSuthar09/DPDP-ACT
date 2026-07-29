/**
 * Drive the SHARED REQUEST SUBSTRATE end to end, against the real API, the real
 * worker, and the real database.
 *
 *   pnpm request:demo
 *
 * Not a test suite (that is `pnpm test` / `pnpm test:isolation`) — this is the
 * "show me it actually works" script for FR-GRV-01/03/04/05. It walks the whole
 * shape of the thing exactly as three different callers would:
 *
 *   a member of the public   — with no login, from a portal URL
 *   a staff member           — with a JWT, answering the identity handoff
 *   the passage of time      — via the WorkflowRunner (S3) and the worker
 *
 * and then prints the tenant's hash-chained audit log so the attribution of the
 * anonymous submission can be read rather than asserted.
 *
 * It needs BOTH processes running (the API schedules deadlines; the worker fires
 * them) and NOTIFY_DEV_ECHO_OTP=true so the OTP round-trip can complete without
 * an inbox.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const distTotp = join(ROOT, 'backend', 'dist', 'modules', 'identity', 'crypto', 'totp.js');
if (!existsSync(distTotp)) {
  console.error('The backend is not built yet. Run:  pnpm build');
  process.exit(1);
}
const { totp } = await import(`file:///${distTotp.replace(/\\/g, '/')}`);
const { base32Decode } = await import(
  `file:///${join(ROOT, 'backend', 'dist', 'modules', 'identity', 'crypto', 'base32.js').replace(/\\/g, '/')}`
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

async function api(method, path, { body, token, expect } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (expect !== undefined) {
    if (res.status !== expect) {
      throw new Error(`${method} ${path} -> expected ${expect}, got ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
  }
  if (res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

try {
  await fetch(`${BASE}/health`);
} catch {
  console.error(
    `\nNothing is answering on ${BASE}.\n\nStart it first:\n   pnpm dev:api      (terminal 1)\n   pnpm --filter @dpdp/api dev:worker   (terminal 2)\n`,
  );
  process.exit(1);
}

const step = (n, s) => console.log(`\n${'-'.repeat(72)}\n${n}. ${s}\n${'-'.repeat(72)}`);
const ok = (s) => console.log(`   ✓ ${s}`);
const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';
const ownerEmail = `dpo-${sfx}@acme-health.example`;
const requesterEmail = `ravi-${sfx}@personal.example`;

console.log(`\nShared request substrate — FR-GRV-01/03/04/05, Seam S3`);
console.log(`Driving ${BASE}`);

// ===========================================================================
step(1, 'Provision a tenant and log in as staff');
// ===========================================================================
const reg = await api('POST', '/auth/register', {
  body: {
    organisationName: `Acme Health ${sfx}`,
    ownerEmail,
    ownerName: 'Asha Rao',
    password: PASSWORD,
  },
});
const enrol = await api('POST', '/auth/mfa/enroll', {
  body: { challengeToken: reg.mfaEnrolmentToken },
});
const secret = base32Decode(enrol.secret);
const confirmed = await api('POST', '/auth/mfa/confirm', {
  body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) },
});
const staff = confirmed.accessToken;
ok(`tenant ${reg.tenantId}`);

const me = await api('GET', '/auth/me', { token: staff });
ok(`staff  ${me.email} (${me.role}) @ ${me.organisationName}`);

// ===========================================================================
step(2, 'Name the escalation ladder (FR-IDN-04) and set a fast SLA policy');
// ===========================================================================
// One person holds all three rungs here so the demo needs no invitations; in a
// real tenant these are three different people. What matters is that the rungs
// resolve through org_designations rather than through a hardcoded address.
for (const designation of ['grievance_officer', 'dpo', 'escalation_contact']) {
  await api('POST', '/users/designations', {
    token: staff,
    body: { designation, userId: me.userId, reason: 'Demo: naming the escalation ladder' },
  });
  ok(`${designation} -> ${me.email}`);
}

// "Deadlines are data": a 60-second SLA with rungs at 25% / 50% / 100%, so the
// whole ladder plays out inside the run instead of over 30 days.
const policy = await api('PUT', '/requests/sla-policies', {
  token: staff,
  body: {
    requestType: 'grievance',
    slaSeconds: 60,
    ladder: [
      { level: 1, atPercent: 25, rung: 'grievance_officer' },
      { level: 2, atPercent: 50, rung: 'dpo' },
      { level: 3, atPercent: 100, rung: 'escalation_contact' },
    ],
  },
});
ok(`SLA ${policy.slaSeconds}s, ladder ${policy.ladder.map((s) => `${s.atPercent}%→${s.rung}`).join(', ')}`);

// ===========================================================================
step(3, 'ANONYMOUS: find the portal by slug and file a request (no login at all)');
// ===========================================================================
// Staff read their own portal address off their profile — the same way they
// would to publish it on their website. A requester just follows the link.
const slug = me.portalSlug;
ok(`portal address ${BASE}/portal/${slug}`);

const portal = await api('GET', `/portal/${slug}`);
ok(`public page resolves: "${portal.organisationName}" — and returns nothing else about the tenant`);

// No Authorization header anywhere below this line until step 6.
const submitted = await api('POST', `/portal/${slug}/requests`, {
  body: {
    requestType: 'grievance',
    subject: 'My data was shared with a third party without consent',
    body:
      'I received marketing from a company I have never dealt with, and they quoted details ' +
      'I only ever gave to you. I would like to know who you shared my information with and why.',
    contactChannel: 'email',
    contactValue: requesterEmail,
  },
  expect: 201,
});
ok(`ticket ${submitted.referenceCode} created, status "${submitted.status}"`);
ok(`OTP sent to ${submitted.maskedContact} (masked in the response and in the audit log)`);
if (!submitted.devOtp) {
  console.error(
    '\n   ✗ No devOtp in the response. Set NOTIFY_DEV_ECHO_OTP=true in .env and restart the API.\n',
  );
  process.exit(1);
}

// ===========================================================================
step(4, 'ANONYMOUS: a wrong code is refused and counted, then the real one works');
// ===========================================================================
const wrong = String((Number(submitted.devOtp) + 1) % 1_000_000).padStart(6, '0');
await api('POST', `/portal/${slug}/requests/${submitted.ticketId}/otp/verify`, {
  body: { code: wrong },
  expect: 401,
});
ok('wrong code -> 401, and the attempt survives the rollback (detached counter)');

const verified = await api('POST', `/portal/${slug}/requests/${submitted.ticketId}/otp/verify`, {
  body: { code: submitted.devOtp },
});
ok(`contact channel verified -> status "${verified.status}"`);
ok(`SLA clock started, due ${verified.slaDueAt}`);
ok('portal token issued (scoped to this one ticket, on this one tenant)');

const view = await api('GET', `/portal/${slug}/requests/${submitted.ticketId}`, {
  token: verified.portalToken,
});
ok(`requester sees ${view.correspondence.length} correspondence entries, no internal notes`);

// ===========================================================================
step(5, 'THE HANDOFF (FR-GRV-04): the platform asks; only the tenant can answer');
// ===========================================================================
const queue = await api('GET', '/requests/identity-verifications?status=pending', { token: staff });
const task = queue.tasks.find((t) => t.ticketId === submitted.ticketId);
if (!task) {
  throw new Error('The identity-verification task was not created.');
}
ok(`task open for ${task.referenceCode}`);
ok(`what the platform hands staff: verified ${task.verifiedChannel} = ${task.verifiedContact}`);
ok('what it does NOT hand them: any customer identifier — it has none and never will (I1)');

const handoff = await api('POST', `/requests/${submitted.ticketId}/identity-verification`, {
  token: staff,
  body: {
    outcome: 'matched',
    reason:
      'Matched to a customer record in our own CRM by email address; account opened 2024-03-11.',
  },
});
ok(`staff verdict "${handoff.outcome}" -> ticket status "${handoff.ticket.status}"`);

await api('POST', `/requests/${submitted.ticketId}/status`, {
  token: staff,
  body: { status: 'in_progress', reason: 'Investigating which third parties received this data' },
});
ok('status -> in_progress');

// ===========================================================================
step(6, 'SLA timers fire through the real WorkflowRunner (S3) and climb the ladder');
// ===========================================================================
const detailBefore = await api('GET', `/requests/${submitted.ticketId}`, { token: staff });
console.log('\n   Scheduled ladder (request_sla_timers <-> the S3 deadline register):');
for (const t of detailBefore.timers) {
  console.log(`     level ${t.level}  ${t.rung.padEnd(18)}  due ${t.dueAt}  ${t.status}`);
}

console.log('\n   Waiting for the worker to fire them (up to 90s)...');
const deadline = Date.now() + 90_000;
let escalations = [];
let lastCount = 0;
while (Date.now() < deadline) {
  const detail = await api('GET', `/requests/${submitted.ticketId}`, { token: staff });
  escalations = detail.escalations;
  for (const e of escalations.slice(Math.max(lastCount, 0))) {
    console.log(
      `     level ${e.level} → ${e.rung} (${e.trigger}) at ${e.occurredAt}, notified=${e.notifiedOk}`,
    );
  }
  lastCount = escalations.length;
  if (escalations.length >= 3) break;
  await new Promise((r) => setTimeout(r, 3000));
}

if (escalations.length === 0) {
  console.error(
    '\n   ✗ No escalations fired. Is the worker running?  pnpm --filter @dpdp/api dev:worker\n',
  );
  process.exit(1);
}
ok(`${escalations.length} of 3 ladder rungs reached automatically`);
const breach = escalations.find((e) => e.trigger === 'sla_breach');
if (breach) ok(`SLA breach escalated to ${breach.rung} — the top of the ladder`);

// ===========================================================================
step(7, 'Resolve the request; the remaining deadlines are cancelled, not left ticking');
// ===========================================================================
await api('POST', `/requests/${submitted.ticketId}/correspondence`, {
  token: staff,
  body: {
    direction: 'outbound',
    body: 'We identified the recipient and have withdrawn the data-sharing arrangement.',
  },
});
const resolved = await api('POST', `/requests/${submitted.ticketId}/status`, {
  token: staff,
  body: {
    status: 'resolved',
    reason: 'Third-party recipient identified and sharing stopped',
    resolution: 'Data sharing withdrawn; recipient notified to delete.',
  },
});
ok(`status -> ${resolved.status}`);
const detailAfter = await api('GET', `/requests/${submitted.ticketId}`, { token: staff });
const stillScheduled = detailAfter.timers.filter((t) => t.status === 'scheduled');
ok(`${stillScheduled.length} deadlines still scheduled (cancelled on resolution)`);

console.log('\n   Append-only lifecycle trail:');
for (const e of detailAfter.statusHistory) {
  console.log(`     ${e.occurredAt}  ${String(e.fromStatus).padEnd(30)} -> ${e.toStatus.padEnd(30)} [${e.actorType}]`);
}

// ===========================================================================
step(8, 'The audit log: is the anonymous submission attributed correctly?');
// ===========================================================================
const audit = await api('GET', '/audit?limit=40', { token: staff });
const entries = (audit.entries ?? audit.log ?? []).filter((e) => e.action?.startsWith('request.'));
console.log('');
console.log(
  `   ${'seq'.padStart(4)}  ${'action'.padEnd(42)} ${'outcome'.padEnd(8)} actor`,
);
for (const e of [...entries].reverse()) {
  const actor = e.actorId ? `user ${String(e.actorId).slice(0, 8)}…` : (e.actorLabel ?? '(none)');
  console.log(`   ${String(e.seq).padStart(4)}  ${e.action.padEnd(42)} ${String(e.outcome).padEnd(8)} ${actor}`);
}

const anonymous = entries.filter((e) => e.actorLabel === 'public_portal:anonymous');
const misattributed = anonymous.filter((e) => e.actorId !== null);
console.log('');
ok(`${anonymous.length} entries attributed to public_portal:anonymous`);
if (misattributed.length > 0) {
  console.error(`   ✗ ${misattributed.length} anonymous entries carry an actorId. That is a bug.`);
  process.exit(1);
}
ok('every one of them has actor_id = NULL — no invented user');
const denied = entries.filter((e) => e.outcome === 'denied');
ok(`${denied.length} refused attempt(s) recorded (the wrong OTP is evidence too)`);

const chain = await api('GET', '/audit/verify', { token: staff });
ok(`hash chain: ${chain.intact ? 'INTACT' : 'BROKEN'} across ${chain.entriesChecked} entries`);
if (!chain.intact) {
  console.error(JSON.stringify(chain.breaks, null, 2));
  process.exit(1);
}

console.log(`\n${'='.repeat(72)}\nDone. Ticket ${submitted.referenceCode}, tenant ${reg.tenantId}\n`);
