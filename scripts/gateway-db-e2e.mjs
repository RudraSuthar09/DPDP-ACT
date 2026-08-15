/**
 * Phase 3F — REAL PostgreSQL end-to-end validation for the Gateway DB connector.
 *
 * Spins up a genuine PostgreSQL (embedded-postgres, no Docker), applies ALL
 * platform migrations (proving the Phase-3C Gateway migration applies cleanly on
 * a fresh database), then drives the ACTUAL agent DatabaseConnector against real
 * customer rows and asserts:
 *   - connect / discover / read of an authorized table works on a real DB,
 *   - row limits are enforced,
 *   - invalid credentials fail with a SANITIZED error (no password/host leak),
 *   - credentials never appear in any connector output,
 *   - rows come straight from the DB via the driver — no backend/HTTP hop.
 *
 *   node scripts/gateway-db-e2e.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'backend', 'migrations');
// node-pg-migrate is a backend dependency — resolve it from there.
const backendRequire = createRequire(join(ROOT, 'backend', 'package.json'));
const npm = backendRequire('node-pg-migrate');
const migrationRunner = npm.default ?? npm;
const PORT = Number(process.env.E2E_DB_PORT ?? 54329);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dpdp-e2e-pg-'));
const OWNER_PW = 'owner_e2e_only';
const APP_PW = 'app_e2e_only';

const { DatabaseConnector } = await import(new URL('../agent/dist/connectors/db/database-connector.js', import.meta.url));
const { postgresDialect } = await import(new URL('../agent/dist/connectors/db/dialect.js', import.meta.url));
const { realDbClientFactory } = await import(new URL('../agent/dist/connectors/db/db-client.js', import.meta.url));

const SENTINEL = `AADHAAR_${Date.now().toString().slice(-10)}`;
const ok = (s) => console.error('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.error(`\n=== ${s} ===`);
// Never hang the sandbox — force an exit (flushing output) if something stalls.
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
  await admin.query('CREATE DATABASE dpdp');
  await admin.query(`CREATE ROLE dpdp_owner LOGIN PASSWORD '${OWNER_PW}' NOSUPERUSER CREATEROLE NOBYPASSRLS`);
  await admin.query(`CREATE ROLE dpdp_app LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  // Make dpdp_owner own the DB (exactly as `pnpm db:local` does) so the bootstrap
  // migration can CREATE the `app` schema and the public tables.
  await admin.query('ALTER DATABASE dpdp OWNER TO dpdp_owner');
  await admin.query('GRANT CONNECT ON DATABASE dpdp TO dpdp_owner, dpdp_app');
  await admin.end();

  const asAdminDpdp = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'dpdp' });
  await asAdminDpdp.connect();
  await asAdminDpdp.query('GRANT ALL ON SCHEMA public TO dpdp_owner');
  await asAdminDpdp.query('GRANT USAGE ON SCHEMA public TO dpdp_app');
  await asAdminDpdp.end();

  step('Apply ALL migrations on the fresh DB (validates the Gateway migration)');
  const ownerUrl = `postgres://dpdp_owner:${OWNER_PW}@localhost:${PORT}/dpdp`;
  await migrationRunner({ databaseUrl: ownerUrl, dir: MIGRATIONS, direction: 'up', count: Infinity, migrationsTable: 'pgmigrations', log: () => {} });
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const gw = await owner.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'gateway_%' ORDER BY table_name",
  );
  const gwTables = gw.rows.map((r) => r.table_name);
  const want = ['gateway_devices', 'gateway_enrollments', 'gateway_pairings', 'gateway_sessions'];
  if (want.every((t) => gwTables.includes(t))) ok(`Gateway migration applied — tables present: ${gwTables.join(', ')}`);
  else bad(`Gateway tables missing. Got: ${gwTables.join(', ')}`);

  step('Seed a real customer table + grant read-only access');
  await owner.query('CREATE TABLE public.customers (id int, name text, aadhaar text, email text)');
  await owner.query('INSERT INTO public.customers VALUES (1,$1,$2,$3),(2,$4,$5,$6),(3,$7,$8,$9)', [
    'Asha Rao', SENTINEL, 'asha@example.com',
    'Ravi Kumar', '111122223333', 'ravi@example.com',
    'Meera Nair', '444455556666', 'meera@example.com',
  ]);
  await owner.query('GRANT SELECT ON public.customers TO dpdp_app');
  await owner.end();

  // --- the REAL connector, connecting to the REAL database ---
  const conn = { host: 'localhost', port: PORT, user: 'dpdp_app', password: APP_PW, database: 'dpdp' };
  const connector = new DatabaseConnector(postgresDialect, () => realDbClientFactory('postgresql', conn));

  step('Real connector: healthCheck / discover / read');
  const health = await connector.healthCheck();
  if (health.status === 'ok') ok('healthCheck connected to the real DB'); else bad('healthCheck failed');

  const disc = await connector.discover();
  const customers = disc.handles.find((h) => h.descriptor.label === 'public.customers');
  if (customers) ok(`discover found public.customers (opaque handle: ${customers.handle.slice(0, 8)}…)`); else bad('discover did not find customers');
  if (customers && !customers.handle.includes('customers')) ok('handle is opaque (not the table name)');

  const read = await connector.read(customers.handle, { limit: 50 });
  if (read.headers.includes('aadhaar') && read.rows.flat().includes(SENTINEL)) ok('read returned REAL customer rows from PostgreSQL'); else bad('read did not return the seeded rows');

  step('Row-limit enforcement');
  const limited = await connector.read(customers.handle, { limit: 2 });
  if (limited.rows.length === 2 && limited.truncated) ok('bounded read honoured limit=2 with truncation'); else bad(`limit not enforced: got ${limited.rows.length} rows`);

  step('Invalid credentials fail SAFELY (sanitized, no leak)');
  const badConn = { ...conn, password: 'WRONG_PASSWORD' };
  const badConnector = new DatabaseConnector(postgresDialect, () => realDbClientFactory('postgresql', badConn));
  try {
    await badConnector.healthCheck();
    bad('invalid credentials did NOT fail');
  } catch (e) {
    if (e.code === 'PERMISSION_DENIED' && e.message === 'PERMISSION_DENIED' && !/WRONG_PASSWORD|password|dpdp_app/i.test(String(e.message))) ok('invalid credentials → sanitized PERMISSION_DENIED (no password/user leaked)');
    else bad(`invalid-cred error not sanitized: ${e.message}`);
  }

  step('Credentials never appear in connector output');
  const dump = JSON.stringify(disc) + JSON.stringify(read) + JSON.stringify(health);
  if (!dump.includes(APP_PW) && !dump.includes('password')) ok('no credential/password in any connector response'); else bad('credential leaked into output');

  await connector.close();
  await badConnector.close().catch(() => undefined);
  console.error(process.exitCode ? '\nFAILED' : '\nPHASE-3F REAL-POSTGRESQL E2E VERIFIED');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  try { await epg.stop(); } catch { /* ignore */ }
  rmSync(DATA_DIR, { recursive: true, force: true });
}
