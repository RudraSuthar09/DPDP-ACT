/**
 * One-off provisioning for a platform_admins row (the cross-tenant
 * /admin/licenses support tool — see backend/migrations/1737005100000_
 * platform-admin.sql). Deliberately a CLI script run with the owner DB role
 * (DATABASE_URL), not an API endpoint: there is no public sign-up path for
 * the platform's single most powerful credential.
 *
 *   node scripts/create-platform-admin.mjs <email> <password>
 */
import pg from 'pg';

const { Pool } = pg;
const { ScryptPasswordHasher } = await import(
  new URL('../backend/dist/modules/identity/crypto/password-hasher.js', import.meta.url)
);

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('usage: node scripts/create-platform-admin.mjs <email> <password>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const hasher = new ScryptPasswordHasher();

try {
  const passwordHash = await hasher.hash(password);
  const { rows } = await pool.query(
    `INSERT INTO platform_admins (email, password_hash, password_algo)
     VALUES ($1, $2, 'scrypt')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, email, created_at`,
    [email.trim().toLowerCase(), passwordHash],
  );
  console.log('Platform admin ready:', rows[0]);
} finally {
  await pool.end();
}
