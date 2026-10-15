import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CliInputError,
  normalizeWorkspaceUrl,
  parseStdinJson,
  runAddSourceAction,
  runPairAction,
  runRemoveAction,
  __test,
} from './cli-pair';
import { loadConfigFile } from './config-file';
import { hasDeenrollRequest, readPendingEnrollment } from './pending-enrollment';
import { readPendingSources } from './sources-file';
import type { GatewaySourceConfig } from './connectors/registry';

const CODE = 'Abc123_-xyzXYZ0987654321abcdefghijklmnopqrs';

function freshEnv(): { env: NodeJS.ProcessEnv; configDir: string; stateDir: string; cleanup: () => void } {
  const configDir = mkdtempSync(path.join(tmpdir(), 'dpdp-cli-cfg-'));
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dpdp-cli-state-'));
  return {
    env: { GATEWAY_CONFIG_PATH: path.join(configDir, 'config.json'), GATEWAY_STATE_DIR: stateDir },
    configDir,
    stateDir,
    cleanup: () => {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

describe('normalizeWorkspaceUrl — production HTTPS is enforced in the agent, not only in the UI', () => {
  it('accepts https and reduces it to the origin', () => {
    expect(normalizeWorkspaceUrl('https://acme.dpdp.example.com/x?y=1#z')).toBe('https://acme.dpdp.example.com');
  });
  it('rejects plain http for a non-loopback host', () => {
    expect(() => normalizeWorkspaceUrl('http://acme.dpdp.example.com')).toThrow(CliInputError);
  });
  it('allows http only for localhost / 127.0.0.1 / [::1]', () => {
    expect(normalizeWorkspaceUrl('http://localhost:3001')).toBe('http://localhost:3001');
    expect(normalizeWorkspaceUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(normalizeWorkspaceUrl('http://[::1]:3001')).toBe('http://[::1]:3001');
  });
  it('rejects other schemes and URLs carrying credentials', () => {
    expect(() => normalizeWorkspaceUrl('ftp://acme.example.com')).toThrow(CliInputError);
    expect(() => normalizeWorkspaceUrl('https://user:pw@acme.example.com')).toThrow(/credentials/);
    expect(() => normalizeWorkspaceUrl('not a url')).toThrow(CliInputError);
  });
});

describe('pair input parsing', () => {
  it('accepts a well-formed code and trims the display name', () => {
    expect(__test.parsePairInput({ enrollmentCode: CODE, controlPlaneUrl: 'https://x.example', displayName: '  PC  ' })).toEqual({
      enrollmentCode: CODE,
      controlPlaneUrl: 'https://x.example',
      displayName: 'PC',
    });
  });
  it('rejects a code with characters outside the backend token alphabet', () => {
    expect(() => __test.parsePairInput({ enrollmentCode: "x'; rm -rf /", controlPlaneUrl: 'https://x.example' })).toThrow(/malformed/);
  });
  it('error messages never echo the submitted code', () => {
    try {
      __test.parsePairInput({ enrollmentCode: 'SECRET!!value', controlPlaneUrl: 'https://x.example' });
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

describe('parseStdinJson', () => {
  it('tolerates a UTF-8 BOM at either end (Windows StreamWriter/PowerShell artefact)', () => {
    expect(parseStdinJson('﻿{"a":1}﻿')).toEqual({ a: 1 });
  });

  it('rejects input over 64 KiB and non-JSON input', () => {
    expect(() => parseStdinJson('x'.repeat(64 * 1024 + 1))).toThrow(/too large/);
    expect(() => parseStdinJson('{oops')).toThrow(/valid JSON/);
  });
});

describe('runPairAction', () => {
  let ctx: ReturnType<typeof freshEnv>;
  beforeEach(() => (ctx = freshEnv()));
  afterEach(() => ctx.cleanup());

  it('writes the workspace origin to config.json and the code to pending-enrollment.json only', () => {
    runPairAction({ enrollmentCode: CODE, controlPlaneUrl: 'https://acme.example.com/path' }, ctx.env, 'linux');
    expect(loadConfigFile(path.join(ctx.configDir, 'config.json'))).toEqual({ controlPlaneUrl: 'https://acme.example.com' });
    expect(readPendingEnrollment(ctx.stateDir)).toEqual({ enrollmentCode: CODE });
    expect(readFileSync(path.join(ctx.configDir, 'config.json'), 'utf8')).not.toContain(CODE);
  });

  it('refuses to pair over an existing device credential (Remove Gateway first)', () => {
    writeFileSync(path.join(ctx.stateDir, 'device-credential.json'), '{"dpapi":"00"}');
    expect(() => runPairAction({ enrollmentCode: CODE, controlPlaneUrl: 'https://acme.example.com' }, ctx.env, 'linux')).toThrow(/already paired/);
    expect(readPendingEnrollment(ctx.stateDir)).toBeNull();
  });

  it('rejects http for a production host and writes nothing', () => {
    expect(() => runPairAction({ enrollmentCode: CODE, controlPlaneUrl: 'http://acme.example.com' }, ctx.env, 'linux')).toThrow();
    expect(existsSync(path.join(ctx.configDir, 'config.json'))).toBe(false);
    expect(readPendingEnrollment(ctx.stateDir)).toBeNull();
  });
});

describe('runAddSourceAction — queues for the service; never touches sources.json', () => {
  let ctx: ReturnType<typeof freshEnv>;
  beforeEach(() => (ctx = freshEnv()));
  afterEach(() => ctx.cleanup());
  const SOURCE: GatewaySourceConfig = {
    sourceId: 'crm',
    kind: 'postgresql',
    connection: { host: 'db.internal', port: 5432, user: 'ro', password: 'pw-1', database: 'crm' },
  };

  it('writes pending-sources.json and leaves sources.json alone', () => {
    expect(runAddSourceAction(SOURCE, ctx.env, 'linux')).toEqual({ pendingCount: 1 });
    expect(readPendingSources(ctx.stateDir)).toEqual([SOURCE]);
    expect(existsSync(path.join(ctx.stateDir, 'sources.json'))).toBe(false);
  });

  it('re-adding the same sourceId replaces the queued entry', () => {
    runAddSourceAction(SOURCE, ctx.env, 'linux');
    runAddSourceAction({ ...SOURCE, connection: { ...SOURCE.connection!, password: 'pw-2' } }, ctx.env, 'linux');
    expect(readPendingSources(ctx.stateDir)).toHaveLength(1);
    expect(readPendingSources(ctx.stateDir)![0]!.connection?.password).toBe('pw-2');
  });

  it('rejects an invalid source', () => {
    expect(() => runAddSourceAction({ sourceId: 'x' } as unknown as GatewaySourceConfig, ctx.env, 'linux')).toThrow();
    expect(readPendingSources(ctx.stateDir)).toBeNull();
  });
});

describe('runRemoveAction — a request to the service, not a local de-enrolment', () => {
  let ctx: ReturnType<typeof freshEnv>;
  beforeEach(() => (ctx = freshEnv()));
  afterEach(() => ctx.cleanup());

  it('writes the de-enrol marker and drops any unredeemed pairing code', () => {
    runPairAction({ enrollmentCode: CODE, controlPlaneUrl: 'https://acme.example.com' }, ctx.env, 'linux');
    runRemoveAction(ctx.env, 'linux');
    expect(hasDeenrollRequest(ctx.stateDir)).toBe(true);
    expect(readPendingEnrollment(ctx.stateDir)).toBeNull();
  });
});

describe('cli-pair as a real process (compiled dist/cli-pair.js)', () => {
  const cli = path.join(__dirname, '..', 'dist', 'cli-pair.js');
  const built = existsSync(cli);
  const itBuilt = built ? it : it.skip;
  let ctx: ReturnType<typeof freshEnv>;
  beforeEach(() => (ctx = freshEnv()));
  afterEach(() => ctx.cleanup());

  itBuilt('the compiled CLI is not older than its source (never silently test a stale build)', () => {
    const stale = statSync(cli).mtimeMs < statSync(path.join(__dirname, 'cli-pair.ts')).mtimeMs;
    expect({ stale, fix: 'run: pnpm --filter @dpdp/agent build' }).toEqual({ stale: false, fix: 'run: pnpm --filter @dpdp/agent build' });
  });

  itBuilt('refuses argv-supplied secrets: "pair" without --stdin fails and writes nothing', () => {
    const r = spawnSync(process.execPath, [cli, 'pair', '--code', CODE], { env: { ...process.env, ...ctx.env }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ ok: false });
    expect(readPendingEnrollment(ctx.stateDir)).toBeNull();
  });

  itBuilt('reads the pairing input from stdin and reports success as JSON', () => {
    const input = JSON.stringify({ enrollmentCode: CODE, controlPlaneUrl: 'https://acme.example.com' });
    const r = spawnSync(process.execPath, [cli, 'pair', '--stdin'], { input, env: { ...process.env, ...ctx.env }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true });
    expect(readPendingEnrollment(ctx.stateDir)).toEqual({ enrollmentCode: CODE });
    expect(r.stdout + r.stderr).not.toContain(CODE);
  });

  itBuilt('a failure never echoes the submitted secret', () => {
    const input = JSON.stringify({ sourceId: 123, kind: 'postgresql', connection: { password: 'pw-LEAKCHECK' } });
    const r = spawnSync(process.execPath, [cli, 'add-source', '--stdin'], { input, env: { ...process.env, ...ctx.env }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain('LEAKCHECK');
  });
});
