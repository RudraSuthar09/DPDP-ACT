import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocalRootConfig, resolveLocalStorageRoot } from './local-root';

describe('local-root', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'dpdp-agent-localroot-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to AGENT_LOCAL_STORAGE_ROOT when no electron config path is set', () => {
    const config = loadLocalRootConfig({ AGENT_LOCAL_STORAGE_ROOT: 'D:\\Enterprise testing old' });
    expect(resolveLocalStorageRoot(config)).toBe('D:\\Enterprise testing old');
  });

  it('returns null when nothing is configured', () => {
    expect(resolveLocalStorageRoot(loadLocalRootConfig({}))).toBeNull();
  });

  it('prefers a valid Electron config file over the fallback', () => {
    const configPath = path.join(dir, 'enterprise-storage.json');
    writeFileSync(configPath, JSON.stringify({ enterpriseStorage: { rootPath: 'D:\\From Electron' } }));
    const config = loadLocalRootConfig({
      ELECTRON_STORAGE_CONFIG_PATH: configPath,
      AGENT_LOCAL_STORAGE_ROOT: 'D:\\Fallback',
    });
    expect(resolveLocalStorageRoot(config)).toBe('D:\\From Electron');
  });

  it('falls back when the Electron config file does not exist yet', () => {
    const config = loadLocalRootConfig({
      ELECTRON_STORAGE_CONFIG_PATH: path.join(dir, 'missing.json'),
      AGENT_LOCAL_STORAGE_ROOT: 'D:\\Fallback',
    });
    expect(resolveLocalStorageRoot(config)).toBe('D:\\Fallback');
  });

  it('rejects a bare relative rootPath from a corrupt/pre-fix Electron config', () => {
    const configPath = path.join(dir, 'enterprise-storage.json');
    writeFileSync(configPath, JSON.stringify({ enterpriseStorage: { rootPath: 'Enterprise testing' } }));
    const config = loadLocalRootConfig({ ELECTRON_STORAGE_CONFIG_PATH: configPath });
    expect(resolveLocalStorageRoot(config)).toBeNull();
  });
});
