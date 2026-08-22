import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayStorageProvider } from './gateway-storage-provider';

describe('GatewayStorageProvider — real fs, rooted at one configured local path', () => {
  let root: string;
  let provider: GatewayStorageProvider;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-storage-provider-'));
    provider = new GatewayStorageProvider(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('browse() on an empty root returns no entries', async () => {
    await expect(provider.browse([])).resolves.toEqual({ entries: [] });
  });

  it('createFolder() actually creates a real directory on disk', async () => {
    await expect(provider.createFolder([], 'Customers')).resolves.toEqual({ created: true });
    expect(existsSync(join(root, 'Customers'))).toBe(true);
  });

  it('browse() after createFolder() reflects the real directory (round trip)', async () => {
    await provider.createFolder([], 'Customers');
    await expect(provider.browse([])).resolves.toEqual({ entries: [{ name: 'Customers' }] });
  });

  it('nested createFolder() + browse() at each level', async () => {
    await provider.createFolder([], 'Customers');
    await provider.createFolder(['Customers'], 'Consent');
    await expect(provider.browse(['Customers'])).resolves.toEqual({ entries: [{ name: 'Consent' }] });
    expect(existsSync(join(root, 'Customers', 'Consent'))).toBe(true);
  });

  it('verifyFolder() is true for a real folder and false for a nonexistent one', async () => {
    await provider.createFolder([], 'Customers');
    await expect(provider.verifyFolder(['Customers'])).resolves.toEqual({ exists: true });
    await expect(provider.verifyFolder(['NoSuchFolder'])).resolves.toEqual({ exists: false });
  });

  it('createFolder() into a nonexistent parent fails (never silently creates the whole chain)', async () => {
    await expect(provider.createFolder(['NoSuchParent'], 'Child')).rejects.toThrow();
    expect(existsSync(join(root, 'NoSuchParent'))).toBe(false);
  });

  it('browse()/createFolder() reject a traversal attempt', async () => {
    await expect(provider.browse(['..'])).rejects.toThrow();
    await expect(provider.createFolder(['..'], 'evil')).rejects.toThrow();
  });

  it('healthCheck() reports ok with an agent version, never a path', async () => {
    const health = await provider.healthCheck();
    expect(health.status).toBe('ok');
    expect(JSON.stringify(health)).not.toContain(root);
  });
});
