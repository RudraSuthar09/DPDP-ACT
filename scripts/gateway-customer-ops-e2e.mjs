/**
 * Phase 3G-2 — REAL PostgreSQL end-to-end validation for customer resolution,
 * controlled write/create, and controlled column creation.
 *
 * Spins up a genuine PostgreSQL (embedded-postgres, no Docker), seeds a real
 * customers table, and drives the ACTUAL agent DatabaseConnector (real driver,
 * real SQL) through:
 *   - resolveCustomer (existing + not-found) with an opaque, non-leaking ref
 *   - writeCustomerFields (mapped column succeeds; unmapped column rejected)
 *   - createCustomer (creates once, never duplicates on a second identical call)
 *   - createColumn (real ALTER TABLE; the new column is then visible via
 *     listFields — proving it was NOT a no-op)
 *   - the READ-ONLY credential cannot write (write fails without makeWriteClient)
 *   - invalid write credentials fail with a SANITIZED error (no password/host)
 *
 *   node scripts/gateway-customer-ops-e2e.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_DB_PORT ?? 54341);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dpdp-e2e-custops-'));
const READ_PW = 'read_e2e_only';
const WRITE_PW = 'write_e2e_only';

const { DatabaseConnector } = await import(new URL('../agent/dist/connectors/db/database-connector.js', import.meta.url));
const { postgresDialect } = await import(new URL('../agent/dist/connectors/db/dialect.js', import.meta.url));
const { realDbClientFactory } = await import(new URL('../agent/dist/connectors/db/db-client.js', import.meta.url));

const SENTINEL_EMAIL = `rahul.${Date.now()}@example.com`;
const NEW_EMAIL = `asha.${Date.now()}@example.com`;
const ok = (s) => console.error('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.error(`\n=== ${s} ===`);
const guard = setTimeout(() => { console.error('E2E hard timeout'); process.exit(1); }, 110_000);
guard.unref();

const epg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false, onLog: () => {} });

try {
  step('Start a real PostgreSQL');
  await epg.initialise();
  await epg.start();
  ok(`PostgreSQL running on localhost:${PORT}`);

  const admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE DATABASE custops');
  await admin.query(`CREATE ROLE dpdp_read LOGIN PASSWORD '${READ_PW}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE dpdp_write LOGIN PASSWORD '${WRITE_PW}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query('GRANT CONNECT ON DATABASE custops TO dpdp_read, dpdp_write');
  await admin.end();

  step('Seed a real customers table + grant read-only / read-write privileges separately');
  const owner = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'custops' });
  await owner.connect();
  await owner.query('CREATE TABLE public.customers (id serial PRIMARY KEY, customer_name text, mobile text, email text)');
  await owner.query('INSERT INTO public.customers (customer_name, mobile, email) VALUES ($1,$2,$3)', ['Rahul Kumar', '9876543210', SENTINEL_EMAIL]);
  await owner.query('GRANT USAGE ON SCHEMA public TO dpdp_read, dpdp_write');
  await owner.query('GRANT SELECT ON public.customers TO dpdp_read, dpdp_write');
  await owner.query('GRANT INSERT, UPDATE ON public.customers TO dpdp_write'); // ALTER comes from OWNER below (not a grantable privilege)
  await owner.query('GRANT USAGE, SELECT ON SEQUENCE public.customers_id_seq TO dpdp_write');
  // Table-level ALTER requires ownership or a role grant; simplest for this E2E:
  // make dpdp_write an owner-equivalent via ALTER TABLE OWNER for the ALTER-COLUMN test.
  await owner.query('ALTER TABLE public.customers OWNER TO dpdp_write');
  await owner.end();

  const readConn = { host: 'localhost', port: PORT, user: 'dpdp_read', password: READ_PW, database: 'custops' };
  const writeConn = { host: 'localhost', port: PORT, user: 'dpdp_write', password: WRITE_PW, database: 'custops' };

  step('Real connector: resolveCustomer (existing + not found)');
  const connector = new DatabaseConnector(postgresDialect, () => realDbClientFactory('postgresql', readConn), {
    identityColumn: 'email',
    allowCustomerCreate: true,
    writableColumns: ['mobile', 'customer_name'],
    makeWriteClient: () => realDbClientFactory('postgresql', writeConn),
  });
  const disc = await connector.discover();
  const customersHandle = disc.handles.find((h) => h.descriptor.label === 'public.customers');
  if (!customersHandle) bad('discover did not find public.customers'); else ok('discover found public.customers');

  const found = await connector.resolveCustomer(customersHandle.handle, SENTINEL_EMAIL);
  if (found.exists && found.customerRef) ok(`resolveCustomer found the existing customer (opaque ref: ${found.customerRef.slice(0, 8)}…)`);
  else bad('resolveCustomer did not find the seeded customer');
  // The real primary key is the integer 1 (first row inserted). The ref must be
  // an opaque UUID, not that value literally, and not the identity email.
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(found.customerRef ?? '');
  if (looksLikeUuid && found.customerRef !== '1' && !found.customerRef.includes(SENTINEL_EMAIL)) {
    ok('customerRef is an opaque UUID — not the primary key, not the identity value');
  } else {
    bad(`customerRef does not look opaque: ${found.customerRef}`);
  }

  const notFound = await connector.resolveCustomer(customersHandle.handle, 'nobody@example.com');
  if (!notFound.exists && notFound.customerRef === null) ok('resolveCustomer correctly reports "not found" for an unknown identity');
  else bad('resolveCustomer should have reported not-found');

  step('Real connector: controlled write (mapped succeeds, unmapped rejected)');
  const writeRes = await connector.writeCustomerFields(found.customerRef, { mobile: '9999999999' });
  if (writeRes.success) ok('writeCustomerFields updated the mapped column'); else bad('writeCustomerFields failed unexpectedly');
  const verify = await owner_reconnect_and_check(PORT, SENTINEL_EMAIL, '9999999999');
  if (verify) ok('the REAL row in PostgreSQL now has the updated mobile number'); else bad('the update did not actually persist in PostgreSQL');

  try {
    await connector.writeCustomerFields(found.customerRef, { email: 'hijacked@example.com' }); // email NOT writable
    bad('writing an unmapped column (email) should have been rejected');
  } catch (e) {
    if (e.code === 'COLUMN_NOT_MAPPED') ok('writing an unmapped column (email) was rejected — COLUMN_NOT_MAPPED');
    else bad(`unexpected error for unmapped write: ${e.code}`);
  }

  step('Real connector: controlled create (once — never duplicated)');
  const created = await connector.createCustomer(customersHandle.handle, NEW_EMAIL, { customer_name: 'Asha Rao', mobile: '9812345678' });
  if (created.created && created.customerRef) ok('createCustomer created a real new row'); else bad('createCustomer did not create');
  const dup = await connector.createCustomer(customersHandle.handle, NEW_EMAIL, { customer_name: 'Asha Rao Duplicate Attempt', mobile: '0000000000' });
  // Each resolve mints a FRESH opaque ref (by design — refs are not reused
  // across calls), so the refs need not be equal; what matters is that the
  // second call reports the EXISTING row rather than inserting a new one.
  if (!dup.created && dup.exists && dup.customerRef) ok('a second createCustomer with the same identity reports "already exists" — no duplicate insert attempted');
  else bad('createCustomer created a duplicate row for an identity that already exists');
  const rowCountCheck = await owner_reconnect_and_count(PORT, NEW_EMAIL);
  if (rowCountCheck === 1) ok('PostgreSQL confirms exactly ONE row exists for the new identity (no duplicate)');
  else bad(`expected exactly 1 row for the new identity, found ${rowCountCheck}`);

  step('Real connector: controlled column creation (real ALTER TABLE)');
  const col = await connector.createColumn(customersHandle.handle, 'pan_number', 'text');
  if (col.created) ok('createColumn ran a real ALTER TABLE ADD COLUMN'); else bad('createColumn did not report success');
  const fieldsAfter = await connector.listFields(customersHandle.handle);
  if (fieldsAfter.fields.some((f) => f.name === 'pan_number')) ok('the new column is now visible via listFields — the ALTER really happened');
  else bad('the new column did not appear after creation');

  try {
    await connector.createColumn(customersHandle.handle, 'pan_number', 'text'); // already exists now
    bad('creating a column that already exists should have been rejected');
  } catch (e) {
    if (e.code === 'COLUMN_ALREADY_EXISTS') ok('re-creating the same column was rejected — COLUMN_ALREADY_EXISTS');
    else bad(`unexpected error for duplicate column: ${e.code}`);
  }

  step('The READ-ONLY credential cannot write (no write credential configured)');
  const readOnlyConnector = new DatabaseConnector(postgresDialect, () => realDbClientFactory('postgresql', readConn), {
    identityColumn: 'email',
    writableColumns: ['mobile'],
    // NO makeWriteClient — must fail closed.
  });
  const roDisc = await readOnlyConnector.discover();
  const roHandle = roDisc.handles.find((h) => h.descriptor.label === 'public.customers');
  const roFound = await readOnlyConnector.resolveCustomer(roHandle.handle, SENTINEL_EMAIL);
  try {
    await readOnlyConnector.writeCustomerFields(roFound.customerRef, { mobile: '1' });
    bad('a connector with no write credential should not be able to write');
  } catch (e) {
    if (e.code === 'WRITE_NOT_CONFIGURED') ok('write attempt with no privileged credential configured fails closed — WRITE_NOT_CONFIGURED');
    else bad(`unexpected error: ${e.code}`);
  }

  step('Invalid write credentials fail SAFELY (sanitized, no leak)');
  const badWriteConnector = new DatabaseConnector(postgresDialect, () => realDbClientFactory('postgresql', readConn), {
    identityColumn: 'email',
    writableColumns: ['mobile'],
    makeWriteClient: () => realDbClientFactory('postgresql', { ...writeConn, password: 'WRONG_PASSWORD' }),
  });
  const bwDisc = await badWriteConnector.discover();
  const bwHandle = bwDisc.handles.find((h) => h.descriptor.label === 'public.customers');
  const bwFound = await badWriteConnector.resolveCustomer(bwHandle.handle, SENTINEL_EMAIL);
  try {
    await badWriteConnector.writeCustomerFields(bwFound.customerRef, { mobile: '2' });
    bad('invalid write credentials did NOT fail');
  } catch (e) {
    if (e.code === 'PERMISSION_DENIED' && e.message === 'PERMISSION_DENIED' && !/WRONG_PASSWORD|dpdp_write/i.test(String(e.message))) {
      ok('invalid write credentials → sanitized PERMISSION_DENIED (no password/user leaked)');
    } else bad(`invalid-cred error not sanitized: ${e.message}`);
  }

  step('Credentials + identity values never appear in any connector output');
  const dump = JSON.stringify({ disc, found, notFound, writeRes, created, dup, col, fieldsAfter });
  const leaks = [READ_PW, WRITE_PW, 'dpdp_read', 'dpdp_write', SENTINEL_EMAIL, NEW_EMAIL, '9999999999', '9812345678'].filter((s) => dump.includes(s));
  if (leaks.length === 0) ok('no credential and no customer VALUE (identity/mobile) appears in any connector response');
  else bad(`leaked into connector output: ${leaks.join(', ')}`);

  await connector.close();
  await readOnlyConnector.close();
  await badWriteConnector.close().catch(() => undefined);
  console.error(process.exitCode ? '\nFAILED' : '\nPHASE-3G-2 REAL-POSTGRESQL CUSTOMER-OPS E2E VERIFIED');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  try { await epg.stop(); } catch { /* ignore */ }
  rmSync(DATA_DIR, { recursive: true, force: true });
}

async function owner_reconnect_and_check(port, email, expectedMobile) {
  const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'custops' });
  await c.connect();
  const { rows } = await c.query('SELECT mobile FROM public.customers WHERE email = $1', [email]);
  await c.end();
  return rows[0]?.mobile === expectedMobile;
}
async function owner_reconnect_and_count(port, email) {
  const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'custops' });
  await c.connect();
  const { rows } = await c.query('SELECT count(*)::int AS n FROM public.customers WHERE email = $1', [email]);
  await c.end();
  return rows[0]?.n;
}
