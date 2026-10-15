import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireSingleInstanceLock, SingleInstanceError } from './single-instance';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-single-instance-test-'));
}

describe('acquireSingleInstanceLock — prevents unintended duplicate agent instances', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires the lock on a fresh state directory and creates the lock file', () => {
    const lock = acquireSingleInstanceLock(dir);
    expect(existsSync(path.join(dir, 'agent.lock'))).toBe(true);
    lock.release();
  });

  it('records this process\'s own PID in the lock file', () => {
    const lock = acquireSingleInstanceLock(dir);
    const recorded = JSON.parse(readFileSync(path.join(dir, 'agent.lock'), 'utf8')) as { pid: number };
    expect(recorded.pid).toBe(process.pid);
    lock.release();
  });

  it('refuses a second acquisition while the first lock is still held, naming the live holder PID', () => {
    const lock = acquireSingleInstanceLock(dir);
    expect(() => acquireSingleInstanceLock(dir)).toThrow(SingleInstanceError);
    try {
      acquireSingleInstanceLock(dir);
    } catch (err) {
      expect((err as SingleInstanceError).holderPid).toBe(process.pid);
    }
    lock.release();
  });

  it('release() removes the lock file, allowing a fresh acquisition afterward', () => {
    const lock = acquireSingleInstanceLock(dir);
    lock.release();
    expect(existsSync(path.join(dir, 'agent.lock'))).toBe(false);
    const second = acquireSingleInstanceLock(dir);
    second.release();
  });

  it('release() is idempotent — calling it twice does not throw', () => {
    const lock = acquireSingleInstanceLock(dir);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it('recovers automatically from a stale lock left by a PID that is no longer running', () => {
    // A PID essentially guaranteed not to exist on a real machine (PIDs this
    // high are never assigned) — simulates a crash that left the lock behind.
    writeFileSync(path.join(dir, 'agent.lock'), JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }));
    const lock = acquireSingleInstanceLock(dir);
    const recorded = JSON.parse(readFileSync(path.join(dir, 'agent.lock'), 'utf8')) as { pid: number };
    expect(recorded.pid).toBe(process.pid);
    lock.release();
  });

  it('recovers from a corrupt/unreadable lock file rather than refusing to start forever', () => {
    writeFileSync(path.join(dir, 'agent.lock'), '{ not valid json');
    const lock = acquireSingleInstanceLock(dir);
    expect(JSON.parse(readFileSync(path.join(dir, 'agent.lock'), 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('creates the state directory if it does not exist yet', () => {
    const nested = path.join(dir, 'nested', 'state');
    const lock = acquireSingleInstanceLock(nested);
    expect(existsSync(path.join(nested, 'agent.lock'))).toBe(true);
    lock.release();
  });

  it('release() never removes a lock file that a DIFFERENT process now legitimately holds', () => {
    const lock = acquireSingleInstanceLock(dir);
    // Simulate: the lock file now (somehow) reflects a different holder —
    // release() must be conservative and leave it alone.
    writeFileSync(path.join(dir, 'agent.lock'), JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() }));
    lock.release();
    expect(existsSync(path.join(dir, 'agent.lock'))).toBe(true);
  });
});
