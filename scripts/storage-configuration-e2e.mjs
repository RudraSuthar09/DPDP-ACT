/**
 * Storage & Folder Mapping foundation — REAL PostgreSQL verification: the
 * migration applies cleanly on the FULL chain, tenant isolation (RLS) holds
 * across storage_roots/storage_folders/storage_mappings, the whole
 * configure -> close connection -> reopen -> still there lifecycle survives
 * (the practical equivalent of "close DPDP, restart, reopen" since the
 * central Postgres — not any app/container state — is what is being
 * proven), folder creation/browsing, mapping create/change/deactivate, the
 * Gateway<->root binding rule, and that no customer-data-shaped column or
 * value exists anywhere in these tables.
 *
 *   node scripts/storage-configuration-e2e.mjs
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
const PORT = Number(process.env.E2E_DB_PORT ?? 54372);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dpdp-e2e-storage-'));
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
  for (const table of ['storage_roots', 'storage_folders', 'storage_mappings']) {
    const { rows } = await owner.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [table]);
    if (rows.length === 1) ok(`${table} exists after migration`); else bad(`${table} missing`);
  }
  const forbiddenCols = await owner.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name IN ('storage_roots','storage_folders','storage_mappings')
       AND column_name ~* 'password|secret|api_key|content|file_data|customer|document'
  `);
  if (forbiddenCols.rows.length === 0) ok('no customer-data/secret-shaped column exists on any storage table');
  else bad(`forbidden-looking column(s): ${JSON.stringify(forbiddenCols.rows)}`);
  await owner.end();

  step('Seed two tenants + a Gateway device (real bootstrap tables)');
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
  const deviceA = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO gateway_devices (public_key, platform, agent_version, display_name, enrolled_by) VALUES ('PKA','windows','0.1.0','GW-A',$1) RETURNING id",
      [userA],
    ),
  )).rows[0].id;
  ok('seeded two tenants + a user + an active Gateway device for tenant A');

  step('SaaS: a LOCAL storage root needs no Gateway at all');
  const rootLocal = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO storage_roots (name, provider, root_path, created_by) VALUES ('DPDP','local','D:\\DPDP',$1) RETURNING id",
      [userA],
    ),
  )).rows[0].id;
  ok('local storage root created (SaaS path, no gateway_device_id)');

  step('Enterprise: a GATEWAY storage root binds to the tenant\'s own Gateway device');
  const rootGateway = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO storage_roots (name, provider, gateway_device_id, created_by) VALUES ('Enterprise DPDP','gateway',$1,$2) RETURNING id",
      [deviceA, userA],
    ),
  )).rows[0].id;
  ok('gateway-bound storage root created and points at the real device row');

  let rejectedMismatch = false;
  try {
    await asTenant(tenA, (c) => c.query("INSERT INTO storage_roots (name, provider) VALUES ('Bad','gateway')"));
  } catch (e) {
    rejectedMismatch = /storage_roots_provider_binding/.test(String(e.message)) || e.code === '23514';
  }
  if (rejectedMismatch) ok('the database itself rejects provider=gateway with no gateway_device_id (CHECK constraint)');
  else bad('a gateway root with no device was NOT rejected — the CHECK constraint did not fire');

  step('Folder creation, browsing, and nesting');
  const folderCustomers = (await asTenant(tenA, (c) =>
    c.query("INSERT INTO storage_folders (storage_root_id, name, created_by) VALUES ($1,'Customers',$2) RETURNING id", [rootLocal, userA]),
  )).rows[0].id;
  const folderConsent = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO storage_folders (storage_root_id, parent_folder_id, name, created_by) VALUES ($1,$2,'Consent',$3) RETURNING id",
      [rootLocal, folderCustomers, userA],
    ),
  )).rows[0].id;
  const browsed = await asTenant(tenA, (c) => c.query('SELECT name, parent_folder_id FROM storage_folders WHERE storage_root_id = $1 ORDER BY name', [rootLocal]));
  if (browsed.rows.length === 2 && browsed.rows.some((r) => r.name === 'Consent' && r.parent_folder_id === folderCustomers)) {
    ok('newly created folder ("Consent" nested under "Customers") appears when browsing again');
  } else bad('folder browse did not reflect the created nested folder');

  step('Mapping create, persistence, modification, and deactivation');
  const formId = randomUUID(); // stands in for a Consent Template id — this module never dereferences it
  const mapping1 = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO storage_mappings (module_key, entity_id, folder_id, created_by) VALUES ('consent_form',$1,$2,$3) RETURNING id",
      [formId, folderConsent, userA],
    ),
  )).rows[0].id;
  ok('mapping created: consent_form/<template> -> Consent folder');

  const readBack1 = await asTenant(tenA, (c) => c.query('SELECT folder_id FROM storage_mappings WHERE id = $1', [mapping1]));
  if (readBack1.rows[0].folder_id === folderConsent) ok('mapping persists exactly as saved (read from a FRESH connection)');
  else bad('mapping did not round-trip on a fresh connection');

  await asTenant(tenA, (c) => c.query('UPDATE storage_mappings SET folder_id = $2 WHERE id = $1', [mapping1, folderCustomers]));
  const readBack2 = await asTenant(tenA, (c) => c.query('SELECT folder_id, status FROM storage_mappings WHERE id = $1', [mapping1]));
  if (readBack2.rows[0].folder_id === folderCustomers) ok('mapping modification (Folder A -> Folder B) is reflected in the DB');
  else bad('mapping modification did not persist');

  await asTenant(tenA, (c) => c.query("UPDATE storage_mappings SET status = 'inactive' WHERE id = $1", [mapping1]));
  const readBack3 = await asTenant(tenA, (c) => c.query('SELECT status FROM storage_mappings WHERE id = $1', [mapping1]));
  if (readBack3.rows[0].status === 'inactive') ok('mapping removal (deactivate) is reflected — no longer active');
  else bad('mapping deactivation did not persist');

  step('Persistence across a fresh connection ("close DPDP, restart, reopen")');
  // A brand-new client, a brand-new session — nothing carried over except what
  // is in PostgreSQL itself. This is the literal proof the central DB (not
  // React state, not localStorage, not container filesystem) is the source
  // of truth for the whole configure -> reopen lifecycle.
  const reopened = await asTenant(tenA, (c) =>
    c.query(
      `SELECT r.name AS root_name, f.name AS folder_name
         FROM storage_roots r JOIN storage_folders f ON f.storage_root_id = r.id
        WHERE r.id = $1 AND f.id = $2`,
      [rootLocal, folderConsent],
    ),
  );
  if (reopened.rows.length === 1 && reopened.rows[0].root_name === 'DPDP' && reopened.rows[0].folder_name === 'Consent') {
    ok('storage root + folder configuration survives closing and reopening the connection entirely');
  } else bad('configuration did not survive a fresh connection/session');

  step('Tenant isolation (RLS) across all three storage tables');
  const userB = (await asTenant(tenB, (c) =>
    c.query(
      "INSERT INTO users (tenant_id, email, full_name, password_hash, role, status) VALUES ($1,'b@e2e.test','B','x','owner','active') RETURNING id",
      [tenB],
    ),
  )).rows[0].id;
  const crossRoots = await asTenant(tenB, (c) => c.query('SELECT * FROM storage_roots'));
  const crossFolders = await asTenant(tenB, (c) => c.query('SELECT * FROM storage_folders'));
  const crossMappings = await asTenant(tenB, (c) => c.query('SELECT * FROM storage_mappings'));
  if (crossRoots.rows.length === 0 && crossFolders.rows.length === 0 && crossMappings.rows.length === 0) {
    ok('tenant B sees ZERO of tenant A\'s storage roots/folders/mappings (RLS)');
  } else bad('cross-tenant storage row leaked!');

  let crossTenantDeviceRejected = false;
  try {
    await asTenant(tenB, (c) =>
      c.query("INSERT INTO storage_roots (name, provider, gateway_device_id, created_by) VALUES ('Hijack','gateway',$1,$2)", [deviceA, userB]),
    );
  } catch (e) {
    // The tenant-binding TRIGGER (app.check_storage_root_gateway_device_tenant)
    // is the actual enforcement here — its own SELECT against gateway_devices
    // is RLS-scoped, so tenant A's device id looks like it doesn't exist at
    // all from tenant B's session. A plain FK does NOT get this for free (its
    // referential-integrity check does not apply RLS), which is exactly why
    // the trigger exists.
    crossTenantDeviceRejected = /does not belong to this tenant/i.test(String(e.message));
  }
  if (crossTenantDeviceRejected) ok('tenant B cannot bind a storage root to tenant A\'s Gateway device (RLS-scoped FK check)');
  else bad('tenant B was able to reference tenant A\'s Gateway device!');

  // Tenant B independently configures its OWN storage — proves the model
  // works per-tenant, not globally, and SaaS-only (no Gateway) tenants work.
  const rootB = (await asTenant(tenB, (c) =>
    c.query("INSERT INTO storage_roots (name, provider, created_by) VALUES ('DPDP','local',$1) RETURNING id", [userB]),
  )).rows[0].id;
  const folderB = (await asTenant(tenB, (c) =>
    c.query("INSERT INTO storage_folders (storage_root_id, name, created_by) VALUES ($1,'Employees',$2) RETURNING id", [rootB, userB]),
  )).rows[0].id;
  await asTenant(tenB, (c) =>
    c.query("INSERT INTO storage_mappings (module_key, entity_id, folder_id, created_by) VALUES ('consent_form',$1,$2,$3)", [randomUUID(), folderB, userB]),
  );
  ok('tenant B independently configured its own storage root/folder/mapping — fully SaaS, no Gateway involved');

  step('No customer value / credential anywhere in the persisted rows');
  const dumpA = JSON.stringify((await asTenant(tenA, (c) => c.query('SELECT * FROM storage_roots WHERE id = $1', [rootLocal]))).rows[0]);
  const dumpFolder = JSON.stringify((await asTenant(tenA, (c) => c.query('SELECT * FROM storage_folders WHERE id = $1', [folderConsent]))).rows[0]);
  const dumpMapping = JSON.stringify((await asTenant(tenA, (c) => c.query('SELECT * FROM storage_mappings WHERE id = $1', [mapping1]))).rows[0]);
  const leaks = [APP_PW, OWNER_PW, 'password'].filter((s) => (dumpA + dumpFolder + dumpMapping).toLowerCase().includes(s.toLowerCase()));
  if (leaks.length === 0) ok('no password/credential text found in any persisted storage row');
  else bad(`leak: ${leaks.join(', ')}`);

  console.error(process.exitCode ? '\nFAILED' : '\nSTORAGE & FOLDER MAPPING REAL-POSTGRESQL E2E VERIFIED');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  try { await epg.stop(); } catch { /* ignore */ }
  rmSync(DATA_DIR, { recursive: true, force: true });
}
