/**
 * Atomic file replacement for the agent's state files (device credential,
 * encrypted sources). Writes a uniquely-named temp file IN THE SAME DIRECTORY
 * (so it inherits the directory's restrictive ACL and the final rename stays
 * on one volume), fsyncs it, then renames it over the target. A crash or
 * power loss leaves either the old file or the new one, never a truncated
 * mix, and the temp file is removed on any failure.
 *
 * The temp file gets the same directory ACL as the target, so callers must
 * only pass content that is acceptable under that ACL: the secret stores
 * pass ciphertext; the short-lived pending hand-off files (enrolment code,
 * new source entries) are plaintext and rely on the state directory's ACL.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const RENAME_ATTEMPTS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);

  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);

  // Windows: a virus scanner or indexer can hold the target open for a
  // moment, making the replace fail with EPERM/EBUSY. Retry briefly rather
  // than leave the old content in place.
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(50 * attempt);
    }
  }
}

/** Overwrite with zeros, flush, then delete. Best-effort: on SSDs and
 *  copy-on-write volumes the old blocks may survive; the directory ACL is
 *  the real protection. */
export function scrubAndRemove(filePath: string): void {
  try {
    const size = statSync(filePath).size;
    const fd = openSync(filePath, 'r+');
    try {
      if (size > 0) writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Fall through to deletion regardless.
  }
  rmSync(filePath, { force: true });
}
