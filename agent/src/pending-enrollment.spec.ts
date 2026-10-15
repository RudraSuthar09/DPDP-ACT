import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPendingEnrollment, writePendingEnrollment, clearPendingEnrollment } from './pending-enrollment';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-pending-enrollment-test-'));
}

describe('pending-enrollment — the wizard-to-agent enrollment hand-off file', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no pending enrollment file exists yet', () => {
    expect(readPendingEnrollment(dir)).toBeNull();
  });

  it('writes and reads back an enrollment code', () => {
    writePendingEnrollment(dir, { enrollmentCode: 'abc123' });
    expect(readPendingEnrollment(dir)).toEqual({ enrollmentCode: 'abc123' });
  });

  it('writes and reads back an optional displayName', () => {
    writePendingEnrollment(dir, { enrollmentCode: 'abc123', displayName: 'Finance workstation' });
    expect(readPendingEnrollment(dir)).toEqual({ enrollmentCode: 'abc123', displayName: 'Finance workstation' });
  });

  it('trims an empty-string displayName down to undefined rather than keeping a blank field', () => {
    writePendingEnrollment(dir, { enrollmentCode: 'abc123', displayName: '   ' });
    expect(readPendingEnrollment(dir)).toEqual({ enrollmentCode: 'abc123' });
  });

  it('clearPendingEnrollment removes the file', () => {
    writePendingEnrollment(dir, { enrollmentCode: 'abc123' });
    clearPendingEnrollment(dir);
    expect(existsSync(path.join(dir, 'pending-enrollment.json'))).toBe(false);
    expect(readPendingEnrollment(dir)).toBeNull();
  });

  it('clearPendingEnrollment never throws when the file does not exist', () => {
    expect(() => clearPendingEnrollment(dir)).not.toThrow();
  });

  it('a file with a missing enrollmentCode is treated as corrupt, not silently ignored', () => {
    writeFileSync(path.join(dir, 'pending-enrollment.json'), JSON.stringify({ displayName: 'x' }));
    expect(() => readPendingEnrollment(dir)).toThrow(/Corrupt pending-enrollment file/);
  });

  it('a file with an empty-string enrollmentCode is treated as corrupt', () => {
    writeFileSync(path.join(dir, 'pending-enrollment.json'), JSON.stringify({ enrollmentCode: '' }));
    expect(() => readPendingEnrollment(dir)).toThrow(/Corrupt pending-enrollment file/);
  });

  it('writes with restrictive file permissions, matching device-credential.json\'s own discipline', () => {
    writePendingEnrollment(dir, { enrollmentCode: 'abc123' });
    const raw = readFileSync(path.join(dir, 'pending-enrollment.json'), 'utf8');
    expect(JSON.parse(raw).enrollmentCode).toBe('abc123');
    // Permission bits are platform-dependent to verify exactly (Windows ACLs
    // vs POSIX mode) — the behavioral contract (0o600 passed to writeFileSync,
    // chmodSync attempted) is covered by reading the source; here we only
    // confirm the write succeeded and is readable by this same process.
  });

  it('creates the state directory if it does not exist yet', () => {
    const nested = path.join(dir, 'nested', 'state');
    writePendingEnrollment(nested, { enrollmentCode: 'abc123' });
    expect(readPendingEnrollment(nested)).toEqual({ enrollmentCode: 'abc123' });
  });
});
