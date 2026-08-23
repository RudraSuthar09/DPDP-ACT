import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browseDir, createFolder, isAbsolutePath, isSafeSegment, resolveContained, writeJsonFile, writeRawFile, writeTextFile } from './local-fs-ops';

describe('local-fs-ops (delivery agent write mechanism)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'dpdp-agent-fsops-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects traversal / separators / empties as segments', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'a\0b']) {
      expect(isSafeSegment(bad)).toBe(false);
    }
  });

  it('rejects a bare relative folder name as an absolute path', () => {
    expect(isAbsolutePath('Enterprise testing')).toBe(false);
    expect(isAbsolutePath('D:\\DPDP-Storage')).toBe(true);
    expect(isAbsolutePath('/enterprise-storage')).toBe(true);
  });

  it('writes Customer Information/profile.json + retention.json', async () => {
    const info = ['Customers', 'rudra', 'Customer Information'];
    await writeJsonFile(root, info, 'profile.json', { customerId: 'uuid-a', displayName: 'rudra' });
    await writeJsonFile(root, info, 'retention.json', { templateName: 'KYC', retentionMonths: 12 });
    const profile = JSON.parse(await readFile(path.join(root, ...info, 'profile.json'), 'utf8'));
    expect(profile.displayName).toBe('rudra');
  });

  it('writes a TEXT field as plain value.txt (not JSON)', async () => {
    const seg = ['Customers', 'rudra', 'Consent Register', 'KYC', 'Aadhaar'];
    await writeTextFile(root, seg, 'value.txt', '1234-5678-9012');
    const body = await readFile(path.join(root, ...seg, 'value.txt'), 'utf8');
    expect(body).toBe('1234-5678-9012');
  });

  it('writes a PDF upload with original bytes preserved', async () => {
    const seg = ['Customers', 'rudra', 'Consent Register', 'KYC', 'Aadhaar Card'];
    const pdfBytes = Buffer.from('%PDF-1.4 hello aadhaar', 'utf8');
    await writeRawFile(root, seg, 'aadhaar.pdf', pdfBytes);
    const written = await readFile(path.join(root, ...seg, 'aadhaar.pdf'));
    expect(written.equals(pdfBytes)).toBe(true);
  });

  it('browseDir lists customer folders and a second customer coexists', async () => {
    await createFolder(root, ['Customers'], 'rudra');
    await createFolder(root, ['Customers'], 'rahul');
    expect((await browseDir(root, ['Customers'])).sort()).toEqual(['rahul', 'rudra']);
  });

  it('throws PATH_NOT_ALLOWED on a traversal segment', async () => {
    await expect(writeTextFile(root, ['Customers', '..', '..'], 'evil.txt', 'x')).rejects.toThrow('PATH_NOT_ALLOWED');
  });

  it('resolveContained keeps every path under root', () => {
    const target = resolveContained(root, ['Customers', 'rudra']);
    expect(target.startsWith(path.resolve(root))).toBe(true);
  });
});
