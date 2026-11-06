import PgBoss from 'pg-boss';
import { Client } from 'pg';
import { pgConnectionOptions } from './database/pg-tls';

/**
 * One-off: create (or upgrade) pg-boss's `pgboss` schema, as the OWNER.
 *
 *   node dist/pgboss-install.js          (in the backend image, DATABASE_URL = owner)
 *
 * Why it exists. When pg-boss runs on its least-privilege role (dpdp_jobs,
 * docs/pgboss-least-privilege.sql) it can do everything inside its own schema
 * — but on a database where it has NEVER run, its first step is
 * `CREATE SCHEMA IF NOT EXISTS pgboss`, and PostgreSQL checks the
 * database-level CREATE right before it checks whether the schema exists. So
 * the very first install has to happen as the owner; after that, dpdp_jobs
 * owns everything and handles its own upgrades.
 *
 * Run it from the migration task, after the migrations and BEFORE
 * docs/pgboss-least-privilege.sql, on a new database. Harmless to run again:
 * on an installed, current schema pg-boss changes nothing.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL (the schema owner) is required to install the pg-boss schema.');
    process.exit(2);
  }
  const connection = pgConnectionOptions(url, process.env.DATABASE_SSL_CA_FILE);

  // Once docs/pgboss-least-privilege.sql has handed the schema to its own role,
  // the owner deliberately has no rights on it any more — and that role
  // performs pg-boss's own upgrades when the app starts. So this step has
  // nothing to do, and must not fail: the migration task runs it on every
  // deploy.
  const probe = new Client(connection);
  await probe.connect();
  try {
    const { rows } = await probe.query<{ owner: string; me: string }>(
      `SELECT n.nspowner::regrole::text AS owner, current_user::text AS me FROM pg_namespace n WHERE n.nspname = 'pgboss'`,
    );
    if (rows[0] && rows[0].owner !== rows[0].me) {
      console.log(
        `pg-boss schema is owned by ${rows[0].owner}; it manages its own upgrades. Nothing to do.`,
      );
      return;
    }
  } finally {
    await probe.end();
  }

  const boss = new PgBoss({
    ...connection,
    schema: 'pgboss',
    // Install only: no maintenance or cron loops for this short-lived process.
    supervise: false,
    schedule: false,
    application_name: 'dpdp-pgboss-install',
  });
  boss.on('error', (err) => console.error(`pg-boss: ${String(err)}`));
  await boss.start();
  await boss.stop({ graceful: false, wait: true });
  console.log('pg-boss schema installed and up to date.');
}

main().catch((err) => {
  // The error name and message only: never the connection string.
  console.error(`pg-boss install failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
