/**
 * Verify the worker-side audit gap is CLOSED: a real escalation fired via the
 * shared request substrate, and a real L1/L2/L3 alert fired via Breach, both
 * land in the S5 hash chain — attributed to the right actor label — and
 * "Verify chain" still reports the chain intact afterward, with the new
 * entries counted.
 *
 *   pnpm audit:gap:demo
 *
 * Needs the API AND the worker running (the API schedules deadlines; only the
 * worker fires them, and only the worker exercises SystemAuditService).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

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

async function api(method, path, { body, token, expect } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (expect !== undefined) {
    if (res.status !== expect) {
      throw new Error(`${method} ${path} -> expected ${expect}, got ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
  }
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

try { await fetch(`${BASE}/health`); } catch {
  console.error(`\nNothing on ${BASE}. Start:  pnpm dev:api  and  pnpm --filter @dpdp/api dev:worker\n`);
  process.exit(1);
}

const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';

console.log(`\nWorker-side audit gap — closing verification`);
console.log(`Driving ${BASE}`);

// =============================================================================
step(1, 'Tenant, escalation ladder, and a BASELINE "verify chain" + entry count');
// =============================================================================
const reg = await api('POST', '/auth/register', {
  body: { organisationName: `Gap Close Co ${sfx}`, ownerEmail: `dpo-${sfx}@gapclose.example`, ownerName: 'Rhea Kapoor', password: PASSWORD },
});
const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
const secret = base32Decode(enrol.secret);
const confirmed = await api('POST', '/auth/mfa/confirm', { body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) } });
const staff = confirmed.accessToken;
const me = await api('GET', '/auth/me', { token: staff });
const slug = me.portalSlug;
ok(`tenant ${reg.tenantId}`);

for (const d of ['grievance_officer', 'dpo', 'escalation_contact']) {
  await api('POST', '/users/designations', { token: staff, body: { designation: d, userId: me.userId, reason: 'Gap-close demo: escalation ladder' } });
}
ok('escalation ladder named (all three rungs -> the owner, for the demo)');

const baseline = await api('GET', '/audit/verify', { token: staff });
if (!baseline.intact) bad(`chain is not intact BEFORE we've done anything: ${JSON.stringify(baseline.breaks)}`);
else ok(`baseline: chain intact, ${baseline.entriesChecked} entries, head ${baseline.headHash?.slice(0, 16)}…`);
const baselineCount = baseline.entriesChecked;

// =============================================================================
step(2, 'REQUEST SUBSTRATE: fire a real SLA escalation via the shared ladder (FR-GRV-05)');
// =============================================================================
// A 60-second SLA (the platform floor) with a full three-rung ladder, so all
// three levels play out inside this run through the REAL WorkflowRunner.
await api('PUT', '/requests/sla-policies', {
  token: staff,
  body: {
    requestType: 'grievance',
    slaSeconds: 60,
    ladder: [
      { level: 1, atPercent: 40, rung: 'grievance_officer' },
      { level: 2, atPercent: 70, rung: 'dpo' },
      { level: 3, atPercent: 100, rung: 'escalation_contact' },
    ],
  },
});
ok('grievance SLA set to 60s with a 3-rung ladder (through the real versioned-policy API)');

const submitted = await api('POST', `/portal/${slug}/grievances`, {
  body: {
    category: 'no_response_to_rights_request',
    subject: 'Testing the worker-fired escalation audit trail',
    body: 'This complaint exists only to make a real SLA deadline fire through the real worker.',
    contactChannel: 'email',
    contactValue: `principal-${sfx}@personal.example`,
  },
  expect: 201,
});
const verified = await api('POST', `/portal/${slug}/requests/${submitted.ticketId}/otp/verify`, { body: { code: submitted.devOtp } });
ok(`${submitted.referenceCode} filed and verified, SLA due ${verified.slaDueAt}`);

info('  waiting ~70s for the worker to fire the whole ladder...');
await new Promise((r) => setTimeout(r, 70_000));

const ticketDetail = await api('GET', `/requests/${submitted.ticketId}`, { token: staff });
if (ticketDetail.escalations.length === 0) {
  bad('no escalations recorded on the ticket at all — is the worker running?');
} else {
  ok(`${ticketDetail.escalations.length} escalation(s) recorded on the ticket's own domain trail`);
}

// =============================================================================
step(3, 'BREACH REGISTER: fire a real L1/L2/L3 alert (FR-BRC-04)');
// =============================================================================
const entry = await api('POST', '/inventory/register', {
  token: staff, body: { category: 'Contact details', description: 'For the gap-close demo.', storageLocation: 'core.customers' }, expect: 201,
});
await api('POST', `/inventory/register/${entry.id}/purposes`, {
  token: staff, body: { purposeName: 'Testing', legalBasis: 'legitimate_use', retentionPeriod: '1 year' }, expect: 201,
});

await api('POST', '/breach/deadline-policies/acknowledge', {
  token: staff,
  body: {
    slaSeconds: 60,
    ladder: [
      { level: 1, atPercent: 40, rung: 'grievance_officer' },
      { level: 2, atPercent: 70, rung: 'dpo' },
      { level: 3, atPercent: 100, rung: 'escalation_contact' },
    ],
    note: 'Gap-close demo: shortened to 60s so the whole ladder fires in one run.',
  },
  expect: 201,
});
ok('acknowledge policy superseded to 60s with a 3-rung ladder');

const incident = await api('POST', '/breach/incidents', {
  token: staff,
  body: {
    title: 'Gap-close demo incident',
    whatHappened: 'A synthetic incident opened only to make a real acknowledge deadline fire through the real worker.',
    discoveredAt: new Date().toISOString(),
    systemsAffected: ['demo-system'],
    dataCategoryEntryIds: [entry.id],
    estimatedAffectedCount: 1,
    severity: 'low',
  },
  expect: 201,
});
ok(`incident ${incident.referenceCode} opened`);

info('  waiting ~70s for the worker to fire the acknowledge ladder...');
await new Promise((r) => setTimeout(r, 70_000));

const incidentDetail = await api('GET', `/breach/incidents/${incident.id}`, { token: staff });
if (incidentDetail.escalations.length === 0) {
  bad('no escalations recorded on the incident at all — is the worker running?');
} else {
  ok(`${incidentDetail.escalations.length} escalation(s) recorded on the incident's own domain trail`);
}

// =============================================================================
step(4, 'THE ACTUAL CLAIM: both fired escalations are now IN THE S5 HASH CHAIN');
// =============================================================================
const { entries } = await api('GET', '/audit?limit=200', { token: staff });

const requestEntries = entries.filter((e) => e.action === 'request.escalation.fired');
const breachEntries = entries.filter((e) => e.action === 'breach.escalation.fired');

if (requestEntries.length !== ticketDetail.escalations.length) {
  bad(`ticket has ${ticketDetail.escalations.length} escalation(s) but the chain has ${requestEntries.length} 'request.escalation.fired' entries`);
} else {
  ok(`chain has exactly ${requestEntries.length} 'request.escalation.fired' entries, matching the ticket's own trail`);
}
if (breachEntries.length !== incidentDetail.escalations.length) {
  bad(`incident has ${incidentDetail.escalations.length} escalation(s) but the chain has ${breachEntries.length} 'breach.escalation.fired' entries`);
} else {
  ok(`chain has exactly ${breachEntries.length} 'breach.escalation.fired' entries, matching the incident's own trail`);
}

// Actor labels — the whole point of the system:worker:<x> convention.
const wrongRequestLabel = requestEntries.filter((e) => e.actorLabel !== 'system:worker:escalation');
const wrongBreachLabel = breachEntries.filter((e) => e.actorLabel !== 'system:worker:breach_deadline');
if (wrongRequestLabel.length > 0) bad(`some request.escalation.fired entries have the wrong actorLabel: ${JSON.stringify(wrongRequestLabel.map((e) => e.actorLabel))}`);
else ok(`every 'request.escalation.fired' entry is attributed to actorLabel "system:worker:escalation"`);
if (wrongBreachLabel.length > 0) bad(`some breach.escalation.fired entries have the wrong actorLabel: ${JSON.stringify(wrongBreachLabel.map((e) => e.actorLabel))}`);
else ok(`every 'breach.escalation.fired' entry is attributed to actorLabel "system:worker:breach_deadline"`);

// No actor_id: there is no user row to point at for a worker firing — same
// discipline as a failed login or the anonymous portal actor.
const hasActorId = [...requestEntries, ...breachEntries].filter((e) => e.actorId !== null);
if (hasActorId.length > 0) bad(`${hasActorId.length} worker-fired entries have a non-null actorId`);
else ok('none of the worker-fired entries claims a human actor_id — actorLabel only, as designed');

// targetId/reason/afterState are populated, not placeholders.
const req0 = requestEntries[0];
if (!req0?.targetId || !req0.reason || !req0.afterState?.rung) {
  bad(`a request.escalation.fired entry is missing target/reason/afterState: ${JSON.stringify(req0)}`);
} else {
  ok(`sample entry: target=${req0.targetType}/${req0.targetId.slice(0, 8)}… rung=${req0.afterState.rung} trigger=${req0.afterState.trigger}`);
}
const brc0 = breachEntries[0];
if (!brc0?.targetId || !brc0.reason || !brc0.afterState?.rung) {
  bad(`a breach.escalation.fired entry is missing target/reason/afterState: ${JSON.stringify(brc0)}`);
} else {
  ok(`sample entry: target=${brc0.targetType}/${brc0.targetId.slice(0, 8)}… rung=${brc0.afterState.rung} trigger=${brc0.afterState.trigger}`);
}

// =============================================================================
step(5, 'NO DOUBLE-AUDIT on the MANUAL escalation path');
// =============================================================================
// File a second grievance and escalate it manually (trigger='manual') — this
// must be audited exactly ONCE, by the ordinary HTTP interceptor, not twice.
const manualTicket = await api('POST', `/portal/${slug}/grievances`, {
  body: {
    category: 'other',
    subject: 'Testing that manual escalation is not double-audited',
    body: 'This complaint exists only to exercise the manual escalate-now path once.',
    contactChannel: 'email',
    contactValue: `manual-${sfx}@personal.example`,
  },
  expect: 201,
});
await api('POST', `/portal/${slug}/requests/${manualTicket.ticketId}/otp/verify`, { body: { code: manualTicket.devOtp } });
const tasks = await api('GET', '/requests/identity-verifications?status=pending', { token: staff });
const task = tasks.tasks.find((t) => t.ticketId === manualTicket.ticketId);
await api('POST', `/requests/${manualTicket.ticketId}/identity-verification`, {
  token: staff, body: { outcome: 'matched', reason: 'Verified for the manual-escalation test.' },
});
await api('POST', `/requests/${manualTicket.ticketId}/escalate`, { token: staff, body: { reason: 'Manual escalation test — must be audited exactly once.' } });

const { entries: afterManual } = await api('GET', '/audit?limit=200', { token: staff });
const manualRelated = afterManual.filter((e) => e.targetId === manualTicket.ticketId);
const escalationRelated = manualRelated.filter((e) => e.action === 'request.escalation.fired' || e.action.includes('escalat'));
info(`  actions recorded against the manually-escalated ticket: ${manualRelated.map((e) => e.action).join(', ')}`);
const fired = manualRelated.filter((e) => e.action === 'request.escalation.fired');
if (fired.length > 0) {
  bad(`manual escalation ALSO produced a 'request.escalation.fired' SystemAuditService entry (${fired.length}) — it should be audited only via the HTTP interceptor`);
} else {
  ok(`manual escalation produced NO 'request.escalation.fired' entry — SystemAuditService correctly skipped it (trigger==='manual')`);
}
const httpAudited = manualRelated.some((e) => e.action.includes('escalat'));
if (!httpAudited) bad('manual escalation left no audit trail at all via the ordinary HTTP path either');
else ok('the manual escalation IS in the chain, via the ordinary interceptor path — audited once, not twice');

// =============================================================================
step(6, '"Verify chain" still reports the chain INTACT, with the new entries counted');
// =============================================================================
const after = await api('GET', '/audit/verify', { token: staff });
if (!after.intact) {
  bad(`chain is NOT intact after worker-fired entries: ${JSON.stringify(after.breaks)}`);
} else {
  ok(`chain is still INTACT: ${after.entriesChecked} entries (was ${baselineCount}), head ${after.headHash?.slice(0, 16)}…`);
}
const grew = after.entriesChecked - baselineCount;
const expectedGrowthAtLeast = requestEntries.length + breachEntries.length;
if (grew < expectedGrowthAtLeast) {
  bad(`chain grew by only ${grew} entries, expected at least ${expectedGrowthAtLeast} (the worker-fired ones alone)`);
} else {
  ok(`chain grew by ${grew} entries since baseline — the worker-fired escalations are counted in verifyChain's own walk, not merely present in the table`);
}
if (after.headHash === baseline.headHash) {
  bad('head hash did not change at all — the worker-fired entries may not have actually landed on the real chain');
} else {
  ok('head hash changed from baseline — the chain trigger genuinely extended the real chain, not a side table');
}

console.log(
  process.exitCode
    ? '\n✗ Some checks failed.\n'
    : '\n✓ The worker-side audit gap is closed: both escalation paths are hash-chained, correctly attributed, not double-audited, and the chain verifies intact.\n',
);
