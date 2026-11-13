import { Client } from 'pg';
import { pgConnectionOptions } from './database/pg-tls';

/**
 * One-off: create the application's database roles on a NEW managed database.
 *
 *   node dist/db-bootstrap.js          (in the backend image, as an ECS one-off task)
 *
 * The same steps as docs/managed-postgres-setup.sql, but runnable from inside
 * the VPC — an RDS instance in private subnets cannot be reached from a laptop,
 * and the backend image already has Node, `pg` and the RDS CA bundle. Run it
 * once, BEFORE the migration task. Idempotent: running it again changes
 * nothing except re-applying the two passwords.
 *
 * Environment (all required):
 *   DB_HOST, DB_PORT, DB_NAME     where the database is
 *   DB_ADMIN_USER                 the RDS master user name
 *   DB_ADMIN_PASSWORD   (secret)  its password
 *   DPDP_OWNER_PASSWORD (secret)  password to set for dpdp_owner (migrations)
 *   DPDP_APP_PASSWORD   (secret)  password to set for dpdp_app (runtime, RLS)
 *   DATABASE_SSL_CA_FILE          optional; verify the server certificate
 *
 * Secrets arrive only through the environment — never on a command line — and
 * are never printed. Passwords are sent as escaped SQL literals because
 * CREATE/ALTER ROLE cannot take bind parameters.
 */
const REQUIRED = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_ADMIN_USER',
  'DB_ADMIN_PASSWORD',
  'DPDP_OWNER_PASSWORD',
  'DPDP_APP_PASSWORD',
] as const;

async function main(): Promise<void> {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}.`);
    process.exit(2);
  }
  const env = process.env as Record<(typeof REQUIRED)[number], string>;
  const url =
    `postgresql://${encodeURIComponent(env.DB_ADMIN_USER)}:${encodeURIComponent(env.DB_ADMIN_PASSWORD)}` +
    `@${env.DB_HOST}:${env.DB_PORT}/${encodeURIComponent(env.DB_NAME)}`;

  const client = new Client({
    ...pgConnectionOptions(url, process.env.DATABASE_SSL_CA_FILE),
    application_name: 'dpdp-db-bootstrap',
  });
  await client.connect();
  try {
    const db = client.escapeIdentifier(env.DB_NAME);

    // 1. The two roles. Never superuser, never BYPASSRLS: RLS must apply to both.
    for (const role of ['dpdp_owner', 'dpdp_app']) {
      const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (!rowCount) {
        await client.query(
          `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
        console.log(`Created role ${role}.`);
      }
    }
    await client.query(
      `ALTER ROLE dpdp_owner PASSWORD ${client.escapeLiteral(env.DPDP_OWNER_PASSWORD)}`,
    );
    await client.query(
      `ALTER ROLE dpdp_app PASSWORD ${client.escapeLiteral(env.DPDP_APP_PASSWORD)}`,
    );

    // 2. The admin must be a member of dpdp_owner to create objects owned by it.
    await client.query('GRANT dpdp_owner TO CURRENT_USER');

    // 3. Database-level rights. CREATE is needed once, by pg-boss's first install
    //    (see docs/managed-postgres-setup.sql for why).
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO dpdp_owner, dpdp_app`);
    await client.query(`GRANT CREATE ON DATABASE ${db} TO dpdp_owner`);

    // 4. Schemas: `app` owned by dpdp_owner; `public` usable by both.
    await client.query('CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION dpdp_owner');
    await client.query('GRANT USAGE, CREATE ON SCHEMA public TO dpdp_owner');
    await client.query('GRANT USAGE ON SCHEMA public TO dpdp_app');

    // 5. Verify: neither role may bypass RLS.
    const { rows } = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolname IN ('dpdp_owner', 'dpdp_app') ORDER BY rolname`,
    );
    for (const r of rows) {
      console.log(`${r.rolname}: superuser=${r.rolsuper} bypassrls=${r.rolbypassrls}`);
    }
    if (rows.length !== 2 || rows.some((r) => r.rolsuper || r.rolbypassrls)) {
      throw new Error('A DPDP role is missing, or is a superuser / bypasses RLS.');
    }
    console.log('Database bootstrap complete. Next: run the migration task.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // The error message only: never the connection string or a password.
  console.error(`Database bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
