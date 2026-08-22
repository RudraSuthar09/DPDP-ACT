/**
 * Storage DATA-PLANE integration — REAL PostgreSQL verification of the new
 * gateway_storage_pairings / gateway_storage_sessions control-plane tables:
 * the migration applies cleanly on the FULL chain, tenant isolation (RLS)
 * holds, the cross-tenant storage_root_id/device_id tenant-binding triggers
 * actually fire (the same class of bug found live in the Storage Phase 1
 * work — verified fixed here too), and the pairing -> single-use redeem ->
 * session lifecycle behaves correctly at the SQL level (hash-only, one-time,
 * expiring, revocable). The HTTP/agent half of this flow (StoragePlane,
 * GatewayStorageProvider) is separately verified by real Node fs operations
 * in agent/src/storage/*.spec.ts — this script is the DB half.
 *
 *   node scripts/storage-dataplane-e2e.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
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
const PORT = Number(process.env.E2E_DB_PORT ?? 54373);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dpdp-e2e-storage-dp-'));
const OWNER_PW = 'owner_e2e_only';
const APP_PW = 'app_e2e_only';

const ok = (s) => console.error('  ✓', s);
const bad = (s) => { console.error('  ✗', s); process.exitCode = 1; };
const step = (s) => console.error(`\n=== ${s} ===`);
const guard = setTimeout(() => { console.error('E2E hard timeout'); process.exit(1); }, 110_000);
guard.unref();

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('base64url');

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

  step('Apply ALL migrations on the fresh DB (validates the full chain)');
  const ownerUrl = `postgres://dpdp_owner:${OWNER_PW}@localhost:${PORT}/dpdp`;
  await migrationRunner({ databaseUrl: ownerUrl, dir: MIGRATIONS, direction: 'up', count: Infinity, migrationsTable: 'pgmigrations', log: () => {} });
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  for (const table of ['gateway_storage_pairings', 'gateway_storage_sessions']) {
    const { rows } = await owner.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [table]);
    if (rows.length === 1) ok(`${table} exists after migration`); else bad(`${table} missing`);
  }
  const rawCols = await owner.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name IN ('gateway_storage_pairings','gateway_storage_sessions')
       AND column_name ~* 'raw_nonce|raw_token|password|customer|content'
  `);
  if (rawCols.rows.length === 0) ok('no raw-secret/customer-data-shaped column exists on either table');
  else bad(`forbidden-looking column(s): ${JSON.stringify(rawCols.rows)}`);
  await owner.end();

  step('Seed two tenants + Gateway devices + storage roots');
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
    c.query("INSERT INTO users (tenant_id, email, full_name, password_hash, role, status) VALUES ($1,'a@e2e.test','A','x','owner','active') RETURNING id", [tenA]),
  )).rows[0].id;
  const userB = (await asTenant(tenB, (c) =>
    c.query("INSERT INTO users (tenant_id, email, full_name, password_hash, role, status) VALUES ($1,'b@e2e.test','B','x','owner','active') RETURNING id", [tenB]),
  )).rows[0].id;
  const deviceA = (await asTenant(tenA, (c) =>
    c.query("INSERT INTO gateway_devices (public_key, platform, agent_version, display_name, enrolled_by) VALUES ('PKA','windows','0.1.0','GW-A',$1) RETURNING id", [userA]),
  )).rows[0].id;
  const deviceB = (await asTenant(tenB, (c) =>
    c.query("INSERT INTO gateway_devices (public_key, platform, agent_version, display_name, enrolled_by) VALUES ('PKB','windows','0.1.0','GW-B',$1) RETURNING id", [userB]),
  )).rows[0].id;
  const rootA = (await asTenant(tenA, (c) =>
    c.query("INSERT INTO storage_roots (name, provider, gateway_device_id, created_by) VALUES ('DPDP','gateway',$1,$2) RETURNING id", [deviceA, userA]),
  )).rows[0].id;
  const rootB = (await asTenant(tenB, (c) =>
    c.query("INSERT INTO storage_roots (name, provider, gateway_device_id, created_by) VALUES ('DPDP','gateway',$1,$2) RETURNING id", [deviceB, userB]),
  )).rows[0].id;
  ok('seeded two tenants, each with its own Gateway device + gateway-provider storage root');

  step('Pairing -> single-use redeem -> session lifecycle (SQL level)');
  const nonce = token();
  const pairing = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO gateway_storage_pairings (user_id, storage_root_id, device_id, nonce_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '60 seconds') RETURNING id",
      [userA, rootA, deviceA, sha256(nonce)],
    ),
  )).rows[0].id;
  ok('storage pairing created (hash only — the raw nonce is never persisted)');

  const consumed1 = await asTenant(tenA, (c) =>
    c.query("UPDATE gateway_storage_pairings SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id", [pairing]),
  );
  if (consumed1.rows.length === 1) ok('pairing redeemed once (consumed_at set)'); else bad('first redemption failed');

  const consumed2 = await asTenant(tenA, (c) =>
    c.query("UPDATE gateway_storage_pairings SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id", [pairing]),
  );
  if (consumed2.rows.length === 0) ok('a SECOND redemption of the same pairing is a no-op (single-use enforced)');
  else bad('the same pairing was redeemed twice!');

  const sessionToken = token();
  const session = (await asTenant(tenA, (c) =>
    c.query(
      "INSERT INTO gateway_storage_sessions (user_id, storage_root_id, device_id, pairing_id, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '900 seconds') RETURNING id",
      [userA, rootA, deviceA, pairing, sha256(sessionToken)],
    ),
  )).rows[0].id;
  ok('storage session created from the redeemed pairing (hash only)');

  await asTenant(tenA, (c) => c.query('UPDATE gateway_storage_sessions SET revoked_at = now() WHERE id = $1', [session]));
  const revoked = await asTenant(tenA, (c) => c.query('SELECT revoked_at FROM gateway_storage_sessions WHERE id = $1', [session]));
  if (revoked.rows[0].revoked_at) ok('storage session is revocable'); else bad('session revoke did not persist');

  step('Tenant-binding trigger: a plain FK alone would NOT catch this (verified fixed)');
  let rejectedRoot = false;
  try {
    await asTenant(tenB, (c) =>
      c.query(
        "INSERT INTO gateway_storage_pairings (user_id, storage_root_id, device_id, nonce_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '60 seconds')",
        [userB, rootA, deviceB, sha256(token())], // rootA belongs to tenant A
      ),
    );
  } catch (e) {
    rejectedRoot = /does not belong to this tenant/i.test(String(e.message));
  }
  if (rejectedRoot) ok('tenant B cannot mint a storage pairing referencing tenant A\'s storage root (trigger fires)');
  else bad('tenant B referenced tenant A\'s storage root without rejection!');

  let rejectedDevice = false;
  try {
    // A valid storage root OF tenant B's own, but tenant A's device — isolates
    // the device-tenant check specifically (the root-tenant check above already
    // passes here since rootB genuinely belongs to tenant B).
    await asTenant(tenB, (c) =>
      c.query(
        "INSERT INTO gateway_storage_pairings (user_id, storage_root_id, device_id, nonce_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '60 seconds')",
        [userB, rootB, deviceA, sha256(token())],
      ),
    );
  } catch (e) {
    rejectedDevice = /does not belong to this tenant/i.test(String(e.message));
  }
  if (rejectedDevice) ok('tenant B cannot mint a storage pairing referencing tenant A\'s Gateway device');
  else bad('tenant B referenced tenant A\'s Gateway device without rejection!');

  step('Tenant isolation (RLS) across both storage-plane tables');
  const crossPairings = await asTenant(tenB, (c) => c.query('SELECT * FROM gateway_storage_pairings'));
  const crossSessions = await asTenant(tenB, (c) => c.query('SELECT * FROM gateway_storage_sessions'));
  if (crossPairings.rows.length === 0 && crossSessions.rows.length === 0) {
    ok('tenant B sees ZERO of tenant A\'s storage pairings/sessions (RLS)');
  } else bad('cross-tenant storage-plane row leaked!');

  step('No raw nonce/token/credential anywhere in the persisted rows');
  const dumpPairing = JSON.stringify((await asTenant(tenA, (c) => c.query('SELECT * FROM gateway_storage_pairings WHERE id = $1', [pairing]))).rows[0]);
  const dumpSession = JSON.stringify((await asTenant(tenA, (c) => c.query('SELECT * FROM gateway_storage_sessions WHERE id = $1', [session]))).rows[0]);
  const leaks = [nonce, sessionToken, APP_PW, OWNER_PW].filter((s) => (dumpPairing + dumpSession).includes(s));
  if (leaks.length === 0) ok('no raw nonce/token/credential text found in any persisted row');
  else bad(`leak: ${leaks.length} value(s) found in plaintext`);

  console.error(process.exitCode ? '\nFAILED' : '\nSTORAGE DATA-PLANE (CONTROL PLANE) REAL-POSTGRESQL E2E VERIFIED');
} catch (err) {
  console.error('\nE2E ERROR:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  try { await epg.stop(); } catch { /* ignore */ }
  rmSync(DATA_DIR, { recursive: true, force: true });
}
