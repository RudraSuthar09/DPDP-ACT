/**
 * A real PostgreSQL, locally, with no Docker.
 *
 * `pnpm infra:up` needs Docker Desktop. This is the same thing without it:
 * `embedded-postgres` downloads a genuine PostgreSQL binary and runs it as a
 * child process. It is the exact setup the isolation suite and the end-to-end
 * tests use, so "it runs on my machine" and "it passes CI" mean the same thing.
 *
 *   pnpm db:local        start it (foreground; Ctrl+C to stop)
 *   pnpm db:local:reset  wipe the data directory and start clean
 *
 * Data lives in .localdb/ (gitignored), so it survives restarts.
 *
 * This creates the two roles Seam S1 requires and nothing else — the migrations
 * do the rest, exactly as they would against Supabase or RDS:
 *   dpdp_owner : owns the schema, runs migrations (DDL only)
 *   dpdp_app   : the runtime role, NOSUPERUSER NOBYPASSRLS and NOT the owner,
 *                so Postgres enforces RLS against it. If the app ever connected
 *                as the owner, RLS would be silently bypassed and tenant
 *                isolation (I3) would be gone with no error to tell you.
 */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, '.localdb');
const PORT = Number(process.env.LOCAL_DB_PORT ?? 5432);
const DB = 'dpdp';

// These match .env.example. Local-only, and they never leave this machine.
const OWNER_PASSWORD = 'dpdp_local_dev_only';
const APP_PASSWORD = 'dpdp_app_local_dev_only';

const reset = process.argv.includes('--reset');
const firstRun = reset || !existsSync(DATA_DIR);

if (reset && existsSync(DATA_DIR)) {
  console.log('Wiping .localdb ...');
  rmSync(DATA_DIR, { recursive: true, force: true });
}

const epg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: true,
  onLog: () => {}, // Postgres is chatty; failures still surface below.
});

if (firstRun) {
  console.log('First run - initialising a fresh PostgreSQL cluster (this takes a few seconds)...');
  await epg.initialise();
}

try {
  await epg.start();
} catch (err) {
  console.error(`\nCould not start PostgreSQL on port ${PORT}.`);
  console.error(String(err?.message ?? err));
  console.error(
    `\nIf something else is already using port ${PORT} (an installed PostgreSQL, perhaps),\n` +
      'either stop it, or run this on another port and update .env to match:\n' +
      '   LOCAL_DB_PORT=54322 pnpm db:local',
  );
  process.exit(1);
}

const admin = new pg.Client({
  host: 'localhost',
  port: PORT,
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
});
await admin.connect();

if (firstRun) {
  console.log('Creating the dpdp database and the two Seam S1 roles...');
  await admin.query(`CREATE DATABASE ${DB}`);

  // dpdp_owner owns the schema objects and runs migrations. It gets CREATEROLE
  // locally so the bootstrap migration can create dpdp_app by itself, exactly as
  // it does in CI. (On managed Postgres it cannot, which is why
  // docs/managed-postgres-setup.sql exists.)
  await admin.query(
    `CREATE ROLE dpdp_owner LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER CREATEROLE NOBYPASSRLS`,
  );
  await admin.query(`ALTER DATABASE ${DB} OWNER TO dpdp_owner`);

  // NOSUPERUSER + NOBYPASSRLS is not cosmetic: Postgres silently ignores RLS
  // policies for superusers, BYPASSRLS roles, and (absent FORCE) the table
  // owner. dpdp_app must be none of those or invariant I3 evaporates.
  await admin.query(
    `CREATE ROLE dpdp_app LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  );
  await admin.query(`GRANT CONNECT ON DATABASE ${DB} TO dpdp_owner, dpdp_app`);

  // The migration role needs to create the `app` schema and the public tables.
  const asOwner = new pg.Client({
    host: 'localhost',
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    database: DB,
  });
  await asOwner.connect();
  await asOwner.query('GRANT ALL ON SCHEMA public TO dpdp_owner');
  await asOwner.query('GRANT USAGE ON SCHEMA public TO dpdp_app');
  await asOwner.end();
}

// Prove the isolation precondition on every start, not just the first: if this
// is ever false, every "no cross-tenant rows" result in the suite is a false
// green, and the platform's central promise is unenforced.
const { rows } = await admin.query(
  `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('dpdp_owner','dpdp_app') ORDER BY rolname`,
);
const app = rows.find((r) => r.rolname === 'dpdp_app');
if (!app || app.rolsuper || app.rolbypassrls) {
  console.error('\ndpdp_app must be NOSUPERUSER and NOBYPASSRLS or RLS is not enforced. Aborting.');
  process.exit(1);
}
await admin.end();

console.log(`
PostgreSQL is running on localhost:${PORT}    (data: .localdb/)

  role          rolsuper   rolbypassrls
${rows.map((r) => `  ${r.rolname.padEnd(13)} ${String(r.rolsuper).padEnd(10)} ${r.rolbypassrls}`).join('\n')}

Your .env should point at it:
  DATABASE_URL=postgresql://dpdp_owner:${OWNER_PASSWORD}@localhost:${PORT}/${DB}
  APP_DATABASE_URL=postgresql://dpdp_app:${APP_PASSWORD}@localhost:${PORT}/${DB}

Next, in a SECOND terminal:
  pnpm migrate:up     apply the migrations
  pnpm dev:api        start the API on http://localhost:3001
  pnpm smoke          drive the whole thing end to end and print the audit chain

Leave this window open. Ctrl+C stops the database.
`);

const shutdown = async () => {
  console.log('\nStopping PostgreSQL...');
  try {
    await epg.stop();
  } catch {
    // Already gone; nothing to do.
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Hold the process open so this behaves like `docker compose up`.
setInterval(() => {}, 1 << 30);
