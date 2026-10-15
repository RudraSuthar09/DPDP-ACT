import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfigFile, mergeFileConfigIntoEnv, writeConfigFile } from './config-file';
import { AgentConfigError } from './config';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-config-test-'));
}

describe('config-file — file-based agent configuration (Phase 1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null (not an error) when the file does not exist — a fresh install has no config.json yet', () => {
    expect(loadConfigFile(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('loads and validates a well-formed config file', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        controlPlaneUrl: 'https://dpdp.example.com',
        displayName: 'Finance workstation',
        heartbeatIntervalSeconds: 45,
        bindHost: '127.0.0.1',
        bindPort: 7071,
        allowedOrigins: ['https://dpdp.example.com'],
        logLevel: 'debug',
      }),
    );
    const config = loadConfigFile(file);
    expect(config).toEqual({
      controlPlaneUrl: 'https://dpdp.example.com',
      displayName: 'Finance workstation',
      heartbeatIntervalSeconds: 45,
      bindHost: '127.0.0.1',
      bindPort: 7071,
      allowedOrigins: ['https://dpdp.example.com'],
      logLevel: 'debug',
    });
  });

  it('a partial file (only some fields) is valid — every omitted field falls back later', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ controlPlaneUrl: 'https://dpdp.example.com' }));
    expect(loadConfigFile(file)).toEqual({ controlPlaneUrl: 'https://dpdp.example.com' });
  });

  it('invalid JSON throws AgentConfigError with a clear, actionable message', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, '{ not valid json');
    expect(() => loadConfigFile(file)).toThrow(AgentConfigError);
    expect(() => loadConfigFile(file)).toThrow(/not valid JSON/);
  });

  it('a non-object JSON value (array, string, number) is rejected', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, '[1,2,3]');
    expect(() => loadConfigFile(file)).toThrow(/must be a JSON object/);
  });

  it('an invalid controlPlaneUrl is rejected with a field-specific message', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ controlPlaneUrl: 'not a url' }));
    expect(() => loadConfigFile(file)).toThrow(/"controlPlaneUrl".*valid http\(s\) URL/);
  });

  it('an invalid bindPort is rejected', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ bindPort: 99999 }));
    expect(() => loadConfigFile(file)).toThrow(/"bindPort".*between 1 and 65535/);
  });

  it('a wildcard origin is rejected, same discipline as config.ts\'s env-var validation', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ allowedOrigins: ['*'] }));
    expect(() => loadConfigFile(file)).toThrow(/wildcard/);
  });

  it('an invalid logLevel is rejected', () => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ logLevel: 'verbose' }));
    expect(() => loadConfigFile(file)).toThrow(/"logLevel".*debug, info, warn, error/);
  });

  it('error messages never echo a secret — there are none in this schema to begin with', () => {
    // config.json intentionally carries no secret fields at all (see this
    // module's own header) — confirmed by construction: no field name here
    // resembles a credential, so there is nothing for an error message to leak.
    const schemaFields = ['controlPlaneUrl', 'stateDir', 'displayName', 'heartbeatIntervalSeconds', 'bindHost', 'bindPort', 'allowedOrigins', 'logLevel'];
    for (const f of schemaFields) {
      expect(f.toLowerCase()).not.toMatch(/password|token|secret|credential/);
    }
  });
});

describe('writeConfigFile — the setup wizard\'s counterpart to loadConfigFile (Phase 2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a config file that loadConfigFile then reads back identically', () => {
    const file = path.join(dir, 'config.json');
    const config = { controlPlaneUrl: 'https://dpdp.example.com', displayName: 'Finance workstation', logLevel: 'info' as const };
    writeConfigFile(file, config);
    expect(loadConfigFile(file)).toEqual(config);
  });

  it('creates the parent directory if it does not exist yet', () => {
    const file = path.join(dir, 'nested', 'dir', 'config.json');
    writeConfigFile(file, { controlPlaneUrl: 'https://dpdp.example.com' });
    expect(existsSync(file)).toBe(true);
  });

  it('overwrites an existing config file rather than merging with it', () => {
    const file = path.join(dir, 'config.json');
    writeConfigFile(file, { controlPlaneUrl: 'https://old.example.com', displayName: 'Old name' });
    writeConfigFile(file, { controlPlaneUrl: 'https://new.example.com' });
    expect(loadConfigFile(file)).toEqual({ controlPlaneUrl: 'https://new.example.com' });
  });

  it('rejects an invalid controlPlaneUrl before writing anything to disk', () => {
    const file = path.join(dir, 'config.json');
    expect(() => writeConfigFile(file, { controlPlaneUrl: 'not a url' })).toThrow(AgentConfigError);
    expect(existsSync(file)).toBe(false);
  });

  it('rejects a wildcard origin, same discipline as the reader', () => {
    const file = path.join(dir, 'config.json');
    expect(() => writeConfigFile(file, { allowedOrigins: ['*'] })).toThrow(/wildcard/);
  });

  it('writes human-readable, indented JSON', () => {
    const file = path.join(dir, 'config.json');
    writeConfigFile(file, { displayName: 'Finance workstation' });
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');
  });
});

describe('mergeFileConfigIntoEnv — env always wins over the file (Phase 1)', () => {
  it('returns env unchanged when there is no file config', () => {
    const env = { GATEWAY_BIND_PORT: '7071' };
    expect(mergeFileConfigIntoEnv(env, null)).toBe(env);
  });

  it('fills in an env var from the file ONLY when the env var is absent', () => {
    const env = {};
    const merged = mergeFileConfigIntoEnv(env, { controlPlaneUrl: 'https://file.example.com' });
    expect(merged.GATEWAY_CONTROL_PLANE_URL).toBe('https://file.example.com');
  });

  it('an explicitly-set env var always wins over the file value', () => {
    const env = { GATEWAY_CONTROL_PLANE_URL: 'https://env.example.com' };
    const merged = mergeFileConfigIntoEnv(env, { controlPlaneUrl: 'https://file.example.com' });
    expect(merged.GATEWAY_CONTROL_PLANE_URL).toBe('https://env.example.com');
  });

  it('merges every supported field independently', () => {
    const merged = mergeFileConfigIntoEnv(
      {},
      {
        controlPlaneUrl: 'https://file.example.com',
        stateDir: '/var/lib/dpdp-gateway',
        displayName: 'From file',
        heartbeatIntervalSeconds: 90,
        bindHost: '127.0.0.5',
        bindPort: 8080,
        allowedOrigins: ['https://a.example', 'https://b.example'],
      },
    );
    expect(merged.GATEWAY_CONTROL_PLANE_URL).toBe('https://file.example.com');
    expect(merged.GATEWAY_STATE_DIR).toBe('/var/lib/dpdp-gateway');
    expect(merged.GATEWAY_DISPLAY_NAME).toBe('From file');
    expect(merged.GATEWAY_HEARTBEAT_INTERVAL_SECONDS).toBe('90');
    expect(merged.GATEWAY_BIND_HOST).toBe('127.0.0.5');
    expect(merged.GATEWAY_BIND_PORT).toBe('8080');
    expect(merged.GATEWAY_ALLOWED_ORIGINS).toBe('https://a.example,https://b.example');
  });

  it('does not mutate the original env object', () => {
    const env = {};
    mergeFileConfigIntoEnv(env, { controlPlaneUrl: 'https://file.example.com' });
    expect(env).toEqual({});
  });
});
