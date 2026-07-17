/**
 * "Why won't it run?" - answered in one command.
 *
 *   pnpm doctor
 *
 * Every check here exists because it actually went wrong once. The failures this
 * catches all present as the same unhelpful stack trace (ETIMEDOUT, 28P01,
 * 'relation "users" does not exist'), and each has a completely different cause
 * and fix. This prints the cause and the fix.
 */
import pg from 'pg';
import dns from 'node:dns/promises';
import net from 'node:net';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const note = (title, detail, fix) => problems.push({ title, detail, fix });

const ok = (m) => console.log(`  [ ok ] ${m}`);
const bad = (m) => console.log(`  [FAIL] ${m}`);
const warn = (m) => console.log(`  [warn] ${m}`);

console.log('\nDPDP platform doctor\n' + '='.repeat(60));

// --- 1. .env ---------------------------------------------------------------
console.log('\n1. Environment');
const envPath = join(ROOT, '.env');
if (!existsSync(envPath)) {
  bad('.env is missing');
  note('.env is missing', 'The app reads the repo-root .env.', 'cp .env.example .env');
  report();
}
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
ok('.env found');

for (const key of ['DATABASE_URL', 'APP_DATABASE_URL', 'JWT_SECRET', 'MFA_SECRET_ENC_KEY']) {
  if (!env[key]) {
    bad(`${key} is not set`);
    note(`${key} is not set`, 'The API refuses to boot without it.', `Add ${key} to .env (see .env.example)`);
  }
}

// The MFA key is a hard boot requirement and a length mistake is silent until
// someone tries to enrol.
if (env.MFA_SECRET_ENC_KEY) {
  const len = Buffer.from(env.MFA_SECRET_ENC_KEY, 'base64').length;
  len === 32
    ? ok('MFA_SECRET_ENC_KEY is 32 bytes')
    : (bad(`MFA_SECRET_ENC_KEY decodes to ${len} bytes, must be 32`),
      note(
        'MFA_SECRET_ENC_KEY is the wrong length',
        `AES-256 needs exactly 32 bytes; yours is ${len}.`,
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      ));
}

// --- 2. Connection strings -------------------------------------------------
console.log('\n2. Connection strings');
const targets = [];
for (const key of ['DATABASE_URL', 'APP_DATABASE_URL']) {
  const url = env[key];
  if (!url) continue;
  const client = new pg.Client({ connectionString: url });
  const expectedRole = key === 'DATABASE_URL' ? 'dpdp_owner' : 'dpdp_app';
  targets.push({ key, url, host: client.host, port: client.port, user: client.user, db: client.database, expectedRole });

  // An unencoded @ / : / / in a password is legal-looking and parses to the
  // wrong thing in some tools even though node-postgres tolerates it.
  const after = url.split('://')[1] ?? '';
  const userinfo = after.slice(0, after.lastIndexOf('@'));
  const pw = userinfo.slice(userinfo.indexOf(':') + 1);
  const reserved = [...new Set([...pw].filter((c) => '@:/?#[]'.includes(c)))];
  if (reserved.length) {
    warn(`${key}: password contains ${reserved.join(' ')} - percent-encode it (@ -> %40)`);
    note(
      `${key} password contains reserved URI characters`,
      `Found ${reserved.join(' ')} in the password. node-postgres copes, but other tools split on it and you get a confusing "wrong password" or "unknown host".`,
      'Percent-encode it (@ becomes %40, : becomes %3A) or use a password without them.',
    );
  } else {
    ok(`${key}: parses cleanly (user=${client.user} host=${client.host} db=${client.database})`);
  }
}

// --- 3. Network ------------------------------------------------------------
console.log('\n3. Network');
for (const host of [...new Set(targets.map((t) => t.host))]) {
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  let v4 = [];
  let v6 = [];
  if (!isLocal) {
    try { v4 = await dns.resolve4(host); } catch { /* none */ }
    try { v6 = await dns.resolve6(host); } catch { /* none */ }

    // The Supabase trap: db.<ref>.supabase.co is IPv6-only. If the network has
    // no working IPv6 route it times out forever with no useful message.
    if (!v4.length && v6.length) {
      warn(`${host} has NO IPv4, only IPv6`);
      if (/^db\..*\.supabase\.co$/.test(host)) {
        note(
          `${host} is IPv6-only and many networks cannot reach it`,
          "Supabase's direct connection host has no IPv4 address. If your ISP or PC has no working IPv6 route, every connection times out (ETIMEDOUT).",
          'Use the Supabase POOLER instead (it has IPv4): Dashboard -> Project Settings -> Database -> Connection string -> "Session pooler". The username becomes dpdp_app.<project-ref>.',
        );
      }
    } else if (v4.length) {
      ok(`${host} resolves to IPv4 ${v4[0]}`);
    }
  }

  const port = targets.find((t) => t.host === host).port;
  const reach = await new Promise((res) => {
    const s = net.createConnection({ host, port, timeout: 6000 });
    s.on('connect', () => { s.destroy(); res('reachable'); });
    s.on('timeout', () => { s.destroy(); res('timeout'); });
    s.on('error', (e) => res(e.code ?? 'error'));
  });
  if (reach === 'reachable') {
    ok(`${host}:${port} is reachable`);
  } else {
    bad(`${host}:${port} -> ${reach}`);
    note(
      `Cannot reach ${host}:${port} (${reach})`,
      isLocal
        ? 'Nothing is listening locally on that port.'
        : 'The database host did not accept a TCP connection.',
      isLocal
        ? 'Start the local database in another terminal:  pnpm db:local'
        : 'Check the host/port, your network, and any firewall. If this is Supabase, see the pooler advice above.',
    );
  }
}

// --- 4. Login + roles ------------------------------------------------------
console.log('\n4. Database login');
let ownerClient = null;
for (const t of targets) {
  const c = new pg.Client({
    connectionString: t.url,
    connectionTimeoutMillis: 10000,
    ...(t.host === 'localhost' ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  try {
    await c.connect();
    ok(`${t.key}: logged in as ${t.user}`);
    if (t.key === 'DATABASE_URL') ownerClient = c;
    else {
      // The precondition the whole isolation guarantee rests on.
      const { rows } = await c.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) {
        bad(`${t.user} is superuser/BYPASSRLS - RLS would be silently bypassed`);
        note(
          `The app role ${t.user} can bypass RLS`,
          'Postgres ignores RLS policies for superusers and BYPASSRLS roles. Tenant isolation (I3) would not be enforced, and nothing would error.',
          `ALTER ROLE ${t.user} NOSUPERUSER NOBYPASSRLS;`,
        );
      } else {
        ok(`${t.user} is NOSUPERUSER + NOBYPASSRLS (RLS will be enforced)`);
      }
      await c.end();
    }
  } catch (e) {
    bad(`${t.key}: ${e.code ?? ''} ${e.message}`);
    if (e.code === '28P01') {
      note(
        `Password rejected for "${t.user}" (${t.key})`,
        `The server was reached and refused the password. Note the two roles have DIFFERENT passwords: ${t.key === 'APP_DATABASE_URL' ? 'the other one working does not mean this one does.' : ''}`,
        t.host === 'localhost'
          ? 'Recreate the local database:  pnpm db:local:reset'
          : `Reset it as an admin (Supabase SQL editor, as postgres):\n         ALTER ROLE ${t.user} WITH PASSWORD '<new-strong-password>';\n       then put the same value in .env (percent-encode any @ as %40).`,
      );
    } else if (e.code === 'ETIMEDOUT' || /timeout/i.test(e.message)) {
      note(
        `Timed out connecting for ${t.key}`,
        'The host never answered.',
        t.host === 'localhost' ? 'pnpm db:local' : 'See the IPv6/pooler advice above.',
      );
    }
  }
}

// --- 5. Migrations ---------------------------------------------------------
console.log('\n5. Migrations');
if (ownerClient) {
  const files = readdirSync(join(ROOT, 'backend', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  let applied = [];
  try {
    applied = (await ownerClient.query('SELECT name FROM pgmigrations ORDER BY id')).rows.map((r) => r.name);
  } catch {
    warn('no pgmigrations table - nothing has been migrated yet');
  }
  const missing = files.filter((f) => !applied.some((a) => f.startsWith(a)));
  for (const f of files) {
    applied.some((a) => f.startsWith(a)) ? ok(`applied  ${f}`) : bad(`MISSING  ${f}`);
  }
  if (missing.length) {
    note(
      `${missing.length} migration(s) not applied`,
      `Missing: ${missing.join(', ')}. The API will fail with 'relation "users" does not exist' or similar.`,
      'pnpm migrate:up',
    );
  }
  await ownerClient.end();
} else {
  warn('skipped - could not connect as the owner role');
}

report();

function report() {
  console.log('\n' + '='.repeat(60));
  if (!problems.length) {
    console.log('\nNo problems found. Start it with:\n');
    console.log('   pnpm dev:api     # http://localhost:3001');
    console.log('   pnpm smoke       # drive it end to end\n');
    process.exit(0);
  }
  console.log(`\n${problems.length} problem(s) found:\n`);
  problems.forEach((p, i) => {
    console.log(`${i + 1}. ${p.title}`);
    console.log(`   why:  ${p.detail}`);
    console.log(`   fix:  ${p.fix}\n`);
  });
  process.exit(1);
}
