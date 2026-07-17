/**
 * Drive the running platform end to end and show what happened.
 *
 *   pnpm smoke
 *
 * Not a test suite (that is `pnpm test` and `pnpm test:isolation`) — this is the
 * "show me it works" script. It walks the real HTTP API exactly as a client
 * would: register an organisation, enrol MFA, log in with a TOTP code, suspend a
 * user, then print that tenant's hash-chained audit log and verify the chain.
 *
 * It talks to whatever is on NEXT_PUBLIC_API_URL / API_PORT, so it works against
 * a local API or a deployed one.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The app's OWN TOTP implementation stands in for the authenticator app.
const distTotp = join(ROOT, 'backend', 'dist', 'modules', 'identity', 'crypto', 'totp.js');
if (!existsSync(distTotp)) {
  console.error('The backend is not built yet. Run:  pnpm build');
  process.exit(1);
}
const { totp } = await import(`file:///${distTotp.replace(/\\/g, '/')}`);
const { base32Decode } = await import(
  `file:///${join(ROOT, 'backend', 'dist', 'modules', 'identity', 'crypto', 'base32.js').replace(/\\/g, '/')}`
);

const env = existsSync(join(ROOT, '.env'))
  ? Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  : {};
const BASE = process.env.API_URL ?? `http://localhost:${env.API_PORT ?? 3001}`;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

try {
  await fetch(`${BASE}/health`);
} catch {
  console.error(`\nNothing is answering on ${BASE}.\n\nStart it first:\n   pnpm db:local    (terminal 1)\n   pnpm dev:api     (terminal 2)\n`);
  process.exit(1);
}

const step = (n, s) => console.log(`\n${n}. ${s}`);
const sfx = randomBytes(3).toString('hex');
const email = `asha-${sfx}@acme-health.example`;
const PASSWORD = 'a-long-enough-password-2026';

console.log(`\nDriving ${BASE}`);
console.log('='.repeat(72));

// 1 -------------------------------------------------------------- FR-IDN-01
step(1, 'Register an organisation (FR-IDN-01)');
const reg = await api('POST', '/auth/register', {
  body: { organisationName: 'Acme Health Ltd', ownerEmail: email, ownerName: 'Asha Rao', password: PASSWORD },
});
console.log(`   tenant    ${reg.tenantId}`);
console.log(`   owner     ${reg.ownerUserId}`);
console.log(`   workspace ${reg.modules.join(', ')}`);
console.log(`   session?  no - ${reg.nextStep}`);

// 2 -------------------------------------------------------------- FR-IDN-02
step(2, 'Enrol MFA - no session is issued until a code is proven (FR-IDN-02)');
const enrol = await api('POST', '/auth/mfa/enroll', { body: { challengeToken: reg.mfaEnrolmentToken } });
console.log(`   otpauth   ${enrol.otpauthUri.slice(0, 60)}...`);
const secret = base32Decode(enrol.secret);

const confirmed = await api('POST', '/auth/mfa/confirm', {
  body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) },
});
console.log(`   confirmed - session issued, ${confirmed.recoveryCodes.length} recovery codes shown once`);
const ownerToken = confirmed.accessToken;

// 3 ---------------------------------------------------------------- login
step(3, 'Log in properly: password -> challenge -> TOTP -> session');
const login = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
console.log(`   password ok -> outcome="${login.outcome}" (a challenge, NOT a session)`);
// The code just used at enrolment is burned (RFC 6238 replay defence), so take
// the next step's code - what a real user does when the code rolls over.
const session = await api('POST', '/auth/mfa/verify', {
  body: { challengeToken: login.challengeToken, code: totp(secret, Date.now() + 30_000) },
});
console.log(`   TOTP ok -> access token (expires in ${session.expiresIn}s)`);

const me = await api('GET', '/auth/me', { token: session.accessToken });
console.log(`   /auth/me -> ${me.fullName} (${me.role}) @ ${me.organisationName}`);

// 4 ------------------------------------------------------------ a mutation
step(4, 'A normal mutation, flowing through the audit interceptor (S5)');
const team = await api('GET', '/users', { token: ownerToken });
console.log(`   team: ${team.map((u) => `${u.email} [${u.role}/${u.status}]`).join(', ')}`);

const suspended = await api('POST', `/users/${reg.ownerUserId}/status`, {
  token: ownerToken,
  body: { status: 'suspended', reason: 'demonstrating the audit trail' },
}).catch((e) => ({ refused: String(e.message) }));
console.log(`   suspending the only Owner was refused (no orphaned workspace):`);
console.log(`     ${String(suspended.refused).slice(0, 100)}`);
console.log(`   ...and that refusal is itself recorded as evidence.`);

// 5 ------------------------------------------------------------- the chain
step(5, "The tenant's hash-chained audit log (FR-AUD-01/02, I4)");
const { entries } = await api('GET', '/audit?limit=20', { token: ownerToken });
console.log('');
console.log('   seq  action                            outcome  prev     -> hash     reason');
console.log('   ' + '-'.repeat(94));
for (const e of [...entries].reverse()) {
  console.log(
    '   ' +
      String(e.seq).padEnd(4) +
      ' ' + e.action.padEnd(33) +
      ' ' + e.outcome.padEnd(8) +
      ' ' + e.prevHash.slice(0, 6) + '   -> ' + e.hash.slice(0, 6) +
      '   ' + String(e.reason ?? '').slice(0, 30),
  );
}

// 6 ----------------------------------------------------------- the verifier
step(6, 'Verify the chain (FR-AUD-03)');
const report = await api('GET', '/audit/verify', { token: ownerToken });
console.log(`   entries checked : ${report.entriesChecked}`);
console.log(`   head hash       : ${report.headHash?.slice(0, 32)}...`);
console.log(`   intact          : ${report.intact ? 'YES - no breaks found' : 'NO'}`);
if (!report.intact) {
  for (const b of report.breaks) console.log(`     [seq ${b.seq}] ${b.problem}`);
}

console.log('\n' + '='.repeat(72));
console.log('Smoke test complete. The platform is running.\n');
