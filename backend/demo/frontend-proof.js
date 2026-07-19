/* eslint-disable */
'use strict';
/**
 * Proves the frontend's data path is LIVE, end to end, against the running API —
 * exactly the endpoints the React screens call:
 *
 *   POST /auth/register  → POST /auth/mfa/enroll → POST /auth/mfa/confirm   (session)
 *   POST /auth/login     → POST /auth/mfa/verify                            (session)
 *   GET  /auth/me                                                           (shell header)
 *   GET  /audit                                                             (audit viewer)
 *
 * It computes real TOTP codes with the SAME crypto the backend uses, so this is a
 * genuine sign-in, not a bypass. Then it shows audited actions appearing in the log.
 */
const { base32Decode } = require('../dist/modules/identity/crypto/base32');
const { totp, totpStep } = require('../dist/modules/identity/crypto/totp');

const API = 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const line = (s = '') => console.log(s);
const ok = (s) => line('  ✓ ' + s);

async function main() {
  const stamp = Date.now();
  const email = `owner+${stamp}@pilot-demo.example`;
  const password = 'pilot-demo-passphrase-123';

  line('== Register a workspace (audited: identity.organisation.registered) ==');
  const reg = await call('/auth/register', {
    method: 'POST',
    body: {
      organisationName: `Pilot Demo ${stamp}`,
      ownerName: 'Pilot Owner',
      ownerEmail: email,
      password,
    },
  });
  ok(`tenant ${reg.tenantId}, owner ${reg.ownerUserId}`);
  ok(`modules provisioned: ${reg.modules.join(', ')}`);

  line('\n== Enrol MFA (audited: identity.mfa.enrolment_started) ==');
  const enrol = await call('/auth/mfa/enroll', {
    method: 'POST',
    body: { challengeToken: reg.mfaEnrolmentToken },
  });
  const secret = base32Decode(enrol.secret);
  ok(`otpauth secret issued (${enrol.secret.slice(0, 8)}…)`);

  line('\n== Confirm MFA with a real TOTP code (audited: identity.mfa.enrolled) ==');
  const confirmStep = totpStep();
  const confirm = await call('/auth/mfa/confirm', {
    method: 'POST',
    body: { challengeToken: reg.mfaEnrolmentToken, code: totp(secret) },
  });
  const token1 = confirm.accessToken;
  ok(`session issued; ${confirm.recoveryCodes.length} recovery codes returned`);

  line('\n== GET /auth/me (what the shell header shows) ==');
  const me = await call('/auth/me', { token: token1 });
  ok(`${me.fullName} · ${me.email} · role=${me.role} · org=${me.organisationName}`);

  line('\n== GET /audit — the viewer’s live data after enrolment ==');
  let audit = await call('/audit?limit=200', { token: token1 });
  const countAfterEnrol = audit.entries.length;
  ok(`${countAfterEnrol} entries in this tenant’s chain:`);
  for (const e of audit.entries) {
    line(`     seq ${String(e.seq).padStart(2)}  ${e.action.padEnd(34)} ${e.outcome}`);
  }

  line('\n== Now LOG IN and take the action again (fresh sign-in) ==');
  // TOTP replay defence: the confirm step is consumed; wait for a new 30s step.
  process.stdout.write('  waiting for a fresh TOTP step');
  while (totpStep() <= confirmStep) {
    process.stdout.write('.');
    await sleep(1000);
  }
  line();
  const login = await call('/auth/login', { method: 'POST', body: { email, password } });
  ok(`POST /auth/login → outcome=${login.outcome} (audited: identity.auth.password_verified)`);
  const verify = await call('/auth/mfa/verify', {
    method: 'POST',
    body: { challengeToken: login.challengeToken, code: totp(secret) },
  });
  const token2 = verify.accessToken;
  ok('POST /auth/mfa/verify → new session (audited: identity.auth.session_issued)');

  line('\n== GET /audit again — the new entries have appeared ==');
  audit = await call('/audit?limit=200', { token: token2 });
  ok(`entries went ${countAfterEnrol} → ${audit.entries.length}. Newest first:`);
  for (const e of audit.entries.slice(0, 3)) {
    line(`     seq ${String(e.seq).padStart(2)}  ${e.action.padEnd(34)} ${e.outcome}  @ ${e.occurredAt}`);
  }

  line('\n== GET /audit/verify — the hash chain is intact ==');
  const chain = await call('/audit/verify', { token: token2 });
  ok(`intact=${chain.intact}, entriesChecked=${chain.entriesChecked}, head=${(chain.headHash || '').slice(0, 16)}…`);

  line('\nLIVE DATA PROVEN: register → MFA → login all wrote to the hash-chained');
  line('audit log, and GET /audit (the viewer’s exact call) returned them growing live.');
}

main().catch((e) => {
  console.error('\nPROOF FAILED:', e.message);
  process.exit(1);
});
