/**
 * One-off provisioning for a platform_admins row (the internal /admin portal
 * — see backend/migrations/1737005100000_platform-admin.sql). Deliberately a
 * CLI script run with the owner DB role (DATABASE_URL), not an API endpoint:
 * there is no public sign-up path for the platform's single most powerful
 * credential. Re-running it for an existing email resets that admin's
 * password.
 *
 *   node scripts/create-platform-admin.mjs <email>
 *
 * The password is never taken from the command line by default (a command
 * line is visible in the process list and shell history). In order:
 *   1. PLATFORM_ADMIN_PASSWORD from the environment, if set;
 *   2. otherwise an interactive, hidden prompt (asked twice);
 *   3. a third positional argument still works, with a warning (legacy).
 * Requirements: at least 14 characters, at least 3 of {lower, upper, digit,
 * symbol}, and not containing the email's local part.
 *
 * `pg` and the password hasher are resolved from backend/, so this also runs
 * inside the production backend image (whose root node_modules has no pg).
 */
import { createRequire } from 'node:module';
import readline from 'node:readline';

const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));
const { Pool } = backendRequire('pg');
const { ScryptPasswordHasher } = await import(
  new URL('../backend/dist/modules/identity/crypto/password-hasher.js', import.meta.url)
);

const [, , emailArg, legacyPassword] = process.argv;
if (!emailArg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg.trim())) {
  console.error('usage: node scripts/create-platform-admin.mjs <email>   (password via PLATFORM_ADMIN_PASSWORD or prompt)');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL (the owner-role connection string) is not set.');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function readPassword() {
  if (process.env.PLATFORM_ADMIN_PASSWORD) return process.env.PLATFORM_ADMIN_PASSWORD;
  if (legacyPassword) {
    console.warn('warning: password given on the command line; prefer PLATFORM_ADMIN_PASSWORD or the prompt.');
    return legacyPassword;
  }
  if (!process.stdin.isTTY) {
    console.error('No PLATFORM_ADMIN_PASSWORD and no terminal to prompt on.');
    process.exit(1);
  }
  const first = await promptHidden('New platform-admin password: ');
  const second = await promptHidden('Repeat password: ');
  if (first !== second) {
    console.error('The passwords do not match.');
    process.exit(1);
  }
  return first;
}

function passwordProblem(password) {
  if (password.length < 14) return 'must be at least 14 characters';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'must use at least 3 of: lowercase, uppercase, digits, symbols';
  const local = email.split('@')[0];
  if (local.length >= 3 && password.toLowerCase().includes(local)) return 'must not contain the email name';
  return null;
}

const password = await readPassword();
const problem = passwordProblem(password);
if (problem) {
  console.error(`Password rejected: ${problem}.`);
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
    [email, passwordHash],
  );
  console.log('Platform admin ready:', rows[0]);
} finally {
  await pool.end();
}
