/**
 * Phase 3G-2.5 — REAL PostgreSQL verification of the persistent Gateway
 * endpoint: migration applies cleanly on the FULL chain, the "one active
 * Gateway per tenant" rule is enforced by the DATABASE (not just app code),
 * the endpoint round-trips, and RLS isolates two tenants' Gateway rows.
 *
 *   node scripts/gateway-endpoint-e2e.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'backend', 'migrations');
const backendRequire = createRequire(join(ROOT, 'backend', 'package.json'));
const npm = backendRequire('node-pg-migrate');
const migrationRunner = npm.default ?? npm;
const PORT = Number(process.env.E2E_DB_PORT ?? 54371);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dpdp-e2e-gwep-'));
const OWNER_PW = 'owner_e2e_only';
const APP_PW = 'app_e2e_only';

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
  await admin.query('CREATE DATABASE dpdp');
  await admin.query(`CREATE ROLE dpdp_owner LOGIN PASSWORD '${OWNER_PW}' NOSUPERUSER CREATEROLE NOBYPASSRLS`);
  await admin.query(`CREATE ROLE dpdp_app LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await admin.query('ALTER DATABASE dpdp OWNER TO dpdp_owner');
  await admin.query('GRANT CONNECT ON DATABASE dpdp TO dpdp_owner, dpdp_app');
  await admin.end();

  const asAdminDpdp = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'dpdp' });
  await asAdminDpdp.connect();
  await asAdminDpdp.query('GRANT ALL ON SCHEMA public TO dpdp_owner');
  await asAdminDpdp.query('GRANT USAGE ON SCHEMA public TO dpdp_app');
  await asAdminDpdp.end();

  step('Apply ALL migrations on the fresh DB (validates the full chain, incl. the new one)');
  const ownerUrl = `postgres://dpdp_owner:${OWNER_PW}@localhost:${PORT}/dpdp`;
  await migrationRunner({ databaseUrl: ownerUrl, dir: MIGRATIONS, direction: 'up', count: Infinity, migrationsTable: 'pgmigrations', log: () => {} });
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const cols = await owner.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='gateway_devices' AND column_name='endpoint'",
  );
  if (cols.rows.length === 1) ok('gateway_devices.endpoint column exists after migration'); else bad('endpoint column missing');
  const idx = await owner.query("SELECT indexname FROM pg_indexes WHERE indexname='gateway_devices_one_active_per_tenant_uq'");
  if (idx.rows.length === 1) ok('the one-active-per-tenant unique index exists'); else bad('unique index missing');
  await owner.end();

  step('Seed two tenants (organisations) via the real bootstrap tables');
  // organisations is FORCE ROW LEVEL SECURITY (even the owner is subject to it),
  // and its own CHECK requires tenant_id = id. So: generate the id client-side
  // and set the GUC to that SAME value for the insert — exactly how real sign-up
  // mints a tenant (TenantDatabaseService.withTenantId).
  const appConn = { host: 'localhost', port: PORT, user: 'dpdp_app', password: APP_PW, database: 'dpdp' };
  async function asTenant(tenantId, fn) {
    const c = new pg.Client(appConn);
    await c.connect();
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    try {
      return await fn(c);
    } finally {
      await c.query('COMMIT');
      await c.end();
    }
  }
  const tenA = randomUUID();
  const tenB = randomUUID();
  await asTenant(tenA, (c) => c.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1,$1,$2)', [tenA, 'Tenant A E2E']));
  await asTenant(tenB, (c) => c.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1,$1,$2)', [tenB, 'Tenant B E2E']));
  const userA = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO users (tenant_id, email, full_name, password_hash, role, status) VALUES ($1,'a@e2e.test','A','x','owner','active') RETURNING id",
      [tenA],
    ),
  )).rows[0].id;
  ok('seeded two tenants + a user (matching the real tenant_id=id sign-up shape)');

  step('Real Postgres: one ACTIVE Gateway per tenant is enforced by the database');

  const deviceA1 = await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO gateway_devices (public_key, platform, agent_version, display_name, enrolled_by) VALUES ('PK1','windows','0.1.0','GW-A1',$1) RETURNING id",
      [userA],
    ),
  );
  ok('first active device for tenant A created');

  let secondActiveRejected = false;
  try {
    await asTenant(tenA, (c) =>
      c.query(
        "INSERT INTO gateway_devices (public_key, platform, agent_version, display_name, enrolled_by) VALUES ('PK2','windows','0.1.0','GW-A2',$1) RETURNING id",
        [userA],
      ),
    );
  } catch (e) {
    secondActiveRejected = /gateway_devices_one_active_per_tenant_uq/.test(String(e.message)) || e.code === '23505';
  }
  if (secondActiveRejected) ok('a SECOND active device for the SAME tenant is rejected by the database itself (unique violation)');
  else bad('the database allowed two active devices for one tenant — the constraint did not fire');

  // Revoking the first, THEN a second active device is fine (replacement, not duplication).
  await asTenant(tenA, (c) => c.query("UPDATE gateway_devices SET status='revoked' WHERE id=$1", [deviceA1.rows[0].id]));
  const deviceA2 = await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO gateway_devices (public_key, platform, agent_version, display_name, enrolled_by) VALUES ('PK3','windows','0.1.0','GW-A2',$1) RETURNING id",
      [userA],
    ),
  );
  ok('after revoking the first, a replacement active device IS allowed (explicit change, not silent duplication)');

  step('Real Postgres: the endpoint round-trips as plain config (non-secret)');
  const ENDPOINT = 'http://192.168.1.50:7071';
  await asTenant(tenA, (c) => c.query('UPDATE gateway_devices SET endpoint=$2 WHERE id=$1', [deviceA2.rows[0].id, ENDPOINT]));
  const readBack = await asTenant(tenA, (c) => c.query('SELECT endpoint FROM gateway_devices WHERE id=$1', [deviceA2.rows[0].id]));
  if (readBack.rows[0].endpoint === ENDPOINT) ok('endpoint was persisted and reads back exactly as set'); else bad('endpoint did not round-trip');

  step('Real Postgres: RLS isolates tenant B from tenant A\'s Gateway');
  const crossTenantRead = await asTenant(tenB, (c) => c.query('SELECT * FROM gateway_devices'));
  if (crossTenantRead.rows.length === 0) ok('tenant B sees ZERO of tenant A\'s Gateway rows (RLS)'); else bad('cross-tenant Gateway row leaked!');
  // Tenant B may still enroll its OWN active gateway independently.
  const userB = (await asTenant(tenB, (c) =>
    c.query(
      "INSERT INTO users (tenant_id, email, full_name, password_hash, role, status) VALUES ($1,'b@e2e.test','B','x','owner','active') RETURNING id",
      [tenB],
    ),
  )).rows[0].id;
  await asTenant(tenB, (c) =>
    c.query(
      "INSERT INTO gateway_devices (public_key, platform, agent_version, display_name, enrolled_by) VALUES ('PKB','linux','0.1.0','GW-B',$1)",
      [userB],
    ),
  );
  ok('tenant B independently has its own active Gateway — one per tenant, not one globally');

  step('No customer value / DB credential anywhere in the gateway_devices row');
  const finalRow = await asTenant(tenA, (c) => c.query('SELECT * FROM gateway_devices WHERE id=$1', [deviceA2.rows[0].id]));
  const dump = JSON.stringify(finalRow.rows[0]);
  const leaks = ['password', APP_PW, OWNER_PW].filter((s) => dump.toLowerCase().includes(s.toLowerCase()));
  if (leaks.length === 0) ok('no password/credential text found in the persisted Gateway row'); else bad(`leak: ${leaks.join(', ')}`);

  console.error(process.exitCode ? '\nFAILED' : '\nPHASE-3G-2.5 REAL-POSTGRESQL GATEWAY-ENDPOINT E2E VERIFIED');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  try { await epg.stop(); } catch { /* ignore */ }
  rmSync(DATA_DIR, { recursive: true, force: true });
}
