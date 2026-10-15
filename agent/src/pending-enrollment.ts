/**
 * The file-based hand-off between the Gateway Setup wizard (gateway-app/,
 * Phase 2 of the production build-out) and this already-running agent
 * process. It is the SMALLEST backward-compatible extension of the
 * EXISTING enrollment mechanism (enrollment.ts's `ensureEnrolled`, which
 * already accepts an `enrollmentCode` — previously sourced only from the
 * `GATEWAY_ENROLLMENT_CODE` env var via config.ts) — not a second
 * enrollment protocol, not a new HTTP route, not a new IPC channel.
 *
 * Flow: the wizard collects the one-time enrolment code a tenant admin
 * copied from the DPDP dashboard ("Connect Enterprise Gateway"), writes it
 * here, then restarts the Windows service (via the Service Control
 * Manager — see gateway-installer/service). On the next start, index.ts
 * prefers this file's code over any env/config value, calls the EXISTING
 * `ensureEnrolled()` unchanged, and — on success — deletes this file so a
 * spent code never lingers on disk (mirrors the backend's own single-use
 * consumption of the same code).
 *
 * Lives in the STATE directory (never config.json / the CONFIG directory):
 * an enrolment code is short-lived (the backend's own TTL, ~15 minutes by
 * default) but IS a bearer secret for that window — whoever has it can
 * enrol a device for the tenant — so it gets the same restrictive-
 * permissions discipline as device-credential.json, not config.json's
 * "ordinary settings only" treatment.
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { scrubAndRemove, writeFileAtomic } from './atomic-write';

export interface PendingEnrollment {
  enrollmentCode: string;
  /** Optional — lets the wizard set the display name shown in DPDP's
   *  Gateway device list without requiring a separate config.json write
   *  first. Falls back to config.ts's own default (os.hostname()) if
   *  omitted. */
  displayName?: string;
}

function pendingEnrollmentFilePath(stateDir: string): string {
  return path.join(stateDir, 'pending-enrollment.json');
}

/** Returns null if no pending enrollment file exists — the normal case on
 *  every start after the first. Throws on a corrupt file rather than
 *  silently ignoring it (same discipline as loadPersistedCredential). */
export function readPendingEnrollment(stateDir: string): PendingEnrollment | null {
  const file = pendingEnrollmentFilePath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<PendingEnrollment>;
  if (typeof parsed.enrollmentCode !== 'string' || parsed.enrollmentCode.trim().length === 0) {
    throw new Error(`Corrupt pending-enrollment file at ${file} — delete it and re-run the Gateway setup wizard.`);
  }
  const result: PendingEnrollment = { enrollmentCode: parsed.enrollmentCode };
  if (typeof parsed.displayName === 'string' && parsed.displayName.trim()) result.displayName = parsed.displayName.trim();
  return result;
}

/** Called by cli-pair.ts under the Gateway Setup wizard's elevated helper,
 *  never by the long-running service itself. */
export function writePendingEnrollment(stateDir: string, pending: PendingEnrollment): void {
  writeFileAtomic(pendingEnrollmentFilePath(stateDir), JSON.stringify(pending, null, 2));
}

/** Called by the agent after a successful enrollment (or when a credential
 *  already exists — see index.ts), so a consumed or now-irrelevant code
 *  never lingers on disk. Never throws: cleanup must not fail startup. */
export function clearPendingEnrollment(stateDir: string): void {
  try {
    scrubAndRemove(pendingEnrollmentFilePath(stateDir));
  } catch {
    // Best-effort.
  }
}

// --- de-enrolment request ---------------------------------------------------
//
// The device credential is DPAPI-encrypted under the SERVICE's identity, so
// only the service can read the device token needed to call
// POST /gateway/deenroll. The elevated helper therefore never de-enrols
// itself: it drops this marker and restarts the service, which performs the
// de-enrolment under its own identity at startup (see index.ts).

function deenrollRequestFilePath(stateDir: string): string {
  return path.join(stateDir, 'pending-deenroll.json');
}

export function writeDeenrollRequest(stateDir: string): void {
  writeFileAtomic(deenrollRequestFilePath(stateDir), JSON.stringify({ requestedAt: new Date().toISOString() }));
}

export function hasDeenrollRequest(stateDir: string): boolean {
  try {
    readFileSync(deenrollRequestFilePath(stateDir));
    return true;
  } catch {
    return false;
  }
}

export function clearDeenrollRequest(stateDir: string): void {
  rmSync(deenrollRequestFilePath(stateDir), { force: true });
}
