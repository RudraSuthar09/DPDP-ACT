import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDpapiPlatform } from './dpapi';
import { loadProxyCredentials, PROXY_CREDENTIALS_FILE_NAME, ProxyCredentialsError } from './proxy-credentials';
import { createDpapiSecretProtector, type SecretProtector } from './sources-file';

const PW = 'Pr0xy-PW-never-on-disk';

/** MOCK protector (reversible, NOT encryption): exercises the file format and
 *  migration logic only. Real DPAPI is covered separately below. */
function mockProtector(scheme = 'mock'): SecretProtector {
  return {
    scheme,
    protect: (p) => Buffer.from(p, 'utf8').toString('hex').split('').reverse().join(''),
    unprotect: (d) => Buffer.from(d.split('').reverse().join(''), 'hex').toString('utf8'),
  };
}

describe('proxy-credentials.json', () => {
  let dir: string;
  const file = (): string => path.join(dir, PROXY_CREDENTIALS_FILE_NAME);
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'dpdp-proxycred-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ProxyCredentialsError);
      expect((e as Error).message).not.toContain(PW);
      return (e as ProxyCredentialsError).code;
    }
    throw new Error('expected an error');
  };

  it('a missing file means no credentials', () => {
    expect(loadProxyCredentials(dir, mockProtector())).toEqual({ credentials: null, migrated: false });
  });

  it('migrates the plain form to the protected form (mock protector), atomically, leaving no temp files', () => {
    writeFileSync(file(), JSON.stringify({ username: 'svc', password: PW }));
    const first = loadProxyCredentials(dir, mockProtector());
    expect(first).toEqual({ credentials: { username: 'svc', password: PW }, migrated: true });
    const raw = readFileSync(file(), 'utf8');
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain('svc');
    expect(JSON.parse(raw)).toMatchObject({ format: 'dpdp-gateway-proxy-credentials', version: 2, protected: { scheme: 'mock', v: 1 } });
    expect(readdirSync(dir)).toEqual([PROXY_CREDENTIALS_FILE_NAME]);
    expect(loadProxyCredentials(dir, mockProtector())).toEqual({ credentials: { username: 'svc', password: PW }, migrated: false });
  });

  it('accepts the UTF-8 BOM that Windows PowerShell 5.1 Set-Content writes', () => {
    writeFileSync(file(), `\uFEFF${JSON.stringify({ username: 'svc', password: PW })}`);
    expect(loadProxyCredentials(dir, mockProtector()).credentials?.password).toBe(PW);
  });

  it('without a protector (non-Windows dev), reads the plain form and leaves it as is', () => {
    writeFileSync(file(), JSON.stringify({ username: 'svc', password: PW }));
    expect(loadProxyCredentials(dir, null)).toEqual({ credentials: { username: 'svc', password: PW }, migrated: false });
    expect(readFileSync(file(), 'utf8')).toContain(PW);
  });

  it('fails safe with a code, never echoing the secret', () => {
    writeFileSync(file(), '{not json');
    expect(codeOf(() => loadProxyCredentials(dir, mockProtector()))).toBe('CORRUPT');

    writeFileSync(file(), JSON.stringify({ username: 'a:b', password: PW }));
    expect(codeOf(() => loadProxyCredentials(dir, mockProtector()))).toBe('CORRUPT');

    writeFileSync(file(), JSON.stringify({ format: 'dpdp-gateway-proxy-credentials', version: 3, protected: {} }));
    expect(codeOf(() => loadProxyCredentials(dir, mockProtector()))).toBe('UNSUPPORTED_VERSION');

    writeFileSync(file(), JSON.stringify({ username: 'svc', password: PW }));
    loadProxyCredentials(dir, mockProtector('scheme-a'));
    expect(codeOf(() => loadProxyCredentials(dir, mockProtector('scheme-b')))).toBe('PROTECTION_UNAVAILABLE');
    expect(codeOf(() => loadProxyCredentials(dir, null))).toBe('PROTECTION_UNAVAILABLE');

    const failing: SecretProtector = { ...mockProtector('scheme-a'), unprotect: () => { throw new Error('boom'); } };
    expect(codeOf(() => loadProxyCredentials(dir, failing))).toBe('UNDECRYPTABLE');
  });

  it('does not destroy the plain file if protection fails', () => {
    writeFileSync(file(), JSON.stringify({ username: 'svc', password: PW }));
    const broken: SecretProtector = { ...mockProtector(), protect: () => { throw new Error('dpapi down'); } };
    expect(codeOf(() => loadProxyCredentials(dir, broken))).toBe('PROTECTION_UNAVAILABLE');
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ username: 'svc', password: PW });
  });

  const dpapiIt = isDpapiPlatform() ? it : it.skip;
  dpapiIt(
    'REAL Windows DPAPI (current user, not the service account): round-trips and keeps the password off disk',
    () => {
      writeFileSync(file(), JSON.stringify({ username: 'svc', password: PW }));
      const protector = createDpapiSecretProtector();
      expect(loadProxyCredentials(dir, protector)).toMatchObject({ migrated: true });
      expect(readFileSync(file(), 'utf8')).not.toContain(PW);
      expect(loadProxyCredentials(dir, protector)).toEqual({ credentials: { username: 'svc', password: PW }, migrated: false });
    },
    180_000,
  );
});
