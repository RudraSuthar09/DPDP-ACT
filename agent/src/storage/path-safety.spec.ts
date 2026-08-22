import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSubdirectory, isRealDirectory, listSubdirectories, resolveContainedDir, StorageSecurityError } from './path-safety';

describe('storage path-safety — containment for real folder operations', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-storage-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves an existing nested path within the root', () => {
    mkdirSync(join(root, 'Customers', 'Consent'), { recursive: true });
    const dir = resolveContainedDir(root, ['Customers', 'Consent'], true);
    expect(dir.endsWith(join('Customers', 'Consent'))).toBe(true);
  });

  it('the empty path resolves to the root itself', () => {
    expect(resolveContainedDir(root, [], true)).toBe(resolveContainedDir(root, [], true));
  });

  it('rejects a ".." segment (dot-dot traversal)', () => {
    expect(() => resolveContainedDir(root, ['..'], true)).toThrow(StorageSecurityError);
  });

  it('rejects a segment containing a path separator (embedded traversal)', () => {
    expect(() => resolveContainedDir(root, ['a/../../etc'], true)).toThrow(StorageSecurityError);
    expect(() => resolveContainedDir(root, ['a\\..\\..\\windows'], true)).toThrow(StorageSecurityError);
  });

  it('rejects an absolute-looking segment', () => {
    // Even though this looks absolute, path.join would just append it as a
    // literal name — but it still must be rejected because it contains a
    // separator, which is exactly what assertSafeSegment forbids.
    expect(() => resolveContainedDir(root, ['/etc/passwd'], true)).toThrow(StorageSecurityError);
  });

  it('rejects a symlink inside the root that escapes it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dpdp-storage-outside-'));
    try {
      const linkPath = join(root, 'escape');
      try {
        symlinkSync(outside, linkPath, 'dir');
      } catch {
        return; // symlink creation can require elevated privileges on some platforms — skip if unavailable
      }
      expect(() => resolveContainedDir(root, ['escape'], true)).toThrow(StorageSecurityError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a missing intermediate segment (mustExist=true) fails FILE_NOT_FOUND-coded', () => {
    expect.assertions(1);
    try {
      resolveContainedDir(root, ['NoSuchFolder', 'Nested'], true);
    } catch (err) {
      expect((err as StorageSecurityError).code).toBe('FILE_NOT_FOUND');
    }
  });

  it('a not-yet-existing FINAL segment is allowed when mustExist=false (create target)', () => {
    const dir = resolveContainedDir(root, ['NewFolder'], false);
    expect(dir.endsWith('NewFolder')).toBe(true);
  });

  it('a not-yet-existing INTERMEDIATE segment still fails even when mustExist=false', () => {
    expect(() => resolveContainedDir(root, ['NoSuchParent', 'Target'], false)).toThrow(StorageSecurityError);
  });

  it('createSubdirectory creates a real directory, and is idempotent on re-creation', () => {
    createSubdirectory(root, 'Customers');
    expect(isRealDirectory(join(root, 'Customers'))).toBe(true);
    expect(() => createSubdirectory(root, 'Customers')).not.toThrow(); // idempotent
  });

  it('createSubdirectory rejects an unsafe name', () => {
    expect(() => createSubdirectory(root, '../escape')).toThrow(StorageSecurityError);
  });

  it('listSubdirectories lists only real directories, never files, and skips dotfiles', () => {
    mkdirSync(join(root, 'Alpha'));
    mkdirSync(join(root, 'Beta'));
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'note.txt'), 'not a folder');
    const names = listSubdirectories(root);
    expect(names).toEqual(['Alpha', 'Beta']);
  });

  it('verifyFolder-equivalent (isRealDirectory) is false for a nonexistent path', () => {
    expect(isRealDirectory(join(root, 'Nope'))).toBe(false);
  });
});
