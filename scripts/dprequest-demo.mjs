/**
 * Drive the DATA PRINCIPAL REQUEST TRACKER end to end, against the real API and
 * the real database.
 *
 *   pnpm dpr:demo
 *
 * Proves the three things Prompt 27 is actually about:
 *
 *   FR-DPR-01  all six rights types file through the SHARED substrate — the same
 *              portal, the same OTP, the same handoff, the same ticket table.
 *   FR-DPR-03  each one's deadline comes from a VERSIONED CONFIGURATION RECORD,
 *              per rights type, and superseding a record moves new requests
 *              without moving open ones.
 *   FR-DPR-02  a subject reference resolves to the SAME HMAC the Consent module
 *              already stored for that customer — and the raw customer id is
 *              nowhere in the database afterwards (I2).
 *
 * Needs the API running and NOTIFY_DEV_ECHO_OTP=true so the OTP round trip can
 * complete without an inbox. The worker is not required: nothing here waits for
 * a deadline to fire (the substrate demo already proves that path).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

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
  console.error(`\nNothing is answering on ${BASE}. Start it:  pnpm dev:api\n`);
  process.exit(1);
}

const step = (n, s) => console.log(`\n${'-'.repeat(74)}\n${n}. ${s}\n${'-'.repeat(74)}`);
const ok = (s) => console.log(`   ✓ ${s}`);
const bad = (s) => {
  console.error(`   ✗ ${s}`);
  process.exitCode = 1;
};
const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';

console.log(`\nData Principal Request Tracker — FR-DPR-01/02/03/06`);
console.log(`Driving ${BASE}`);

// ===========================================================================
step(1, 'Provision a tenant and log in as staff');
// ===========================================================================
const reg = await api('POST', '/auth/register', {
  body: {
    organisationName: `Northwind Bank ${sfx}`,
    ownerEmail: `dpo-${sfx}@northwind.example`,
    ownerName: 'Meera Iyer',
    password: PASSWORD,
  },
});
const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
const secret = base32Decode(enrol.secret);
const confirmed = await api('POST', '/auth/mfa/confirm', {
  body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) },
});
const staff = confirmed.accessToken;
const me = await api('GET', '/auth/me', { token: staff });
const slug = me.portalSlug;
ok(`tenant ${reg.tenantId}, portal /portal/${slug}`);

for (const designation of ['grievance_officer', 'dpo', 'escalation_contact']) {
  await api('POST', '/users/designations', {
    token: staff,
    body: { designation, userId: me.userId, reason: 'Demo: naming the escalation ladder' },
  });
}
ok('escalation ladder named (all three rungs -> the owner, for demo purposes)');

// ===========================================================================
step(2, 'FR-DPR-03: statutory deadlines are VERSIONED RECORDS, one per right');
// ===========================================================================
const { policies } = await api('GET', '/dprequest/deadline-policies', { token: staff });
for (const p of policies) {
  console.log(
    `   • ${p.rightType.padEnd(17)} v${p.version}  ${String(p.slaDays).padStart(4)} days  ` +
      `key=${p.policyKey}`,
  );
  if (p.isFallback) bad(`${p.rightType} has no policy record in force`);
}
const expectedDays = {
  access: 30,
  correction: 30,
  erasure: 30,
  nomination: 30,
  portability: 30,
  withdraw_consent: 7,
};
for (const p of policies) {
  if (p.slaDays !== expectedDays[p.rightType]) {
    bad(`${p.rightType} expected ${expectedDays[p.rightType]}d, record says ${p.slaDays}d`);
  }
}
ok('every rights type resolves to a v1 record — no deadline comes from code');
ok('withdraw_consent is 7 days, not 30: the record differs per right, not per module');

// ===========================================================================
step(3, 'FR-DPR-01: file one request of EACH of the six types through the portal');
// ===========================================================================
const DAY = 86400;
const filed = [];
for (const rightType of Object.keys(expectedDays)) {
  const contact = `principal-${rightType}-${sfx}@personal.example`;
  const submitted = await api('POST', `/portal/${slug}/data-requests`, {
    body: {
      rightType,
      subject: `Request to exercise my right of ${rightType.replace(/_/g, ' ')}`,
      body:
        `I am exercising my right under the DPDP Act. Please treat this as a formal ` +
        `${rightType.replace(/_/g, ' ')} request and confirm what you hold about me.`,
      contactChannel: 'email',
      contactValue: contact,
    },
    expect: 201,
  });
  if (!submitted.devOtp) {
    console.error('\n   ✗ No devOtp. Set NOTIFY_DEV_ECHO_OTP=true in .env and restart the API.\n');
    process.exit(1);
  }
  const verified = await api('POST', `/portal/${slug}/requests/${submitted.ticketId}/otp/verify`, {
    body: { code: submitted.devOtp },
  });

  // The whole point: the deadline the clock landed on must be the one the
  // VERSIONED RECORD for this rights type says, not a generic 30 days.
  const expectedSeconds = expectedDays[rightType] * DAY;
  const actualSeconds = Math.round((new Date(verified.slaDueAt) - Date.now()) / 1000);
  const drift = Math.abs(actualSeconds - expectedSeconds);
  const line =
    `${submitted.referenceCode}  ${rightType.padEnd(17)} due ${verified.slaDueAt.slice(0, 10)} ` +
    `(${Math.round(actualSeconds / DAY)}d)`;
  if (drift > 120) {
    bad(`${line} — expected ${expectedDays[rightType]}d from the v1 record`);
  } else {
    ok(line);
  }
  filed.push({ rightType, ...submitted, slaDueAt: verified.slaDueAt });
}

// ===========================================================================
step(4, 'The tickets are on the SHARED substrate, not a parallel system');
// ===========================================================================
const generic = await api('GET', '/requests?requestType=dprequest&limit=50', { token: staff });
ok(`GET /requests?requestType=dprequest returns ${generic.requests.length} of them`);
const tasks = await api('GET', '/requests/identity-verifications?status=pending', { token: staff });
const mine = tasks.tasks.filter((t) => filed.some((f) => f.ticketId === t.ticketId));
if (mine.length !== 6) bad(`expected 6 identity-verification tasks, saw ${mine.length}`);
else ok('all six opened an FR-GRV-04 identity-verification task — the same handoff Grievance uses');

const queue = await api('GET', '/dprequest/tickets?limit=50', { token: staff });
if (queue.tickets.length !== 6) bad(`DPR queue shows ${queue.tickets.length}, expected 6`);
else ok(`GET /dprequest/tickets shows all six with their rightType and deadline clock`);
const erasureOnly = await api('GET', '/dprequest/tickets?rightType=erasure', { token: staff });
ok(`filtering by rightType=erasure narrows to ${erasureOnly.tickets.length}`);

// ===========================================================================
step(5, 'FR-DPR-02 + I2: resolve a subject reference against the consent register');
// ===========================================================================
// A real customer id, and a consent event recorded under it FIRST — so the
// resolution has something true to match, and we can prove the two derivations
// agree rather than asserting it.
const CUSTOMER_ID = `NW-CUST-${randomBytes(4).toString('hex').toUpperCase()}`;

// What the CONSENT module derives for this id — the value it would store on
// every consent event for this person (FR-CON-04). The DPR resolution below
// must produce this exact string, or the two modules are pseudonymising the
// same person differently and a rights request could never be matched to a
// consent history.
const consentRef = await api('POST', '/consent/subject-ref', {
  token: staff,
  body: { customerId: CUSTOMER_ID },
});
ok(`Consent derives ${consentRef.subjectRef.slice(0, 16)}… for ${CUSTOMER_ID}`);

const target = filed.find((f) => f.rightType === 'access');
const resolved = await api('POST', `/dprequest/tickets/${target.ticketId}/subject-reference`, {
  token: staff,
  body: {
    customerId: CUSTOMER_ID,
    reason: 'Verified against core banking records during identity verification.',
  },
});
if (resolved.subjectRef !== consentRef.subjectRef) {
  bad('the DPR-resolved ref differs from the one Consent stored — two HMACs, not one');
} else {
  ok('DPR resolved the SAME ref the Consent module stored — one hasher, one secret');
}
ok(`matched ${resolved.matchCount} consent record(s) — zero is a legitimate answer, and recorded as one: a data principal with no consent history still has statutory rights`);

const detail = await api('GET', `/dprequest/tickets/${target.ticketId}`, { token: staff });
ok(`ticket detail carries rightType=${detail.dpr.rightType}, subjectRef stored, resolved at ${detail.dpr.subjectRefResolvedAt}`);

await api('POST', `/dprequest/tickets/${target.ticketId}/subject-reference`, {
  token: staff,
  body: { customerId: 'SOMEONE-ELSE', reason: 'Attempting to re-point this request at another person.' },
  expect: 400,
});
ok('a second resolution is refused — a request cannot be silently re-pointed');

// ===========================================================================
step(6, 'I2, checked against the DATABASE, not against the API response');
// ===========================================================================
// The only claim worth making about a pseudonymisation scheme is one made by
// grepping the storage.
//
// A TRAP WORTH THE COMMENT. The obvious way to write this — connect as the
// owner and sweep — is WRONG, and wrong in the direction that produces a
// reassuring green tick. app.apply_tenant_rls() FORCEs row-level security, so
// the policy applies to the table owner too; a sweep with no tenant GUC set
// sees zero rows in every tenant-scoped table and reports "the raw id appears
// nowhere" without having looked at anything. Setting the GUC to the tenant we
// just created is what makes the sweep able to FAIL.
const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(`SELECT set_config('app.current_tenant', $1, false)`, [reg.tenantId]);

// Proof the GUC took, before trusting a negative result from anything below.
const { rows: visible } = await client.query(
  `SELECT count(*)::int AS n FROM request_tickets WHERE request_type = 'dprequest'`,
);
if (visible[0].n < 6) {
  bad(`RLS is still hiding rows (${visible[0].n} tickets visible) — the sweep below would be a false negative`);
} else {
  ok(`tenant context set: ${visible[0].n} dprequest tickets visible to the sweep`);
}
const { rows: cols } = await client.query(
  `SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text','character varying','jsonb')
      AND table_name NOT LIKE 'pgboss%'`,
);
let hits = 0;
for (const c of cols) {
  const cast = `"${c.column_name}"::text`;
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM "${c.table_name}" WHERE ${cast} LIKE $1`,
    [`%${CUSTOMER_ID}%`],
  );
  if (rows[0].n > 0) {
    hits += rows[0].n;
    bad(`raw customer id found in ${c.table_name}.${c.column_name} (${rows[0].n} row(s))`);
  }
}
if (hits === 0) {
  ok(`swept every text/jsonb column in the database: the raw id "${CUSTOMER_ID}" appears NOWHERE`);
  ok('what is stored is the HMAC digest, which cannot be reversed to it (I2)');
}

const { rows: stored } = await client.query(
  `SELECT subject_ref, subject_ref_match_count FROM dprequest_details WHERE ticket_id = $1`,
  [target.ticketId],
);
ok(`dprequest_details holds subject_ref=${stored[0].subject_ref.slice(0, 16)}… (64 hex, one-way)`);

// ===========================================================================
step(7, 'Superseding a deadline: new requests move, open ones do not (I4)');
// ===========================================================================
const before = filed.find((f) => f.rightType === 'nomination');
const superseded = await api('POST', '/dprequest/deadline-policies/nomination', {
  token: staff,
  body: {
    slaSeconds: 10 * DAY,
    ladder: [
      { level: 1, atPercent: 50, rung: 'grievance_officer' },
      { level: 2, atPercent: 80, rung: 'dpo' },
      { level: 3, atPercent: 100, rung: 'escalation_contact' },
    ],
    note: 'Counsel revised the nomination timeline to 10 days following the draft Rules.',
  },
  expect: 201,
});
ok(`nomination policy is now v${superseded.version} at ${superseded.slaSeconds / DAY} days`);

const stillOpen = await api('GET', `/dprequest/tickets/${before.ticketId}`, { token: staff });
if (stillOpen.ticket.slaDueAt !== before.slaDueAt) {
  bad('an already-open request was re-dated by a policy change — the snapshot is not holding');
} else {
  ok('the request filed under v1 keeps its v1 deadline — yesterday is not re-judged');
}

const fresh = await api('POST', `/portal/${slug}/data-requests`, {
  body: {
    rightType: 'nomination',
    subject: 'Nominate my spouse to act on my behalf',
    body: 'Please record my spouse as my nominee under section 14 of the DPDP Act.',
    contactChannel: 'email',
    contactValue: `nominee-v2-${sfx}@personal.example`,
  },
  expect: 201,
});
const freshVerified = await api('POST', `/portal/${slug}/requests/${fresh.ticketId}/otp/verify`, {
  body: { code: fresh.devOtp },
});
const freshDays = Math.round((new Date(freshVerified.slaDueAt) - Date.now()) / 1000 / DAY);
if (freshDays !== 10) bad(`a request filed after v2 got ${freshDays} days, expected 10`);
else ok('a request filed after v2 gets 10 days — the record, not the code, decides');

const { rows: cited } = await client.query(
  `SELECT reference_code, sla_policy_key, sla_policy_version
     FROM request_tickets WHERE id = ANY($1::uuid[]) ORDER BY sla_policy_version`,
  [[before.ticketId, fresh.ticketId]],
);
for (const r of cited) {
  ok(`${r.reference_code} cites ${r.sla_policy_key} v${r.sla_policy_version}`);
}

// ===========================================================================
step(8, 'Grievance is untouched: the substrate still serves both');
// ===========================================================================
const grv = await api('POST', `/portal/${slug}/grievances`, {
  body: {
    category: 'no_response_to_rights_request',
    subject: 'You never answered my access request',
    body: 'I filed an access request over a month ago and have had no response at all.',
    contactChannel: 'email',
    contactValue: `complainant-${sfx}@personal.example`,
  },
  expect: 201,
});
const grvVerified = await api('POST', `/portal/${slug}/requests/${grv.ticketId}/otp/verify`, {
  body: { code: grv.devOtp },
});
const grvDays = Math.round((new Date(grvVerified.slaDueAt) - Date.now()) / 1000 / DAY);
if (grvDays !== 30) bad(`grievance SLA is ${grvDays}d — the platform default should still be 30`);
else ok('a grievance still gets its own 30-day default through the unversioned fallback path');

await client.end();
console.log(
  process.exitCode ? '\n✗ Something above failed — see the ✗ lines.\n' : '\n✓ All checks passed.\n',
);
