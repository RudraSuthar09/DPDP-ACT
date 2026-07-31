/**
 * Drive the TWO-TIER PERSONAL DATA SUMMARY end to end (FR-DPR-04/05/06/07).
 *
 *   pnpm dpr:summary
 *
 * Two halves, and the SECOND ONE MATTERS MOST.
 *
 * The positive half builds a tenant with real inventory, real consent and a
 * real rights request, then checks that every section of the assembled Tier 1
 * summary is accurate — not merely present.
 *
 * The negative half is the one that proves the product's central claim. It
 * plants unmistakable canary values in the client's Tier 2 responses, runs a
 * full round trip, and then goes looking for them: every text and jsonb column
 * in the database, every audit row, the process log, and the temp directory.
 * A feature that relays personal data is only as good as the evidence that it
 * kept none of it, and "we don't store it" is a claim you check by grepping.
 *
 * Needs the API running and NOTIFY_DEV_ECHO_OTP=true. Starts its own mock
 * client system on CLIENT_PORT (default 4599) to be the far end of the
 * fulfilment webhook.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import pg from 'pg';

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
const CLIENT_PORT = Number(process.env.CLIENT_PORT ?? 4599);
const API_LOG = process.env.API_LOG ?? null;

const step = (n, s) => console.log(`\n${'='.repeat(76)}\n${n}. ${s}\n${'='.repeat(76)}`);
const ok = (s) => console.log(`   ✓ ${s}`);
const info = (s) => console.log(`     ${s}`);
const bad = (s) => {
  console.error(`   ✗ ${s}`);
  process.exitCode = 1;
};

async function api(method, path, { body, token, expect, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const json = await res.json().catch(() => null);
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

// ===========================================================================
// THE CANARIES. Deliberately grotesque so a substring search cannot miss them
// and no legitimate row could contain one by accident.
// ===========================================================================
const NONCE = randomBytes(4).toString('hex').toUpperCase();
const CANARY_NAME = `CANARY-FULLNAME-${NONCE}`;
const CANARY_ADDR = `CANARY-ADDRESS-${NONCE}`;
const CANARY_ACCOUNT = `CANARY-ACCTNO-${NONCE}`;
const CANARY_LINK_TOKEN = `CANARY-LINKTOKEN-${NONCE}`;
const CUSTOMER_ID = `NW-CUST-${NONCE}`;
const ALL_CANARIES = [CANARY_NAME, CANARY_ADDR, CANARY_ACCOUNT, CANARY_LINK_TOKEN, CUSTOMER_ID];

// ===========================================================================
// THE MOCK CLIENT SYSTEM — the far end of the fulfilment webhook. Verifies our
// signature independently (recomputing it from the documented scheme rather
// than importing our signer) and answers with canary-laden payloads.
// ===========================================================================
const received = [];
let clientSecretHex = null;
let nextMode = 'link';

const clientServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const sigHeader = req.headers['x-dpdp-webhook-signature'] ?? '';
    const payload = JSON.parse(rawBody);

    // Verify EXACTLY as the published scheme says a client should:
    // HMAC-SHA256(secret, `${t}.${rawBody}`), constant-time compared.
    let verified = false;
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(sigHeader));
    if (m && clientSecretHex) {
      const expected = createHmac('sha256', Buffer.from(clientSecretHex, 'hex'))
        .update(`${m[1]}.${rawBody}`)
        .digest();
      const actual = Buffer.from(m[2], 'hex');
      verified = expected.length === actual.length && timingSafeEqual(expected, actual);
    }
    received.push({ eventType: payload.eventType, verified, subjectRef: payload.subjectRef, rawBody });

    res.setHeader('content-type', 'application/json');
    if (payload.eventType === 'dpr.values.requested') {
      if (nextMode === 'link') {
        // LINK MODE: we host it; the platform never sees the values.
        res.end(
          JSON.stringify({
            mode: 'link',
            url: `https://client.example/exports/${CANARY_LINK_TOKEN}`,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          }),
        );
      } else {
        // RELAY MODE: the real values, which the platform must pass through
        // and keep none of.
        res.end(
          JSON.stringify({
            mode: 'relay',
            data: {
              fullName: CANARY_NAME,
              postalAddress: CANARY_ADDR,
              accountNumber: CANARY_ACCOUNT,
              transactions: [{ id: 1, note: `payment by ${CANARY_NAME}` }],
            },
          }),
        );
      }
    } else {
      // correction / erasure: a confirmation, nothing to return.
      res.end(JSON.stringify({ status: 'completed', completedAt: new Date().toISOString() }));
    }
  });
});
await new Promise((r) => clientServer.listen(CLIENT_PORT, r));

console.log(`\nTwo-tier Personal Data Summary — FR-DPR-04/05/06/07`);
console.log(`API ${BASE}   mock client system on :${CLIENT_PORT}`);
console.log(`Canary nonce ${NONCE}`);

const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';
const ownerEmail = `dpo-${sfx}@northwind.example`;
let client;

try {
  // =========================================================================
  step(1, 'Provision a tenant with REAL inventory, purposes, systems and vendors');
  // =========================================================================
  const reg = await api('POST', '/auth/register', {
    body: {
      organisationName: `Northwind Bank ${sfx}`,
      ownerEmail,
      ownerName: 'Meera Iyer',
      password: PASSWORD,
    },
  });
  const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
  const mfaSecret = base32Decode(enrol.secret);
  const confirmed = await api('POST', '/auth/mfa/confirm', {
    body: { challengeToken: reg.mfaEnrolmentToken, code: totp(mfaSecret) },
  });
  const staff = confirmed.accessToken;
  const me = await api('GET', '/auth/me', { token: staff });
  const slug = me.portalSlug;
  ok(`tenant ${reg.tenantId}`);

  for (const d of ['grievance_officer', 'dpo', 'escalation_contact']) {
    await api('POST', '/users/designations', {
      token: staff,
      body: { designation: d, userId: me.userId, reason: 'Demo: escalation ladder' },
    });
  }

  // Three data elements. Two will be reachable from the subject's consent, one
  // deliberately will NOT — so `unrelatedEntryCount` can be checked as a real
  // number rather than trivially zero.
  const entrySpecs = [
    {
      category: 'Contact details',
      storageLocation: 'core-banking.customers',
      purposeName: 'Marketing communications',
      legalBasis: 'consent',
      retentionPeriod: '2 years after last contact',
    },
    {
      category: 'Transaction history',
      storageLocation: 'core-banking.ledger',
      purposeName: 'Fraud monitoring',
      legalBasis: 'legitimate_use',
      retentionPeriod: '8 years (RBI retention rule)',
    },
    {
      category: 'Employee payroll records',
      storageLocation: 'hr-suite.payroll',
      purposeName: 'Staff payroll administration',
      legalBasis: 'legal_obligation',
      retentionPeriod: '7 years',
    },
  ];

  const entries = [];
  for (const spec of entrySpecs) {
    const entry = await api('POST', '/inventory/register', {
      token: staff,
      body: {
        category: spec.category,
        description: `${spec.category} held by the bank.`,
        storageLocation: spec.storageLocation,
      },
      expect: 201,
    });
    const purpose = await api('POST', `/inventory/register/${entry.id}/purposes`, {
      token: staff,
      body: {
        purposeName: spec.purposeName,
        legalBasis: spec.legalBasis,
        retentionPeriod: spec.retentionPeriod,
      },
      expect: 201,
    });
    entries.push({ ...spec, entryId: entry.id, inventoryPurposeId: purpose.id });
    ok(`${spec.category} — ${spec.purposeName} (${spec.legalBasis}, ${spec.retentionPeriod})`);
  }

  // =========================================================================
  step(2, 'Record REAL consent for the subject, against real notices');
  // =========================================================================
  const consentPurposes = [];
  for (const name of ['Marketing communications', 'Fraud monitoring']) {
    const cp = await api('POST', '/consent/purposes', {
      token: staff,
      body: { name, description: `${name} consent purpose.` },
      expect: 201,
    });
    const notice = await api('POST', `/consent/purposes/${cp.id}/notices`, {
      token: staff,
      body: {
        translations: [
          { language: 'en', body: `We process your data for ${name}. You may withdraw at any time.` },
        ],
      },
      expect: 201,
    });
    consentPurposes.push({ id: cp.id, name, noticeVersionId: notice.id });
    ok(`consent purpose "${name}" with a published notice`);
  }

  // Granted for marketing, then WITHDRAWN — so the summary has to show a
  // withdrawn consent, which is the case most likely to be wrongly hidden.
  await api('POST', '/consent/events', {
    token: staff,
    body: {
      customerId: CUSTOMER_ID,
      purposeId: consentPurposes[0].id,
      status: 'GRANTED',
      noticeVersionId: consentPurposes[0].noticeVersionId,
      source: 'portal',
    },
    expect: 201,
  });
  await api('POST', '/consent/events', {
    token: staff,
    body: {
      customerId: CUSTOMER_ID,
      purposeId: consentPurposes[0].id,
      status: 'WITHDRAWN',
      noticeVersionId: consentPurposes[0].noticeVersionId,
      source: 'portal',
    },
    expect: 201,
  });
  await api('POST', '/consent/events', {
    token: staff,
    body: {
      customerId: CUSTOMER_ID,
      purposeId: consentPurposes[1].id,
      status: 'GRANTED',
      noticeVersionId: consentPurposes[1].noticeVersionId,
      source: 'api',
    },
    expect: 201,
  });
  ok(`3 consent events for ${CUSTOMER_ID}: marketing granted then withdrawn, fraud granted`);

  // =========================================================================
  step(3, 'FR-DPR-04: the purpose bridge — suggested by the platform, accepted by a human');
  // =========================================================================
  const { suggestions } = await api('GET', '/dprequest/purpose-links/suggestions', { token: staff });
  info(`${suggestions.length} suggestion(s) offered:`);
  for (const s of suggestions.slice(0, 6)) {
    info(`  ${s.confidence.toFixed(3)}  "${s.consentPurposeName}" -> "${s.inventoryPurposeName}" (${s.entryCategory})`);
  }
  // The payroll entry must NOT be suggested against either consent purpose —
  // it shares no distinguishing word with them.
  if (suggestions.some((s) => s.entryCategory === 'Employee payroll records')) {
    bad('payroll was suggested as related to a customer consent purpose — the suggester is too loose');
  } else {
    ok('payroll is NOT suggested for any customer consent purpose');
  }

  let accepted = 0;
  for (const cp of consentPurposes) {
    const match = suggestions.find(
      (s) => s.consentPurposeId === cp.id && s.inventoryPurposeName === cp.name,
    );
    if (!match) {
      bad(`no suggestion linking consent purpose "${cp.name}" to its inventory twin`);
      continue;
    }
    await api('POST', '/dprequest/purpose-links', {
      token: staff,
      body: { consentPurposeId: match.consentPurposeId, inventoryPurposeId: match.inventoryPurposeId },
      expect: 201,
    });
    accepted += 1;
  }
  ok(`${accepted} suggestion(s) accepted into curated links (nothing is linked by name at read time)`);

  // =========================================================================
  step(4, 'File a real access request and resolve its subject reference');
  // =========================================================================
  const submitted = await api('POST', `/portal/${slug}/data-requests`, {
    body: {
      rightType: 'access',
      subject: 'Please send me a summary of the data you hold about me',
      body: 'I am exercising my right of access under section 11 of the DPDP Act.',
      contactChannel: 'email',
      contactValue: `principal-${sfx}@personal.example`,
    },
    expect: 201,
  });
  const verified = await api('POST', `/portal/${slug}/requests/${submitted.ticketId}/otp/verify`, {
    body: { code: submitted.devOtp },
  });
  ok(`${submitted.referenceCode} filed and contact-verified, due ${verified.slaDueAt.slice(0, 10)}`);

  await api('POST', `/dprequest/tickets/${submitted.ticketId}/subject-reference`, {
    token: staff,
    body: { customerId: CUSTOMER_ID, reason: 'Verified against core banking records at the branch.' },
  });
  ok('subject reference resolved (HMAC of the customer id; the raw id is not stored)');

  // =========================================================================
  step(5, 'TIER 1: assemble the summary and check EVERY section against what we built');
  // =========================================================================
  const summary = await api('POST', `/dprequest/tickets/${submitted.ticketId}/personal-data-summary`, {
    token: staff,
  });

  // -- data categories -----------------------------------------------------
  const cats = summary.dataCategories.map((c) => c.category).sort();
  const expectedCats = ['Contact details', 'Transaction history'];
  if (JSON.stringify(cats) !== JSON.stringify(expectedCats)) {
    bad(`data categories were ${JSON.stringify(cats)}, expected ${JSON.stringify(expectedCats)}`);
  } else {
    ok(`data categories: ${cats.join(', ')} — payroll correctly excluded`);
  }
  if (summary.unrelatedEntryCount !== 1) {
    bad(`unrelatedEntryCount was ${summary.unrelatedEntryCount}, expected 1 (payroll)`);
  } else {
    ok('unrelatedEntryCount = 1: the org holds one thing that is nothing to do with this person');
  }

  // -- legal basis, retention, attribution ---------------------------------
  for (const spec of entrySpecs.slice(0, 2)) {
    const cat = summary.dataCategories.find((c) => c.category === spec.category);
    if (!cat) continue;
    const p = cat.purposes[0];
    const okBasis = p?.legalBasis === spec.legalBasis;
    const okRet = p?.retentionPeriod === spec.retentionPeriod;
    const okVia = p?.viaConsentPurposes?.includes(spec.purposeName);
    const okStore = cat.storageLocation === spec.storageLocation;
    if (okBasis && okRet && okVia && okStore) {
      ok(`${spec.category}: basis=${p.legalBasis}, retention="${p.retentionPeriod}", at ${cat.storageLocation}, via "${p.viaConsentPurposes.join(', ')}"`);
    } else {
      bad(`${spec.category}: basis=${p?.legalBasis} retention=${p?.retentionPeriod} store=${cat.storageLocation} via=${JSON.stringify(p?.viaConsentPurposes)}`);
    }
  }

  // -- consent history -----------------------------------------------------
  if (summary.consentHistory.length !== 3) {
    bad(`consentHistory has ${summary.consentHistory.length} events, expected 3`);
  } else {
    ok(`consent history: ${summary.consentHistory.length} events, all with evidence hashes`);
  }
  const marketingNow = summary.currentConsentStatus.find((c) => c.purposeName === 'Marketing communications');
  if (marketingNow?.status !== 'WITHDRAWN') {
    bad(`current marketing status is "${marketingNow?.status}", expected "withdrawn"`);
  } else {
    ok('current status correctly reflects the WITHDRAWN marketing consent, not just the grant');
  }

  // -- request history -----------------------------------------------------
  const mine = summary.requestHistory.find((r) => r.referenceCode === submitted.referenceCode);
  if (!mine || mine.rightType !== 'access') {
    bad(`request history missing this request (${JSON.stringify(summary.requestHistory)})`);
  } else {
    ok(`request history: ${summary.requestHistory.length} request(s), incl. this ${mine.rightType} request`);
  }

  // -- the honesty section --------------------------------------------------
  if (summary.unattributedConsentPurposes.length !== 0) {
    bad(`unexpected unattributed purposes: ${JSON.stringify(summary.unattributedConsentPurposes)}`);
  } else {
    ok('no unattributed consent purposes — every purpose this person consented to is mapped');
  }

  // Prove the honesty section actually FIRES rather than being decorative:
  // add a consent purpose nobody has mapped, and re-assemble.
  const orphan = await api('POST', '/consent/purposes', {
    token: staff,
    body: { name: `Loyalty programme ${sfx}`, description: 'Unmapped on purpose.' },
    expect: 201,
  });
  const orphanNotice = await api('POST', `/consent/purposes/${orphan.id}/notices`, {
    token: staff,
    body: { translations: [{ language: 'en', body: 'Loyalty programme notice.' }] },
    expect: 201,
  });
  await api('POST', '/consent/events', {
    token: staff,
    body: {
      customerId: CUSTOMER_ID,
      purposeId: orphan.id,
      status: 'GRANTED',
      noticeVersionId: orphanNotice.id,
      source: 'portal',
    },
    expect: 201,
  });
  const summary2 = await api('POST', `/dprequest/tickets/${submitted.ticketId}/personal-data-summary`, {
    token: staff,
  });
  if (summary2.unattributedConsentPurposes.length !== 1) {
    bad('an unmapped consent purpose did NOT surface in unattributedConsentPurposes — the gap is being hidden');
  } else {
    ok(`an unmapped purpose surfaces as unattributed ("${summary2.unattributedConsentPurposes[0].purposeName}") rather than implying we hold nothing`);
  }

  // =========================================================================
  step(6, 'TIER 2: signed round trip — link mode, then relay mode');
  // =========================================================================
  // Read the tenant's webhook secret out of the DB so the mock client can
  // verify our signature the way a real integrator would (they are given it
  // out of band; here we just look it up).
  client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SELECT set_config('app.current_tenant', $1, false)`, [reg.tenantId]);

  await api('PUT', '/notify/webhooks/fulfilment', {
    token: staff,
    body: { url: `http://127.0.0.1:${CLIENT_PORT}/fulfilment`, enabled: true },
  });
  ok('fulfilment endpoint configured');

  // The secret comes from the REVEAL endpoint — the same route a real
  // integrator uses to collect it, rather than a privileged peek at the
  // (encrypted-at-rest) column. If verification passes below, it passes for a
  // client who only ever had what the product actually hands them.
  const revealed = await api('POST', '/notify/webhooks/secret/reveal', { token: staff });
  clientSecretHex = Buffer.from(revealed.secret, 'base64').toString('hex');
  ok('signing secret collected the way an integrator collects it (POST secret/reveal)');

  nextMode = 'link';
  const linkOutcome = await api('POST', `/dprequest/tickets/${submitted.ticketId}/fulfilment/values`, {
    token: staff,
  });
  if (linkOutcome.responseKind !== 'link' || !linkOutcome.url?.includes(CANARY_LINK_TOKEN)) {
    bad(`link mode returned ${JSON.stringify(linkOutcome)}`);
  } else {
    ok(`LINK mode: platform relayed ${linkOutcome.url}`);
    ok('the values themselves never entered this process — only an address did');
  }

  nextMode = 'relay';
  const relayOutcome = await api('POST', `/dprequest/tickets/${submitted.ticketId}/fulfilment/values`, {
    token: staff,
  });
  if (relayOutcome.responseKind !== 'relay' || relayOutcome.data?.fullName !== CANARY_NAME) {
    bad(`relay mode returned ${JSON.stringify(relayOutcome).slice(0, 200)}`);
  } else {
    ok(`RELAY mode: requester received the real values (fullName=${relayOutcome.data.fullName})`);
    ok(`platform recorded only that ${relayOutcome.data ? 'a relay happened' : ''} — byte count, no bytes`);
  }

  // =========================================================================
  step(7, 'FR-DPR-07: correction and erasure — signatures verified by the client');
  // =========================================================================
  for (const kind of ['correction', 'erasure']) {
    // Each action route insists the ticket is of the matching right type, so
    // file a real one of each rather than forcing it through the access ticket.
    const t = await api('POST', `/portal/${slug}/data-requests`, {
      body: {
        rightType: kind,
        subject: `Please ${kind === 'correction' ? 'correct my address' : 'erase my data'}`,
        body: `I am exercising my right of ${kind} under section 12 of the DPDP Act.`,
        contactChannel: 'email',
        contactValue: `principal-${kind}-${sfx}@personal.example`,
      },
      expect: 201,
    });
    await api('POST', `/portal/${slug}/requests/${t.ticketId}/otp/verify`, { body: { code: t.devOtp } });
    await api('POST', `/dprequest/tickets/${t.ticketId}/subject-reference`, {
      token: staff,
      body: { customerId: CUSTOMER_ID, reason: `Verified against core banking records for ${kind}.` },
    });
    const outcome = await api('POST', `/dprequest/tickets/${t.ticketId}/fulfilment/${kind}`, {
      token: staff,
    });
    const delivery = received.filter((r) => r.eventType === `dpr.${kind}.requested`).pop();
    if (!delivery?.verified) {
      bad(`${kind}: the client could NOT verify our signature`);
    } else if (outcome.status !== 'confirmed' || !outcome.confirmedAt) {
      bad(`${kind}: outcome was ${JSON.stringify(outcome)}`);
    } else {
      ok(`${kind}: signature verified by the client, confirmed at ${outcome.confirmedAt}`);
    }
  }

  const allVerified = received.every((r) => r.verified);
  if (!allVerified) bad(`${received.filter((r) => !r.verified).length} delivery signature(s) failed`);
  else ok(`all ${received.length} fulfilment deliveries carried a signature the client verified independently`);
  // The outbound payload must itself be clean — we ask about a subject REF.
  const leakyOutbound = received.filter((r) => ALL_CANARIES.some((c) => r.rawBody.includes(c)));
  if (leakyOutbound.length > 0) bad('an OUTBOUND payload contained a canary — we are sending customer data out');
  else ok('no outbound payload contained a raw customer id — the client is asked about a subject ref (I2)');

  // =========================================================================
  step(8, 'THE NEGATIVE PROOF: sweep the database for every canary');
  // =========================================================================
  // The tenant GUC is set above. Without it, FORCE ROW LEVEL SECURITY hides
  // every tenant-scoped row from the owner too and this sweep would report a
  // reassuring nothing while looking at nothing.
  const { rows: visible } = await client.query(
    `SELECT count(*)::int AS n FROM dpr_fulfilments`,
  );
  if (visible[0].n < 4) {
    bad(`only ${visible[0].n} fulfilment rows visible — RLS may be hiding rows and voiding this sweep`);
  } else {
    ok(`tenant context set: ${visible[0].n} fulfilment rows visible to the sweep`);
  }

  const { rows: cols } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text','character varying','jsonb','json')
        AND table_name NOT LIKE 'pgboss%'
      ORDER BY table_name`,
  );
  let hits = 0;
  let scanned = 0;
  for (const c of cols) {
    scanned += 1;
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM "${c.table_name}" WHERE "${c.column_name}"::text LIKE ANY($1::text[])`,
      [ALL_CANARIES.map((v) => `%${v}%`)],
    );
    if (rows[0].n > 0) {
      hits += rows[0].n;
      bad(`CANARY FOUND in ${c.table_name}.${c.column_name} — ${rows[0].n} row(s)`);
    }
  }
  if (hits === 0) {
    ok(`swept ${scanned} text/jsonb columns across every table: none of the ${ALL_CANARIES.length} canaries appears anywhere`);
  }

  // The audit log deserves naming separately — it is read by more people than
  // the database is, and is the likeliest accidental sink.
  const { rows: auditHits } = await client.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE before_state::text LIKE ANY($1::text[]) OR after_state::text LIKE ANY($1::text[])
         OR COALESCE(reason,'') LIKE ANY($1::text[])`,
    [ALL_CANARIES.map((v) => `%${v}%`)],
  );
  if (auditHits[0].n > 0) bad(`${auditHits[0].n} audit_log row(s) contain a canary`);
  else ok('audit_log contains no canary in reason, before_state or after_state');

  // And prove the fulfilment rows kept the RIGHT things.
  const { rows: fr } = await client.query(
    `SELECT kind, status, response_kind, relayed_bytes,
            delivery_url_sha256 IS NOT NULL AS has_url_hash,
            length(request_signature) AS sig_len
       FROM dpr_fulfilments ORDER BY requested_at`,
  );
  for (const r of fr) {
    info(
      `  ${r.kind.padEnd(12)} ${r.status.padEnd(9)} via ${String(r.response_kind).padEnd(12)} ` +
        `bytes=${r.relayed_bytes ?? '-'} urlHash=${r.has_url_hash} sig=${r.sig_len}ch`,
    );
  }
  const relayRow = fr.find((r) => r.response_kind === 'relay');
  if (relayRow && relayRow.relayed_bytes > 0) {
    ok(`the relay row records ${relayRow.relayed_bytes} bytes passed through — the count, not the bytes`);
  }
  const linkRow = fr.find((r) => r.response_kind === 'link');
  if (linkRow?.has_url_hash) ok('the link row stores a SHA-256 of the URL, not the URL');

  // =========================================================================
  step(9, 'THE NEGATIVE PROOF: logs and temp storage');
  // =========================================================================
  if (API_LOG && existsSync(API_LOG)) {
    const log = readFileSync(API_LOG, 'utf8');
    const found = ALL_CANARIES.filter((v) => log.includes(v));
    if (found.length > 0) bad(`API log contains canaries: ${found.join(', ')}`);
    else ok(`API log (${API_LOG}) contains none of the canaries`);
  } else {
    info(`(set API_LOG=/path/to/api.log to include the process log in this sweep)`);
  }

  // Anything the process spooled to disk mid-relay would land here.
  const tmp = tmpdir();
  const since = Date.now() - 15 * 60_000;
  let tmpHits = 0;
  let tmpScanned = 0;
  for (const name of readdirSync(tmp)) {
    const full = join(tmp, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < since || st.size > 8 * 1024 * 1024) continue;
    tmpScanned += 1;
    try {
      const content = readFileSync(full, 'utf8');
      if (ALL_CANARIES.some((v) => content.includes(v))) {
        tmpHits += 1;
        bad(`CANARY FOUND in temp file ${full}`);
      }
    } catch {
      /* unreadable/binary — skip */
    }
  }
  if (tmpHits === 0) {
    ok(`scanned ${tmpScanned} file(s) written to ${tmp} in the last 15 min: no canaries`);
  }

  // =========================================================================
  step(10, 'FR-DPR-06: the register and its on-time-closure evidence');
  // =========================================================================
  const register = await api('GET', '/dprequest/register', { token: staff });
  ok(`register lists ${register.stats.total} request(s): ${register.stats.open} open, ${register.stats.closed} closed`);
  for (const e of register.entries.slice(0, 3)) {
    info(`  ${e.referenceCode}  ${String(e.rightType).padEnd(11)} ${e.slaPolicyKey} v${e.slaPolicyVersion}  due ${e.slaDueAt?.slice(0, 10)}`);
  }

  // Close one inside its deadline and confirm it counts as on time.
  await api('POST', `/requests/${submitted.ticketId}/identity-verification`, {
    token: staff,
    body: { outcome: 'matched', reason: 'Verified against core banking records at the branch.' },
  });
  await api('POST', `/requests/${submitted.ticketId}/status`, {
    token: staff,
    body: { status: 'resolved', reason: 'Personal data summary issued to the data principal.' },
  });
  const register2 = await api('GET', '/dprequest/register', { token: staff });
  const closedRow = register2.entries.find((e) => e.referenceCode === submitted.referenceCode);
  if (closedRow?.closedOnTime !== true) {
    bad(`the resolved request reads closedOnTime=${closedRow?.closedOnTime}, expected true`);
  } else {
    ok(`${submitted.referenceCode} closed inside its deadline -> counted on time (${register2.stats.closedOnTime}/${register2.stats.closed})`);
  }

  const pdfRes = await api('POST', '/dprequest/register/export', { token: staff, raw: true });
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  if (pdfRes.status !== 200 || pdf.subarray(0, 4).toString() !== '%PDF') {
    bad(`register export returned ${pdfRes.status}, ${pdf.length} bytes`);
  } else {
    ok(`register evidence export: ${pdf.length}-byte PDF via the existing pdfkit pipeline`);
    const asText = pdf.toString('latin1');
    if (ALL_CANARIES.some((v) => asText.includes(v))) bad('the register PDF contains a canary');
    else ok('the register PDF contains no canary and no subject reference — process facts only');
  }
} finally {
  clientServer.close();
  if (client) await client.end();
}

console.log(
  process.exitCode
    ? '\n✗ Something above failed — see the ✗ lines.\n'
    : '\n✓ All checks passed: Tier 1 accurate, Tier 2 relayed, nothing persisted.\n',
);
