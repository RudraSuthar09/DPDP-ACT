// The secret-carrying hand-off between this (non-elevated) app and the
// elevated helper, plus validation of what goes into it. No Electron
// dependency, so it is tested directly (request-file.test.js).
//
// Why a file: a UAC-elevated process (Start-Process -Verb RunAs) cannot
// receive stdin from its caller, and command lines are visible to process
// listings and to Windows process-creation auditing. The request file is
// created exclusively ('wx') in the caller's own temp directory, whose ACL
// grants only the user, SYSTEM and Administrators -- the same principals who
// could read the secret anyway (the elevated helper may run as a different,
// consenting administrator). The helper scrubs and deletes it immediately
// after reading; this module deletes it again afterwards in case the helper
// never ran (UAC declined).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateWorkspaceUrl } = require('./workspace-url');

const DB_KINDS = new Set(['postgresql', 'mysql', 'sqlserver']);
const FILE_KINDS = new Set(['csv', 'excel', 'filesystem']);
const ENROLLMENT_CODE_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function createRequestFile(payload, dir = os.tmpdir()) {
  const id = crypto.randomBytes(16).toString('hex');
  const requestPath = path.join(dir, `dpdp-gw-request-${id}.json`);
  const resultPath = path.join(dir, `dpdp-gw-result-${id}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { requestPath, resultPath };
}

function scrubAndDelete(file) {
  try {
    const size = fs.statSync(file).size;
    if (size > 0) fs.writeFileSync(file, Buffer.alloc(size, 0));
  } catch {
    // Missing already (the helper consumed it) or unreadable: just delete.
  }
  fs.rmSync(file, { force: true });
}

/** Reads and deletes the helper's result file. Returns null if the helper
 *  never wrote one (it did not run, or failed before validating the request). */
function consumeResult(resultPath) {
  let raw;
  try {
    raw = fs.readFileSync(resultPath, 'utf8');
  } catch {
    return null;
  } finally {
    fs.rmSync(resultPath, { force: true });
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return { ok: parsed.ok === true, error: typeof parsed.error === 'string' ? parsed.error.slice(0, 500) : null };
  } catch {
    return null;
  }
}

/** -> { ok:true, payload } | { ok:false, reason } */
function validatePairPayload(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'Invalid pairing request.' };
  const code = typeof input.enrollmentCode === 'string' ? input.enrollmentCode.trim() : '';
  if (!ENROLLMENT_CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'That enrolment code does not look right. Copy it again from the DPDP dashboard.' };
  }
  const url = validateWorkspaceUrl(input.controlPlaneUrl);
  if (!url.ok) return { ok: false, reason: url.reason };
  const payload = { enrollmentCode: code, controlPlaneUrl: url.url };
  if (typeof input.displayName === 'string' && input.displayName.trim()) {
    if (input.displayName.trim().length > 100) return { ok: false, reason: 'The device name is too long (max 100 characters).' };
    payload.displayName = input.displayName.trim();
  }
  return { ok: true, payload };
}

/** Builds a GatewaySourceConfig from form input, accepting only connector
 *  kinds the agent actually implements. */
function validateSourcePayload(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'Invalid source.' };
  const { kind, sourceId } = input;
  if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) {
    return { ok: false, reason: 'Source ID: letters, digits, ".", "_" or "-", starting with a letter or digit (max 64).' };
  }
  if (DB_KINDS.has(kind)) {
    const c = input.connection || {};
    const port = Number(c.port);
    if (typeof c.host !== 'string' || !c.host.trim() || /\s/.test(c.host.trim())) return { ok: false, reason: 'Enter the database host.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'Enter a port between 1 and 65535.' };
    if (typeof c.user !== 'string' || !c.user.trim()) return { ok: false, reason: 'Enter the database username.' };
    if (typeof c.database !== 'string' || !c.database.trim()) return { ok: false, reason: 'Enter the database name.' };
    const password = typeof c.password === 'string' ? c.password : '';
    if (password.length > 1024) return { ok: false, reason: 'The password is too long.' };
    return {
      ok: true,
      payload: { sourceId, kind, connection: { host: c.host.trim(), port, user: c.user.trim(), password, database: c.database.trim() } },
    };
  }
  if (FILE_KINDS.has(kind)) {
    const root = typeof input.root === 'string' ? input.root.trim() : '';
    if (!/^[A-Za-z]:\\/.test(root) && !/^\\\\[^\\]+\\[^\\]+/.test(root)) {
      return { ok: false, reason: 'Enter the full folder path, e.g. D:\\Exports or \\\\server\\share\\exports.' };
    }
    return { ok: true, payload: { sourceId, kind, roots: [root] } };
  }
  return { ok: false, reason: 'That source type is not supported by this Gateway.' };
}

module.exports = {
  DB_KINDS,
  FILE_KINDS,
  createRequestFile,
  scrubAndDelete,
  consumeResult,
  validatePairPayload,
  validateSourcePayload,
};
