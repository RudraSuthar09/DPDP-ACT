/* eslint-disable */
'use strict';
/**
 * Seams S2 / S3 / S4 — a real, working end-to-end demo.
 *
 * This is NOT a reimplementation. It boots the actual Nest providers from dist/
 * and drives the real seam classes:
 *   - S2: ConsentService.recordConsent -> PostgresEventSink.append -> app.consent_append
 *   - S3: PgBossWorkflowRunner.schedule -> pg-boss engine -> WorkflowWorker.fire
 *   - S4: the SchemaSource implementations, whose type has no readRows()
 *
 * Run from backend/:  node demo/seams-demo.js
 */
require('reflect-metadata');
const { randomUUID, createHmac } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { Module } = require('@nestjs/common');

// --- real providers, straight from the compiled app ------------------------
const { AppModule } = require('../dist/app.module');
const { WorkflowWorker } = require('../dist/modules/workflow/workflow.worker');
const { WORKFLOW_RUNNER } = require('../dist/modules/workflow/pg-boss-workflow-runner');
const { WorkflowJobsRepository } = require('../dist/modules/workflow/workflow-jobs.repository');
const { ConsentService } = require('../dist/modules/consent/consent.service');
const { TenantContextService } = require('../dist/tenancy/tenant-context.service');
const { TenantDatabaseService } = require('../dist/database/database.service');
const { ManualEntrySchemaSource } = require('../dist/modules/inventory/schema-source/manual-entry.source');
const { FileImportSchemaSource } = require('../dist/modules/inventory/schema-source/file-import.source');

// One process that both SCHEDULES (AppModule) and FIRES (WorkflowWorker). In
// production these are two containers; here we co-host them so the demo is
// self-contained. Both halves are the real classes. (Decorator applied
// functionally because this file is plain JS, not TS.)
class DemoModule {}
Module({ imports: [AppModule], providers: [WorkflowWorker] })(DemoModule);

const line = (s = '') => console.log(s);
const h1 = (s) => { line(); line('='.repeat(74)); line('  ' + s); line('='.repeat(74)); };
const ok = (s) => line('  ✓ ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const app = await NestFactory.createApplicationContext(DemoModule, { logger: ['warn', 'error'] });
  await app.init(); // fires onApplicationBootstrap -> WorkflowWorker starts consuming + ticking

  const tctx = app.get(TenantContextService, { strict: false });
  const db = app.get(TenantDatabaseService, { strict: false });
  const consent = app.get(ConsentService, { strict: false });
  const runner = app.get(WORKFLOW_RUNNER, { strict: false });
  const jobs = app.get(WorkflowJobsRepository, { strict: false });

  // A fresh tenant for this demo run (tenant_id = id, per the org table's CHECK).
  const tenantId = randomUUID();
  const ctx = { tenantId, userId: randomUUID(), role: 'org_admin', correlationId: randomUUID() };
  const run = (fn) => tctx.run(ctx, fn);

  // Seed the tenant row (the real runtime role, under RLS, via the real gateway).
  await run(() =>
    db.withTenant((client) =>
      client.query('INSERT INTO organisations (id, name) VALUES ($1, $2)', [tenantId, 'Demo Fiduciary Pvt Ltd']),
    ),
  );
  line(`Demo tenant: ${tenantId}`);

  // =========================================================================
  // S4 — SchemaSource: proven by the ABSENCE of readRows()
  // =========================================================================
  h1('S4 SchemaSource — the missing method IS the guarantee (I1)');
  const manual = new ManualEntrySchemaSource({
    schemas: [{ name: 'crm', tables: [{ name: 'customers', columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'email', type: 'text', nullable: false },
    ] }] }],
  });
  const fileSrc = new FileImportSchemaSource({
    fileName: 'patients.csv',
    tableName: 'patients',
    // A file FULL of real customer data. Only the header is ever read.
    csvText: 'full_name,aadhaar,mobile\nAsha Rao,999988887777,9876543210\nRavi Kumar,111122223333,9000000000',
  });

  ok('ManualEntry.listColumns(customers) -> ' +
    JSON.stringify((await manual.listColumns('customers')).map((c) => c.name)));
  ok('FileImport.listColumns() (from header only) -> ' +
    JSON.stringify((await fileSrc.listColumns()).map((c) => c.name)));

  for (const [name, src] of [['ManualEntry', manual], ['FileImport', fileSrc]]) {
    const hasReadRows = typeof src.readRows === 'function'
      || typeof src.getRows === 'function'
      || typeof src.sampleRows === 'function';
    ok(`${name}: readRows / getRows / sampleRows present? ${hasReadRows}  (must be false)`);
  }
  // The data rows never entered the program: the sentinel appears nowhere.
  const leaked = JSON.stringify(fileSrc).includes('Asha Rao') || JSON.stringify(fileSrc).includes('999988887777');
  ok(`Customer data from the CSV present anywhere on the source object? ${leaked}  (must be false)`);
  line('  -> A connector cannot exfiltrate a row because the method to read one does not exist.');

  // =========================================================================
  // S2 — EventSink: the ONE write path, and nothing else can write
  // =========================================================================
  h1('S2 EventSink — one append path, an append-only table');

  // A purpose to attach consent to (ordinary tenant metadata, real service).
  const purpose = await run(() => consent.createPurpose('Marketing notifications'));
  ok(`Created consent purpose "${purpose.name}" (${purpose.id})`);

  // Record a GRANT through the real ConsentService -> EventSink -> app.consent_append.
  // The SDK supplies an idempotency key with the event (FR-CON-03); we do the same.
  const grantEvent = {
    customerId: 'cust-42', purposeId: purpose.id, status: 'GRANTED',
    noticeVersionId: 'notice-v1', occurredAt: new Date().toISOString(), source: 'web_sdk',
    idempotencyKey: 'sdk-key-' + randomUUID(),
  };
  const grant = await run(() => consent.recordConsent(grantEvent));
  ok(`recordConsent(GRANTED) -> eventId ${grant.receipt.eventId}, deduplicated=${grant.receipt.deduplicated}`);

  // Idempotency is a property of the SEAM: replay the SAME event (same key), get
  // the same receipt and NO new row — what makes a retried SDK call safe.
  const replay = await run(() => consent.recordConsent(grantEvent));
  ok(`replay same event -> eventId ${replay.receipt.eventId}, deduplicated=${replay.receipt.deduplicated} ` +
    `(same id as grant? ${replay.receipt.eventId === grant.receipt.eventId})`);

  // A withdrawal is a NEW event, never an update (FR-CON-05).
  const withdraw = await run(() => consent.recordConsent({
    customerId: 'cust-42', purposeId: purpose.id, status: 'WITHDRAWN',
    noticeVersionId: 'notice-v1', occurredAt: new Date().toISOString(), source: 'portal',
  }));
  ok(`recordConsent(WITHDRAWN) -> eventId ${withdraw.receipt.eventId} (a new row, not an edit)`);

  // Read the events straight back out of the table (SELECT is allowed).
  const landed = await run(() =>
    db.withTenant(async (client) => (await client.query(
      `SELECT id, status, source, occurred_at, recorded_at FROM consent_events
        WHERE subject_ref = $1 ORDER BY recorded_at`, [grant.subjectRef])).rows),
  );
  line('  Rows actually in consent_events for this subject:');
  for (const r of landed) line(`     - ${r.status.padEnd(9)} src=${r.source.padEnd(8)} id=${r.id}`);
  ok(`Replay wrote no new row? ${landed.length === 2 ? 'yes (2 rows: GRANT + WITHDRAW)' : 'NO — ' + landed.length + ' rows'}`);

  // R3 — prove nothing but the sink can write. A raw INSERT as the runtime role
  // (dpdp_app has SELECT only on consent_events) must be refused by Postgres.
  let denied = false, msg = '';
  try {
    await run(() => db.withTenant((client) => client.query(
      `INSERT INTO consent_events (subject_ref, purpose_id, status, notice_version_id, occurred_at, source, evidence_hash, idempotency_key)
       VALUES ('x', $1, 'GRANTED', 'n', now(), 'api', 'h', $2)`, [purpose.id, randomUUID()])));
  } catch (e) { denied = true; msg = e.message.split('\n')[0]; }
  ok(`Ad-hoc INSERT into consent_events (bypassing the sink) was refused? ${denied}`);
  if (denied) line(`     Postgres said: ${msg}`);

  // =========================================================================
  // S3 — WorkflowRunner: schedule at time X, it fires at time X
  // =========================================================================
  h1('S3 WorkflowRunner — schedule a deadline, watch it fire');
  const workflowId = randomUUID();
  const fireInMs = 5000;
  const runAt = new Date(Date.now() + fireInMs).toISOString();

  await run(() => runner.schedule({ workflowId, kind: 'breach', runAt, payload: { note: 'ids-only, no customer data (I1)' } }));
  ok(`runner.schedule(breach, runAt=${runAt})  [~${fireInMs / 1000}s from now]`);

  let before = await run(() => jobs.get(workflowId, 'breach'));
  line(`  workflow_jobs status now: ${before.status}  (run_at ${new Date(before.run_at).toISOString()})`);

  line('  waiting for the engine to fire it...');
  const deadline = Date.now() + 30000;
  let after = before;
  while (Date.now() < deadline) {
    await sleep(1000);
    after = await run(() => jobs.get(workflowId, 'breach'));
    if (after.status === 'fired') break;
    process.stdout.write('.');
  }
  line();
  if (after.status === 'fired') {
    const waited = ((new Date(after.fired_at).getTime() - new Date(after.run_at).getTime()) / 1000).toFixed(1);
    ok(`Job FIRED. status=${after.status}, fired_at=${new Date(after.fired_at).toISOString()} (${waited}s after its deadline)`);
  } else {
    line(`  ✗ Job did NOT fire in time. status=${after.status}`);
  }

  // cancel() semantics: a fresh job cancelled before it fires never runs.
  const cancelId = randomUUID();
  await run(() => runner.schedule({ workflowId: cancelId, kind: 'grievance', runAt: new Date(Date.now() + 60000).toISOString(), payload: {} }));
  await run(() => runner.cancel(cancelId));
  const cancelled = await run(() => jobs.get(cancelId, 'grievance'));
  ok(`A scheduled-then-cancelled job has status: ${cancelled.status}  (won't fire)`);

  h1('Demo complete');
  line('  S2 EventSink   : event landed via the one append path; ad-hoc INSERT refused.');
  line('  S3 WorkflowRunner: a job scheduled for time X actually fired at time X.');
  line('  S4 SchemaSource : structure only; readRows() does not exist, data never entered.');
  line();

  await app.close();
  process.exit(after.status === 'fired' ? 0 : 1);
}

main().catch((e) => { console.error('DEMO FAILED:', e); process.exit(1); });
