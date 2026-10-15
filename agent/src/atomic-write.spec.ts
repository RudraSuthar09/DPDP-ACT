import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scrubAndRemove, writeFileAtomic } from './atomic-write';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'dpdp-atomic-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the file (and missing parent directories)', () => {
    const file = path.join(dir, 'a', 'b', 'x.json');
    writeFileAtomic(file, '{"v":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"v":1}');
  });

  it('replaces existing content completely and leaves no temp files', () => {
    const file = path.join(dir, 'x.json');
    writeFileAtomic(file, 'a much longer first version of the content');
    writeFileAtomic(file, 'short');
    expect(readFileSync(file, 'utf8')).toBe('short');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  it('on failure, leaves the previous file intact and no temp file behind', () => {
    const file = path.join(dir, 'x.json');
    writeFileAtomic(file, 'original');
    // Renaming a file onto an existing DIRECTORY fails on every platform.
    const blocked = path.join(dir, 'blocked');
    mkdirSync(blocked);
    writeFileSync(path.join(blocked, 'keep'), 'k');
    expect(() => writeFileAtomic(blocked, 'new')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('original');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('scrubAndRemove', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'dpdp-scrub-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('deletes the file', () => {
    const file = path.join(dir, 'pending.json');
    writeFileSync(file, 'secret-ish');
    scrubAndRemove(file);
    expect(existsSync(file)).toBe(false);
  });

  it('is a no-op for a missing file', () => {
    expect(() => scrubAndRemove(path.join(dir, 'missing.json'))).not.toThrow();
  });
});
