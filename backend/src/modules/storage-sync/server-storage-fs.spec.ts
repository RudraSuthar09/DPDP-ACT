import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAbsoluteEnterprisePath, verifyServerPathWritable } from './server-storage-fs';

describe('isAbsoluteEnterprisePath', () => {
  it('rejects a bare relative folder name — the exact reproduced bug (a picked folder\'s handle.name on its own)', () => {
    expect(isAbsoluteEnterprisePath('DPDP-Enterprise-Test')).toBe(false);
  });

  it('rejects a relative path with subdirectories', () => {
    expect(isAbsoluteEnterprisePath('some/relative/path')).toBe(false);
    expect(isAbsoluteEnterprisePath('./relative')).toBe(false);
    expect(isAbsoluteEnterprisePath('../relative')).toBe(false);
  });

  it('accepts an absolute POSIX path', () => {
    expect(isAbsoluteEnterprisePath('/enterprise-storage')).toBe(true);
  });

  it('accepts an absolute Windows path', () => {
    expect(isAbsoluteEnterprisePath('D:\\CompanyData\\DPDP')).toBe(true);
    expect(isAbsoluteEnterprisePath('D:/CompanyData/DPDP')).toBe(true);
  });

  it('accepts a UNC path', () => {
    expect(isAbsoluteEnterprisePath('\\\\CompanyServer\\DPDP')).toBe(true);
  });
});

describe('verifyServerPathWritable', () => {
  it('returns false immediately for a non-absolute path, without ever attempting a filesystem write — this is what stops the reproduced bug from resolving inside the process\'s own working directory', async () => {
    // A relative path that WOULD resolve successfully if attempted (this
    // process's cwd is always writable in CI) — proving the false-positive
    // this guard exists to prevent, not just an unreachable-path case.
    await expect(verifyServerPathWritable('a-relative-name-that-would-otherwise-succeed')).resolves.toBe(false);
  });

  it('returns true for a real, writable absolute directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dpdp-verify-test-'));
    try {
      await expect(verifyServerPathWritable(dir)).resolves.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a path that does not and cannot exist', async () => {
    // A path under a location that does not exist and cannot be created
    // (a file, not a directory, in the middle of the path) — a genuine
    // unreachable-path case, distinct from the relative-path case above.
    const blocker = mkdtempSync(path.join(tmpdir(), 'dpdp-verify-blocker-'));
    const fs = await import('node:fs/promises');
    const blockerFile = path.join(blocker, 'blocker-file');
    await fs.writeFile(blockerFile, '');
    try {
      await expect(verifyServerPathWritable(path.join(blockerFile, 'sub'))).resolves.toBe(false);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });
});
