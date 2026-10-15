/**
 * Single-instance guard (Phase 2 of the production build-out — Windows
 * Service packaging). "Prevents unintended duplicate instances" without
 * relying solely on the OS: the Windows Service Control Manager already
 * refuses to start the SAME service twice, and two agents bound to the same
 * loopback port would collide on `listen()` anyway — but neither of those
 * catches the case this guard exists for: a developer (or a leftover dev
 * run) starting a second `node dist/index.js` by hand while the service
 * copy is already running, potentially against a DIFFERENT port/state dir
 * override where the listen() collision wouldn't happen at all.
 *
 * A lock FILE in the state directory (the one directory this process already
 * owns and writes to — see enrollment.ts) is the simplest mechanism that
 * needs no new OS primitive: `open(path, 'wx')` is atomic (fails with EEXIST
 * if the file already exists), so two processes racing to create it can
 * never both believe they won.
 *
 * Stale-lock recovery: if the recorded PID is no longer running (the agent
 * was killed, the machine lost power, the service crashed without a clean
 * shutdown), the lock is treated as abandoned and replaced — a stale lock
 * file must never require a human to delete it by hand before the service
 * can restart.
 */
import { openSync, writeSync, closeSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class SingleInstanceError extends Error {
  constructor(public readonly holderPid: number) {
    super(
      `Another DPDP Gateway agent process (PID ${holderPid}) is already running against this state ` +
        `directory. Stop it before starting a second one.`,
    );
    this.name = 'SingleInstanceError';
  }
}

export interface SingleInstanceLock {
  /** Idempotent — safe to call more than once (e.g. from a signal handler
   *  that races with normal shutdown). */
  release(): void;
}

function lockFilePath(stateDir: string): string {
  return path.join(stateDir, 'agent.lock');
}

/** True if a process with this PID currently exists. `process.kill(pid, 0)`
 *  sends no signal — Node (via libuv) implements it as a pure existence
 *  check on every platform, including Windows (OpenProcess under the hood),
 *  so this needs no platform-specific branch. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists but we can't signal it —
    // still "alive" (a different account's process, e.g. after a service
    // account change — treat as held, fail closed rather than clobber it).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolderPid(file: string): number | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    // Unreadable/corrupt lock file: treat as unknown holder, not "no lock" —
    // the caller's retry loop will attempt to remove and recreate it, same
    // as a confirmed-stale lock.
    return null;
  }
}

/**
 * Acquires the single-instance lock for `stateDir`, creating the directory
 * if needed. Throws `SingleInstanceError` if a live process already holds
 * it. Recovers automatically from a stale lock (holder PID no longer
 * running, or an unreadable/corrupt lock file) — bounded retries, since a
 * resolvable race (another process also cleaning up the same stale lock at
 * the same instant) must never become an infinite loop.
 */
export function acquireSingleInstanceLock(stateDir: string): SingleInstanceLock {
  mkdirSync(stateDir, { recursive: true });
  const file = lockFilePath(stateDir);
  const MAX_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const holderPid = readHolderPid(file);
      if (holderPid !== null && isProcessAlive(holderPid)) {
        throw new SingleInstanceError(holderPid);
      }
      // Stale (or unreadable) — remove and retry. If another process beats
      // us to the removal/recreation, our next openSync EEXIST/ENOENT just
      // loops again, bounded by MAX_ATTEMPTS.
      try {
        rmSync(file, { force: true });
      } catch {
        // Ignore — the retry's openSync will surface any real problem.
      }
      continue;
    }

    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        try {
          // Only remove it if it's still OUR lock — never delete a lock a
          // later process legitimately holds (e.g. this release() firing
          // late, after some other bug already let a second instance in).
          const currentHolder = readHolderPid(file);
          if (currentHolder === process.pid) rmSync(file, { force: true });
        } catch {
          // Best-effort — shutdown must not fail because lock cleanup did.
        }
      },
    };
  }

  throw new Error(`Could not acquire the Gateway single-instance lock at ${file} after ${MAX_ATTEMPTS} attempts.`);
}
