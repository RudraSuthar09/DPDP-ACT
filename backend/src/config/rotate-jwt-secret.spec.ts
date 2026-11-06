import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * scripts/rotate-jwt-secret.mjs — run as a real process against a temporary
 * .env. Never against the repository's own .env.
 */
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'rotate-jwt-secret.mjs');

function run(file: string, ...args: string[]): { out: string; code: number } {
  try {
    return {
      out: execFileSync(process.execPath, [SCRIPT, file, ...args], { encoding: 'utf8' }),
      code: 0,
    };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { out: e.stdout ?? '', code: e.status ?? -1 };
  }
}

function envFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dpdp-rotate-'));
  const file = join(dir, '.env');
  writeFileSync(file, content);
  return file;
}

const BEFORE = [
  '# comment',
  'NODE_ENV=development',
  'JWT_SECRET=change_me_dev_jwt_secret',
  'MFA_ISSUER=DPDP Platform',
  '',
].join('\r\n');

describe('rotate-jwt-secret', () => {
  it('replaces ONLY the JWT_SECRET line with 64 random hex characters, preserving CRLF and every other line', () => {
    const file = envFile(BEFORE);
    const { out, code } = run(file);
    expect(code).toBe(0);
    const after = readFileSync(file, 'utf8');
    const lines = after.split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('# comment');
    expect(lines[1]).toBe('NODE_ENV=development');
    expect(lines[2]).toMatch(/^JWT_SECRET=[0-9a-f]{64}$/);
    expect(lines[3]).toBe('MFA_ISSUER=DPDP Platform');
    // The new secret is never printed.
    expect(out).not.toContain(lines[2]!.slice('JWT_SECRET='.length));
    expect(out).toMatch(/rotated .*not shown/);
  });

  it('two rotations give two different secrets', () => {
    const file = envFile(BEFORE);
    run(file);
    const first = readFileSync(file, 'utf8');
    run(file);
    expect(readFileSync(file, 'utf8')).not.toBe(first);
  });

  it('adds the line when it is missing', () => {
    const file = envFile('NODE_ENV=development\n');
    run(file);
    expect(readFileSync(file, 'utf8')).toMatch(/\nJWT_SECRET=[0-9a-f]{64}$/);
  });

  it('--check flags the published example as unsafe (exit 1) and a rotated secret as fine (exit 0), without printing either', () => {
    const file = envFile(BEFORE);
    const bad = run(file, '--check');
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/UNSAFE \(a published example value\)/);
    expect(bad.out).not.toContain('change_me_dev_jwt_secret');
    run(file);
    const good = run(file, '--check');
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/looks like a real secret \(64 characters\)/);
  });

  it('refuses to invent a file that does not exist', () => {
    expect(run(join(tmpdir(), 'definitely-missing-dpdp.env')).code).toBe(2);
  });
});
