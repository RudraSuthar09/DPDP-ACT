#!/usr/bin/env node
/**
 * Rotate JWT_SECRET in a local .env — without ever printing it.
 *
 *   node scripts/rotate-jwt-secret.mjs            rotate ./.env
 *   node scripts/rotate-jwt-secret.mjs path/.env  rotate another file
 *   node scripts/rotate-jwt-secret.mjs --check    only say whether it is unsafe
 *
 * For LOCAL files (development, or an operator's machine). In production the
 * secret lives in a secrets manager — rotate it there (docs/aws-deployment.md).
 *
 * What it does: generates 32 random bytes (64 hex characters), replaces the
 * JWT_SECRET line — or adds one — and writes the file atomically. Every other
 * line, comment and line ending is left exactly as it was. The new value is
 * never printed, logged or written anywhere else.
 *
 * WHAT ROTATING BREAKS, by design (the old secret is what signed these):
 *   - every signed-in user is signed out (access tokens);
 *   - pending invitations stop working (resend them);
 *   - every ENROLLED GATEWAY's device token is rejected: each Gateway reports
 *     "credential revoked" and must be paired again;
 *   - in-flight MFA challenges and platform-admin sessions end.
 * Nothing stored in the database is affected — JWT_SECRET encrypts no data.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KNOWN_PLACEHOLDERS = new Set(['change_me_dev_jwt_secret']);
const MARKERS = ['change_me', 'local_dev_only', 'replace_me', 'REPLACE_ME'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const file = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.env');

if (!existsSync(file)) {
  console.error(`No file at ${file}. Copy .env.example to .env first.`);
  process.exit(2);
}

const original = readFileSync(file, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);
const index = lines.findIndex((l) => /^\s*JWT_SECRET\s*=/.test(l));
const current =
  index >= 0
    ? lines[index]
        .replace(/^\s*JWT_SECRET\s*=\s*/, '')
        .replace(/^["']|["']$/g, '')
        .trim()
    : '';
const isExample = KNOWN_PLACEHOLDERS.has(current) || MARKERS.some((m) => current.includes(m));
// Most important reason first: a published value is unsafe however long it is.
const reason =
  current === ''
    ? 'missing'
    : isExample
      ? 'a published example value'
      : current.length < 32
        ? 'too short'
        : null;

if (checkOnly) {
  console.log(
    reason
      ? `JWT_SECRET in ${path.basename(file)} is UNSAFE (${reason}). Rotate it.`
      : `JWT_SECRET in ${path.basename(file)} looks like a real secret (${current.length} characters).`,
  );
  process.exit(reason ? 1 : 0);
}

const secret = randomBytes(32).toString('hex');
const line = `JWT_SECRET=${secret}`;
if (index >= 0) lines[index] = line;
else lines.push(line);

// Atomic: a crash mid-write can never leave a half-written .env.
const temp = `${file}.rotating-${process.pid}`;
writeFileSync(temp, lines.join(eol), { encoding: 'utf8', mode: 0o600 });
renameSync(temp, file);

console.log(
  `JWT_SECRET ${index >= 0 ? 'rotated' : 'added'} in ${path.basename(file)} (64 random hex characters; not shown).`,
);
console.log(
  'Next: restart the API. Users sign in again; enrolled Gateways must be paired again; resend pending invitations.',
);
