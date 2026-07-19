/* eslint-disable */
'use strict';
// One-time, out-of-band provisioning for the pg-boss engine (S3) on managed
// Postgres, exactly as pgboss.service.ts documents: dpdp_owner cannot CREATE a
// schema on Supabase, so the project superuser grants it the right and pre-makes
// the schema. Idempotent.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const env = {};
for (const line of fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const superUrl =
  `postgresql://${encodeURIComponent(env.POSTGRES_USER)}:${encodeURIComponent(env.POSTGRES_PASSWORD)}` +
  `@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}?sslmode=no-verify`;

// The owner role name, parsed out of DATABASE_URL (strip the Supabase ".project" suffix).
const ownerFull = decodeURIComponent(new URL(env.DATABASE_URL.replace('postgresql://', 'http://')).username);
const ownerRole = ownerFull.split('.')[0]; // dpdp_owner

(async () => {
  const c = new Client({ connectionString: superUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Connected as superuser:', (await c.query('select current_user')).rows[0].current_user);
  await c.query(`GRANT CREATE ON DATABASE ${env.POSTGRES_DB} TO ${ownerRole}`);
  await c.query(`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${ownerRole}`);
  await c.query(`GRANT ALL ON SCHEMA pgboss TO ${ownerRole}`);
  console.log(`Granted CREATE on ${env.POSTGRES_DB} and provisioned schema pgboss (owner ${ownerRole}).`);
  await c.end();
})().catch((e) => { console.error('PROVISION FAILED:', e.message); process.exit(1); });
