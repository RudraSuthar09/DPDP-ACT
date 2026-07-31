/**
 * Drive the BREACH REGISTER end to end (FR-BRC-01…07), against the real API,
 * the real worker and the real database.
 *
 *   pnpm breach:demo
 *
 * Proves the things the register actually has to be right about:
 *
 *   FR-BRC-01  data categories are REFERENCES into the real Data Inventory, and
 *              an incident inherits the register's live purposes/legal bases.
 *   FR-BRC-02  every gate's deadline comes from a VERSIONED CONFIGURATION
 *              RECORD, and superseding one moves new incidents without moving
 *              open ones.
 *   FR-BRC-03  the gates are ORDERED — skipping one is refused, not tolerated.
 *   FR-BRC-04  a deadline really fires through the WorkflowRunner and escalates.
 *   FR-BRC-05  the stored digest equals the real SHA-256 of the uploaded bytes,
 *              and the bytes are nowhere in the database.
 *   FR-BRC-06  the templates are populated from the incident's own data.
 *   FR-BRC-07  the closure packet renders with the incident's real content.
 *
 * Needs the API AND the worker running (the API schedules deadlines; only the
 * worker fires them).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
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

const step = (n, s) => console.log(`\n${'='.repeat(76)}\n${n}. ${s}\n${'='.repeat(76)}`);
const ok = (s) => console.log(`   ✓ ${s}`);
const info = (s) => console.log(`     ${s}`);
const bad = (s) => { console.error(`   ✗ ${s}`); process.exitCode = 1; };

async function api(method, path, { body, token, expect, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** pdfkit emits hex strings inside FlateDecode streams, so a plain latin1
 *  search finds nothing whether or not the text is there. Inflate, then decode
 *  the <hex> tokens. */
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

try { await fetch(`${BASE}/health`); } catch {
  console.error(`\nNothing on ${BASE}. Start:  pnpm dev:api  and  pnpm --filter @dpdp/api dev:worker\n`);
  process.exit(1);
}

const sfx = randomBytes(3).toString('hex');
const PASSWORD = 'a-long-enough-password-2026';
let client;

console.log(`\nBreach Register — FR-BRC-01…07`);
console.log(`Driving ${BASE}`);

try {
  // =========================================================================
  step(1, 'Tenant, escalation ladder, and REAL Data Inventory entries');
  // =========================================================================
  const reg = await api('POST', '/auth/register', {
    body: { organisationName: `Meridian Health ${sfx}`, ownerEmail: `dpo-${sfx}@meridian.example`, ownerName: 'Arjun Rao', password: PASSWORD },
  });
  const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
  const secret = base32Decode(enrol.secret);
  const confirmed = await api('POST', '/auth/mfa/confirm', { body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) } });
  const staff = confirmed.accessToken;
  const me = await api('GET', '/auth/me', { token: staff });
  ok(`tenant ${reg.tenantId}`);

  for (const d of ['grievance_officer', 'dpo', 'escalation_contact']) {
    await api('POST', '/users/designations', { token: staff, body: { designation: d, userId: me.userId, reason: 'Breach demo: escalation ladder' } });
  }
  ok('escalation ladder named (all three rungs)');

  const entries = [];
  for (const spec of [
    { category: 'Patient contact details', storageLocation: 'ehr.patients', purposeName: 'Appointment reminders', legalBasis: 'consent', retentionPeriod: '3 years' },
    { category: 'Clinical notes', storageLocation: 'ehr.encounters', purposeName: 'Provision of care', legalBasis: 'legitimate_use', retentionPeriod: '10 years (clinical record rule)' },
  ]) {
    const e = await api('POST', '/inventory/register', {
      token: staff, body: { category: spec.category, description: `${spec.category} held by the hospital.`, storageLocation: spec.storageLocation }, expect: 201,
    });
    await api('POST', `/inventory/register/${e.id}/purposes`, {
      token: staff, body: { purposeName: spec.purposeName, legalBasis: spec.legalBasis, retentionPeriod: spec.retentionPeriod }, expect: 201,
    });
    entries.push({ ...spec, id: e.id });
    ok(`inventory: ${spec.category} — ${spec.purposeName} (${spec.legalBasis}, ${spec.retentionPeriod})`);
  }

  // =========================================================================
  step(2, 'FR-BRC-02: every gate deadline is a VERSIONED RECORD, not a constant');
  // =========================================================================
  const { policies } = await api('GET', '/breach/deadline-policies', { token: staff });
  for (const p of policies) {
    info(`  ${p.gate.padEnd(24)} v${p.version}  ${String(p.slaHours).padStart(5)}h  key=${p.policyKey}`);
    if (p.isFallback) bad(`${p.gate} has no policy record in force`);
  }
  const expectHours = { acknowledge: 6, assess: 24, notify_data_principals: 72, notify_board: 72, remediate: 720, rca: 720, closure: 1080 };
  for (const p of policies) {
    if (p.slaHours !== expectHours[p.gate]) bad(`${p.gate}: expected ${expectHours[p.gate]}h, record says ${p.slaHours}h`);
  }
  ok('all seven gates resolve to a v1 record — no statutory number comes from code');
  ok('notify_board and notify_data_principals are both 72h from DISCOVERY (DPDP §8(6))');

  // =========================================================================
  step(3, 'FR-BRC-01: open an incident referencing REAL inventory entries');
  // =========================================================================
  // Discovered 2 hours ago, so the 6-hour acknowledge clock is genuinely
  // partway through rather than starting fresh.
  const discoveredAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const incident = await api('POST', '/breach/incidents', {
    token: staff,
    body: {
      title: 'Misconfigured backup bucket exposed patient records',
      whatHappened:
        'A nightly database backup was written to an object-storage bucket whose access policy had been ' +
        'changed to public during unrelated maintenance. The bucket was reachable without credentials for ' +
        'approximately 40 hours before an external researcher reported it.',
      discoveredAt,
      occurredAt: new Date(Date.now() - 42 * 3600 * 1000).toISOString(),
      systemsAffected: ['ehr-primary', 'nightly-backup-pipeline', 'object-storage:eu-west-1'],
      dataCategoryEntryIds: entries.map((e) => e.id),
      estimatedAffectedCount: 12400,
      severity: 'critical',
    },
    expect: 201,
  });
  ok(`incident ${incident.referenceCode} opened, severity ${incident.severity}`);

  const detail0 = await api('GET', `/breach/incidents/${incident.id}`, { token: staff });
  if (detail0.dataCategories.length !== 2) bad(`expected 2 referenced categories, got ${detail0.dataCategories.length}`);
  else {
    ok('data categories are REFERENCES — the incident carries the register live facts:');
    for (const c of detail0.dataCategories) {
      info(`  ${c.category} @ ${c.storageLocation} — ${c.purposes.map((p) => `${p.purposeName}/${p.legalBasis}/${p.retentionPeriod}`).join('; ')}`);
    }
  }
  // A free-text category could not do this: rename in the inventory, read the
  // new name here, with no copy to update.
  const ack = detail0.gateStatuses.find((g) => g.gate === 'acknowledge');
  const dueIn = (new Date(ack.dueAt) - Date.now()) / 3600000;
  if (Math.abs(dueIn - 4) > 0.2) bad(`acknowledge due in ${dueIn.toFixed(2)}h; expected ~4h (6h from a discovery 2h ago)`);
  else ok(`deadlines anchor to DISCOVERY, not logging: acknowledge due in ${dueIn.toFixed(2)}h, not 6h`);
  ok(`each gate cites its policy: acknowledge -> ${ack.policyKey} v${ack.policyVersion}`);

  // =========================================================================
  step(4, 'FR-BRC-03: the gates are ORDERED — skipping is refused');
  // =========================================================================
  const skip = await api('POST', `/breach/incidents/${incident.id}/gates/notify_board`, {
    token: staff, body: { notes: 'Attempting to notify the Board before acknowledging or assessing.' }, raw: true,
  });
  if (skip.status !== 409) bad(`skipping to notify_board returned ${skip.status}, expected 409`);
  else ok('notify_board before acknowledge/assess -> 409, with the missing gates named');

  // =========================================================================
  step(5, 'FR-BRC-04: a real deadline fires through the WorkflowRunner');
  // =========================================================================
  // Supersede acknowledge to the 60s floor so its ladder plays out inside this
  // run — through the SAME versioned-record mechanism, not a test backdoor.
  await api('POST', '/breach/deadline-policies/acknowledge', {
    token: staff,
    body: {
      slaSeconds: 60,
      ladder: [
        { level: 1, atPercent: 50, rung: 'grievance_officer' },
        { level: 2, atPercent: 80, rung: 'dpo' },
        { level: 3, atPercent: 100, rung: 'escalation_contact' },
      ],
      note: 'Demo: shortened to the 60s floor so the escalation ladder is observable in one run.',
    },
    expect: 201,
  });
  ok('acknowledge policy superseded to v2 (60s) through the versioned-record API');

  // v1 incident above must NOT move. A NEW incident gets v2.
  const detailAfter = await api('GET', `/breach/incidents/${incident.id}`, { token: staff });
  const ackAfter = detailAfter.gateStatuses.find((g) => g.gate === 'acknowledge');
  if (ackAfter.dueAt !== ack.dueAt) bad('superseding the policy MOVED an open incident deadline — the snapshot is not holding');
  else ok('the already-open incident keeps its v1 deadline — yesterday is not re-judged (I4)');

  const fast = await api('POST', '/breach/incidents', {
    token: staff,
    body: {
      title: 'Laptop containing appointment lists stolen from a vehicle',
      whatHappened: 'An unencrypted laptop holding exported appointment lists was stolen from a staff member vehicle overnight.',
      discoveredAt: new Date().toISOString(),
      systemsAffected: ['staff-laptop-fleet'],
      dataCategoryEntryIds: [entries[0].id],
      estimatedAffectedCount: 310,
      severity: 'high',
    },
    expect: 201,
  });
  const fastDetail = await api('GET', `/breach/incidents/${fast.id}`, { token: staff });
  const fastAck = fastDetail.gateStatuses.find((g) => g.gate === 'acknowledge');
  const fastSecs = (new Date(fastAck.dueAt) - new Date(fast.discoveredAt)) / 1000;
  if (Math.abs(fastSecs - 60) > 5) bad(`new incident acknowledge window is ${fastSecs}s, expected 60`);
  else ok(`a NEW incident gets v2: acknowledge due ${fastSecs}s after discovery, citing ${fastAck.policyKey} v${fastAck.policyVersion}`);

  info('  waiting ~75s for the worker to fire the ladder...');
  await new Promise((r) => setTimeout(r, 75_000));

  const fired = await api('GET', `/breach/incidents/${fast.id}`, { token: staff });
  if (fired.escalations.length === 0) {
    bad('no escalation recorded — is the worker running? (pnpm --filter @dpdp/api dev:worker)');
  } else {
    ok(`${fired.escalations.length} escalation(s) fired through the real WorkflowRunner:`);
    for (const e of fired.escalations) {
      info(`  ${e.gate} L${e.level} ${e.rung} (${e.trigger}) notified=${e.notifiedOk} at ${e.occurredAt}`);
    }
    const breached = fired.escalations.some((e) => e.trigger === 'sla_breach');
    if (!breached) bad('no sla_breach escalation — the 100% rung did not fire');
    else ok('the 100% rung fired as sla_breach — the gate is recorded as missed, not silently late');
  }

  // =========================================================================
  step(6, 'FR-BRC-05: evidence hash equals the real SHA-256, bytes stored nowhere');
  // =========================================================================
  const evidenceBody =
    `FORENSIC EXTRACT ${sfx}\nBucket ACL history and access log excerpt.\n` +
    `CANARY-EVIDENCE-${sfx.toUpperCase()}\n` + 'x'.repeat(2048);
  const expectedSha = createHash('sha256').update(Buffer.from(evidenceBody, 'utf8')).digest('hex');
  const registered = await api('POST', `/breach/incidents/${incident.id}/evidence`, {
    token: staff,
    body: {
      fileName: 'bucket-acl-forensics.txt',
      contentType: 'text/plain',
      contentBase64: Buffer.from(evidenceBody, 'utf8').toString('base64'),
      description: 'Access log excerpt showing the public window.',
    },
    expect: 201,
  });
  if (registered.sha256 !== expectedSha) bad(`stored digest ${registered.sha256} != real SHA-256 ${expectedSha}`);
  else ok(`stored digest matches the file real SHA-256 (${expectedSha.slice(0, 24)}…)`);
  if (registered.sizeBytes !== Buffer.byteLength(evidenceBody)) bad('recorded size does not match the real byte length');
  else ok(`recorded size ${registered.sizeBytes} bytes matches the real file`);

  // =========================================================================
  step(7, 'FR-BRC-03: walk every remaining gate, then close with sign-off');
  // =========================================================================
  const gateNotes = {
    acknowledge: 'Incident acknowledged by the on-call DPO; bucket ACL reverted to private immediately.',
    assess: 'Assessed: two data categories exposed (patient contact details, clinical notes), approximately 12,400 data principals, public for ~40 hours.',
    notify_data_principals: 'Notice issued to all affected data principals by email and SMS using our own contact records.',
    notify_board: 'Report filed with the Data Protection Board under section 8(6) with the full assessment attached.',
    remediate: 'Bucket policy locked, org-wide public-access block enabled, backup pipeline moved to a private VPC endpoint.',
    rca: 'Root cause: a maintenance script applied a permissive ACL template. Template removed, change review added to the pipeline.',
    closure: 'All actions complete and verified by the compliance officer.',
  };
  for (const gate of Object.keys(gateNotes)) {
    await api('POST', `/breach/incidents/${incident.id}/gates/${gate}`, { token: staff, body: { notes: gateNotes[gate] } });
    ok(`gate passed: ${gate}`);
  }
  const closed = await api('POST', `/breach/incidents/${incident.id}/close`, {
    token: staff, body: { note: 'Signed off by the DPO. All seven gates complete, evidence attested, notifications issued.' },
  });
  if (closed.status !== 'closed') bad(`incident status is ${closed.status}`);
  else ok(`incident closed and signed off at ${closed.closedAt}`);

  // =========================================================================
  step(8, 'FR-BRC-06: templates auto-populated from the incident real data');
  // =========================================================================
  for (const kind of ['data_principal_notice', 'regulator_report']) {
    const t = await api('POST', `/breach/incidents/${incident.id}/templates/${kind}`, { token: staff });
    const checks = [
      [t.body.includes(incident.referenceCode), 'reference code'],
      [t.body.includes('Patient contact details'), 'a real inventory category'],
      [t.body.includes(gateNotes.remediate.slice(0, 40)), 'the recorded remediation'],
    ];
    if (kind === 'regulator_report') {
      checks.push([t.body.includes('12400') || t.body.includes('12,400'), 'the estimated affected count']);
      checks.push([t.body.includes('legitimate use') || t.body.includes('consent'), 'a real legal basis']);
    }
    const failed = checks.filter(([passed]) => !passed).map(([, what]) => what);
    if (failed.length) bad(`${kind} is missing: ${failed.join(', ')}`);
    else ok(`${kind}: populated with ${checks.length} real facts from the incident`);
    if (t.gaps.length) info(`  declared gaps: ${t.gaps.join(' | ')}`);
    else info('  no declared gaps — every section had real data to fill it');
  }

  // =========================================================================
  step(9, 'FR-BRC-07: the sealed closure packet');
  // =========================================================================
  const pdfRes = await api('POST', `/breach/incidents/${incident.id}/closure-packet`, { token: staff, raw: true });
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  if (pdf.subarray(0, 4).toString() !== '%PDF') bad(`closure packet is not a PDF (${pdf.length} bytes)`);
  else ok(`closure packet: ${pdf.length}-byte PDF via the existing pdfkit pipeline`);

  const text = extractPdfText(pdf);
  const packetChecks = [
    [text.includes(incident.referenceCode), 'the reference code'],
    [text.includes('Patient contact details'), 'a real inventory category'],
    [text.includes(expectedSha), 'the evidence SHA-256 in full'],
    [text.includes('bucket-acl-forensics.txt'), 'the evidence filename'],
    [text.includes('Root cause'), 'the RCA gate notes'],
  ];
  const missing = packetChecks.filter(([p]) => !p).map(([, w]) => w);
  if (missing.length) bad(`closure packet missing: ${missing.join(', ')}`);
  else ok('closure packet contains the reference, a real category, the RCA, and the full evidence digest');

  // =========================================================================
  step(10, 'I1: the evidence bytes are nowhere in the database');
  // =========================================================================
  client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SELECT set_config('app.current_tenant', $1, false)`, [reg.tenantId]);
  const { rows: visible } = await client.query(`SELECT count(*)::int AS n FROM breach_evidence`);
  if (visible[0].n < 1) bad('no evidence rows visible — RLS may be hiding them, voiding this sweep');
  else ok(`tenant context set: ${visible[0].n} evidence row(s) visible to the sweep`);

  const canary = `CANARY-EVIDENCE-${sfx.toUpperCase()}`;
  const { rows: cols } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json')
        AND table_name NOT LIKE 'pgboss%'`,
  );
  let hits = 0;
  for (const c of cols) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM "${c.table_name}" WHERE "${c.column_name}"::text LIKE $1`, [`%${canary}%`],
    );
    if (rows[0].n > 0) { hits += rows[0].n; bad(`evidence content found in ${c.table_name}.${c.column_name}`); }
  }
  if (hits === 0) ok(`swept ${cols.length} text/jsonb columns: the evidence CONTENT appears nowhere — only its digest`);

  const { rows: stored } = await client.query(
    `SELECT sha256, size_bytes FROM breach_evidence WHERE incident_id = $1`, [incident.id],
  );
  ok(`breach_evidence holds sha256=${stored[0].sha256.slice(0, 24)}… size=${stored[0].size_bytes} and no content column`);
} finally {
  if (client) await client.end();
}

console.log(process.exitCode ? '\n✗ Some checks failed.\n' : '\n✓ All Breach Register checks passed.\n');
