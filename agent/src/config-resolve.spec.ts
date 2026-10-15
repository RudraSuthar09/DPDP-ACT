import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAgentConfig } from './config-resolve';
import { AgentConfigError } from './config';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-config-resolve-test-'));
}

describe('resolveAgentConfig — the one integration point between config.ts, config-file.ts and config-paths.ts', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('with no config file and no GATEWAY_STATE_DIR, falls back to the OS-conventional state dir, not config.ts\'s own ~/.dpdp-gateway default', () => {
    const configFilePath = path.join(dir, 'missing-config.json');
    const resolved = resolveAgentConfig({ GATEWAY_CONFIG_PATH: configFilePath }, 'linux');
    expect(resolved.fileConfig).toBeNull();
    expect(resolved.configFilePath).toBe(configFilePath);
    expect(resolved.config.stateDir).toContain('dpdp-gateway');
    expect(resolved.config.stateDir).not.toContain('.dpdp-gateway');
  });

  it('an explicit GATEWAY_STATE_DIR always wins over the OS default', () => {
    const configFilePath = path.join(dir, 'missing-config.json');
    const resolved = resolveAgentConfig(
      { GATEWAY_CONFIG_PATH: configFilePath, GATEWAY_STATE_DIR: '/custom/state' },
      'linux',
    );
    expect(resolved.config.stateDir).toBe('/custom/state');
  });

  it('loads real settings from a config file when present', () => {
    const configFilePath = path.join(dir, 'config.json');
    writeFileSync(
      configFilePath,
      JSON.stringify({
        controlPlaneUrl: 'https://dpdp.example.com',
        displayName: 'Finance workstation',
        logLevel: 'debug',
      }),
    );
    const resolved = resolveAgentConfig({ GATEWAY_CONFIG_PATH: configFilePath }, 'linux');
    expect(resolved.config.controlPlaneUrl).toBe('https://dpdp.example.com');
    expect(resolved.config.displayName).toBe('Finance workstation');
    expect(resolved.logLevel).toBe('debug');
  });

  it('an explicit env var wins over the same field in the file', () => {
    const configFilePath = path.join(dir, 'config.json');
    writeFileSync(configFilePath, JSON.stringify({ controlPlaneUrl: 'https://file.example.com' }));
    const resolved = resolveAgentConfig(
      { GATEWAY_CONFIG_PATH: configFilePath, GATEWAY_CONTROL_PLANE_URL: 'https://env.example.com' },
      'linux',
    );
    expect(resolved.config.controlPlaneUrl).toBe('https://env.example.com');
  });

  it('GATEWAY_CONFIG_PATH overrides where the config file is read from', () => {
    const customPath = path.join(dir, 'nested', 'elsewhere.json');
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ displayName: 'Wrong file' }));
    // customPath itself doesn't exist — proves the override is actually used,
    // not silently ignored in favor of the OS default location.
    const resolved = resolveAgentConfig({ GATEWAY_CONFIG_PATH: customPath }, 'linux');
    expect(resolved.configFilePath).toBe(customPath);
    expect(resolved.fileConfig).toBeNull();
  });

  it('logLevel is null when the file has none (even if the file exists)', () => {
    const configFilePath = path.join(dir, 'config.json');
    writeFileSync(configFilePath, JSON.stringify({ displayName: 'No log level here' }));
    const resolved = resolveAgentConfig({ GATEWAY_CONFIG_PATH: configFilePath }, 'linux');
    expect(resolved.logLevel).toBeNull();
  });

  it('an invalid config file still throws AgentConfigError, naming the exact path', () => {
    const configFilePath = path.join(dir, 'config.json');
    writeFileSync(configFilePath, '{ not valid json');
    expect(() => resolveAgentConfig({ GATEWAY_CONFIG_PATH: configFilePath }, 'linux')).toThrow(AgentConfigError);
  });
});
